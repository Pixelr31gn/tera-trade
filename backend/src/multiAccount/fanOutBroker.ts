/**
 * FanOutBroker -- a BrokerClient that wraps the master account's real broker
 * and mirrors every state-changing action to N remote accounts (one per PC).
 *
 * Design rules (see fanOutTypes.ts and CLAUDE.md):
 *  - The engine talks to this exactly like a normal broker; it never knows
 *    there are other accounts. Whatever the master broker returns is what the
 *    engine acts on (fills, stop management, trade records stay master-truth).
 *  - A remote account's failure NEVER changes the master result the engine
 *    sees -- it is logged loudly instead. The engine managing a divergent
 *    remote is a separate concern (alerting / dead-man switch, later stages).
 *  - Master and every remote run the SAME MirrorCommand through the SAME
 *    applyMirrorCommand mapping, so there is exactly one definition of "what
 *    this action does" (one-source-of-truth rule).
 *  - Read-only / decision methods delegate to the master only.
 *
 * This file is pure plumbing: it has no Chrome, no network, no DB. The remote
 * transport lives behind the RemoteExecutor interface so this stays unit
 * testable with fakes and so nothing here can place an order by itself.
 */
import type {
  BrokerAccount,
  BrokerClient,
  BrokerOrder,
  BrokerPosition,
  ClosedTradeHistoryEntry,
  HistoricalBar,
  OrderRequest,
  OrderResult,
} from "../brokers/types.js";
import { childLogger } from "../core/logger.js";
import type { MirrorCommand, RemoteExecutor, RemoteOutcome } from "./fanOutTypes.js";

const logger = childLogger("fanOutBroker");

/**
 * The single place that maps a MirrorCommand to a broker method. Used for the
 * master here and (in a later stage) inside each remote executor, so both ends
 * do byte-for-byte the same thing. Throws if the broker does not implement an
 * optional method the command needs -- the same failure a direct call would
 * hit, surfaced early rather than silently skipped.
 */
export async function applyMirrorCommand(broker: BrokerClient, cmd: MirrorCommand): Promise<OrderResult> {
  switch (cmd.kind) {
    case "placeOrder":
      return broker.placeOrder(cmd.request);
    case "requestClosePosition":
      return requireMethod(broker.requestClosePosition, broker, cmd.kind)(cmd.symbol);
    case "flattenPosition":
      return requireMethod(broker.flattenPosition, broker, cmd.kind)(cmd.symbol, cmd.side, cmd.quantity);
    case "placeTrailingStop":
      return requireMethod(broker.placeTrailingStop, broker, cmd.kind)(cmd.symbol, cmd.side, cmd.quantity, cmd.trailTicks);
    case "placeTakeProfitOrder":
      return requireMethod(broker.placeTakeProfitOrder, broker, cmd.kind)(cmd.symbol, cmd.side, cmd.quantity, cmd.limitPrice);
    case "cancelRestingOrder":
      return requireMethod(broker.cancelRestingOrder, broker, cmd.kind)(cmd.symbol);
    default: {
      // Exhaustiveness guard: a new MirrorCommand kind must be handled here.
      const _never: never = cmd;
      throw new Error(`unhandled MirrorCommand: ${JSON.stringify(_never)}`);
    }
  }
}

function requireMethod<T>(method: T | undefined, broker: BrokerClient, kind: string): T {
  if (!method) {
    throw new Error(`broker does not implement ${kind} -- cannot mirror this action`);
  }
  // Bind so `this` inside the broker method stays the broker.
  return (method as unknown as (...args: unknown[]) => unknown).bind(broker) as unknown as T;
}

export class FanOutBroker implements BrokerClient {
  // tail of each remote's command queue, keyed by executor name (see mirror())
  private readonly tails = new Map<string, Promise<RemoteOutcome>>();
  private readonly pendingLogs = new Set<Promise<void>>();

  constructor(
    private readonly master: BrokerClient,
    private readonly executors: readonly RemoteExecutor[],
  ) {}

  // ---- lifecycle: master drives; executors are their own services ----------
  connect(): Promise<void> {
    return this.master.connect();
  }
  disconnect(): Promise<void> {
    return this.master.disconnect();
  }

  // ---- reads / decisions: master only (never mirrored) ---------------------
  getAccounts(): Promise<BrokerAccount[]> {
    return this.master.getAccounts();
  }
  getPositions(accountId: string): Promise<BrokerPosition[]> {
    return this.master.getPositions(accountId);
  }
  getOpenOrders(accountId: string): Promise<BrokerOrder[]> {
    return this.master.getOpenOrders(accountId);
  }
  getHistoricalBars(symbol: string, start: Date, end: Date, unitMinutes?: number, limit?: number): Promise<HistoricalBar[]> {
    return this.master.getHistoricalBars(symbol, start, end, unitMinutes, limit);
  }
  cancelOrder(accountId: string, brokerOrderId: string): Promise<boolean> {
    return this.master.cancelOrder(accountId, brokerOrderId);
  }
  isPositionFlat(symbol: string): Promise<boolean | null> {
    return this.master.isPositionFlat ? this.master.isPositionFlat(symbol) : Promise.resolve(null);
  }
  readOpenPositionEntryPrice(symbol: string): Promise<import("decimal.js").Decimal | null> {
    return this.master.readOpenPositionEntryPrice ? this.master.readOpenPositionEntryPrice(symbol) : Promise.resolve(null);
  }
  readClosedTradeHistory(symbol: string): Promise<ClosedTradeHistoryEntry[] | null> {
    return this.master.readClosedTradeHistory ? this.master.readClosedTradeHistory(symbol) : Promise.resolve(null);
  }

