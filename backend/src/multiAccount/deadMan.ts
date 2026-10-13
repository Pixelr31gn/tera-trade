/**
 * Dead-man switch for a remote executor.
 *
 * The master's FanOutBroker sends a heartbeat to every executor every few
 * seconds. If an executor that HAS been receiving them goes quiet for
 * `timeoutMs`, the master is presumed dead (crashed, network down, backend
 * stopped) and nothing is managing that account's stops anymore -- so the
 * executor flattens itself. See browserControlBroker.ts's header: a position's
 * protection lives in the engine, so an orphaned remote position is unprotected.
 *
 * Deliberate behaviours:
 *  - Not armed until the first heartbeat: an executor nobody has contacted yet
 *    (just started, controller not running) never flattens anything.
 *  - Trips once per outage. After a trip it disarms; the next heartbeat re-arms.
 *  - A deliberate controller shutdown with a position open trips it too. That is
 *    intended: with the engine down, no account has a stop.
 *  - Never throws into the timer: trip errors are logged loudly instead.
 */
import type { BrokerClient } from "../brokers/types.js";
import { childLogger } from "../core/logger.js";
import { applyMirrorCommand } from "./fanOutBroker.js";

const logger = childLogger("deadMan");

export interface DeadManOptions {
  timeoutMs: number;
  /** How often the silence check runs. Default 1000 ms. */
  checkIntervalMs?: number;
  onTrip: () => Promise<void>;
  now?: () => number;
}

export class DeadManSwitch {
  private lastBeatAt = 0;
  private armed = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly checkIntervalMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: DeadManOptions) {
    this.checkIntervalMs = opts.checkIntervalMs ?? 1000;
    this.now = opts.now ?? Date.now;
  }

  beat(): void {
    if (!this.armed) logger.info({ timeoutMs: this.opts.timeoutMs }, "dead_man_armed");
    this.lastBeatAt = this.now();
    this.armed = true;
  }

  isArmed(): boolean {
    return this.armed;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), this.checkIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Exposed so tests can drive it without waiting on real timers. */
  check(): void {
    if (!this.armed) return;
    const silentMs = this.now() - this.lastBeatAt;
    if (silentMs <= this.opts.timeoutMs) return;
    this.armed = false; // trip once; the next heartbeat re-arms
    logger.error({ silentMs, timeoutMs: this.opts.timeoutMs }, "DEAD_MAN_TRIPPED -- no heartbeat from the master, flattening this account");
    void this.opts.onTrip().catch((err) => logger.error({ err: String(err) }, "dead_man_flatten_threw -- CHECK THIS ACCOUNT BY HAND"));
  }
}

export interface FlattenReport {
  closed: string[];
  alreadyFlat: string[];
  /** Symbols whose state could not be read or whose close was rejected -- need a human. */
  needsAttention: string[];
}

/**
 * Closes every open position on this account, then cancels resting orders for
 * that symbol (a trailing stop left behind would otherwise open the opposite
 * side later -- same reason engine/loop.ts cancels after every close). Only acts
 * on a position the broker CONFIRMS is open (isPositionFlat === false); an
 * unreadable state is retried, then reported, never guessed at.
 */
export async function flattenAllPositions(
  broker: BrokerClient,
  symbols: readonly string[],
  opts: { readRetries?: number; retryDelayMs?: number } = {},
): Promise<FlattenReport> {
  const retries = opts.readRetries ?? 3;
  const delayMs = opts.retryDelayMs ?? 2000;
  const report: FlattenReport = { closed: [], alreadyFlat: [], needsAttention: [] };

  for (const symbol of symbols) {
    try {
      let flat: boolean | null = null;
      for (let attempt = 0; attempt < retries; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, delayMs));
        flat = broker.isPositionFlat ? await broker.isPositionFlat(symbol) : null;
        if (flat !== null) break;
      }
      if (flat === true) {
        report.alreadyFlat.push(symbol);
        continue;
      }
      if (flat === null) {
        logger.error({ symbol }, "dead_man_cannot_read_position -- CHECK THIS ACCOUNT BY HAND");
        report.needsAttention.push(symbol);
        continue;
      }

      const closed = await applyMirrorCommand(broker, { kind: "requestClosePosition", symbol });
      if (closed.status === "rejected") {
        logger.error({ symbol, error: closed.error }, "dead_man_close_rejected -- CHECK THIS ACCOUNT BY HAND");
        report.needsAttention.push(symbol);
        continue;
      }
      await applyMirrorCommand(broker, { kind: "cancelRestingOrder", symbol }).catch((err) =>
        logger.error({ symbol, err: String(err) }, "dead_man_cancel_resting_failed -- check for a leftover stop"),
      );
      logger.warn({ symbol }, "dead_man_closed_position");
      report.closed.push(symbol);
    } catch (err) {
      logger.error({ symbol, err: String(err) }, "dead_man_symbol_failed -- CHECK THIS ACCOUNT BY HAND");
      report.needsAttention.push(symbol);
    }
  }
  return report;
}