  // ---- state-changing actions: master + fan out to every remote ------------
  placeOrder(request: OrderRequest): Promise<OrderResult> {
    return this.mirror({ kind: "placeOrder", request });
  }
  requestClosePosition(symbol: string): Promise<OrderResult> {
    return this.mirror({ kind: "requestClosePosition", symbol });
  }
  flattenPosition(symbol: string, side: "long" | "short", quantity: number): Promise<OrderResult> {
    return this.mirror({ kind: "flattenPosition", symbol, side, quantity });
  }
  placeTrailingStop(symbol: string, side: "long" | "short", quantity: number, trailTicks: number): Promise<OrderResult> {
    return this.mirror({ kind: "placeTrailingStop", symbol, side, quantity, trailTicks });
  }
  placeTakeProfitOrder(symbol: string, side: "long" | "short", quantity: number, limitPrice: import("decimal.js").Decimal): Promise<OrderResult> {
    return this.mirror({ kind: "placeTakeProfitOrder", symbol, side, quantity, limitPrice });
  }
  cancelRestingOrder(symbol: string): Promise<OrderResult> {
    return this.mirror({ kind: "cancelRestingOrder", symbol });
  }

  /**
   * Run a command on the master and, concurrently, on every remote. Remote
   * dispatches are started first (so they run as simultaneously as the network
   * allows -- the whole point is the same trade on every account at once),
   * then the master runs; its result is awaited and returned so the engine
   * sees exactly the master broker's own behaviour, including a throw.
   */
  private async mirror(cmd: MirrorCommand): Promise<OrderResult> {
    // Per-remote FIFO queue: the master serializes ticket actions in call order
    // (BrowserControlBroker's ticketChain), so each remote must apply commands in
    // that same order -- otherwise a contract switch ("close MNQ", then "open MES")
    // could land reversed on a remote, the exact interleaving behind the
    // 2026-10-06 wrong-symbol incident. One queue per remote, so a slow account
    // never delays another account. A failed command never blocks the ones behind
    // it (each outcome promise below always resolves).
    const remoteOutcomes: Promise<RemoteOutcome>[] = this.executors.map((e) => {
      const previous = this.tails.get(e.name) ?? Promise.resolve();
      const outcome: Promise<RemoteOutcome> = previous.then(() =>
        e.dispatch(cmd).then(
          (result): RemoteOutcome => ({ name: e.name, result }),
          (err): RemoteOutcome => ({ name: e.name, error: String(err) }),
        ),
      );
      this.tails.set(e.name, outcome);
      return outcome;
    });

    // Master runs with the same timing; a master throw propagates unchanged
    // (matches a direct broker call -- the engine's existing contract).
    const masterResult = await applyMirrorCommand(this.master, cmd);

    // The engine gets the master's result immediately -- it never waits on a slow
    // or hung remote (up to the client's timeout). Remote outcomes are logged
    // when they arrive; settle() lets tests (and shutdown) wait for them.
    const logged = Promise.all(remoteOutcomes).then((outcomes) => this.logOutcomes(cmd, masterResult, outcomes));
    this.pendingLogs.add(logged);
    void logged.finally(() => this.pendingLogs.delete(logged));
    return masterResult;
  }

  /** Resolves once every queued remote command has finished and been logged. */
  async settle(): Promise<void> {
    await Promise.all([...this.pendingLogs]);
  }

  private logOutcomes(cmd: MirrorCommand, masterResult: OrderResult, outcomes: RemoteOutcome[]): void {
    for (const o of outcomes) {
      if (o.error !== undefined) {
        logger.error({ action: cmd.kind, executor: o.name, err: o.error }, "mirror_executor_dispatch_failed");
      } else if (o.result && o.result.status === "rejected") {
        logger.error({ action: cmd.kind, executor: o.name, error: o.result.error }, "mirror_executor_rejected");
      } else if (o.result && o.result.status !== masterResult.status) {
        logger.warn(
          { action: cmd.kind, executor: o.name, masterStatus: masterResult.status, remoteStatus: o.result.status },
          "mirror_status_divergence",
        );
      } else {
        logger.info({ action: cmd.kind, executor: o.name, status: o.result?.status }, "mirror_executor_ok");
      }
    }
  }
}
