/**
 * Multi-account fan-out: shared types.
 *
 * The master controller runs the full trading engine as usual. Every
 * state-CHANGING broker action it takes is also mirrored, as a `MirrorCommand`,
 * to each remote PC (one per Topstep account), where that PC's own
 * BrowserControlBroker executes it against its own Chrome / account / IP.
 *
 * Read-only / decision methods (fills, flat checks, history) are deliberately
 * NOT mirrored -- each account answers those for itself; the engine only ever
 * reasons about the master account.
 *
 * Only these six methods change account state, so these are the only commands:
 *   placeOrder, requestClosePosition, flattenPosition,
 *   placeTrailingStop, placeTakeProfitOrder, cancelRestingOrder
 */
import type { Decimal } from "decimal.js";
import type { OrderRequest, OrderResult } from "../brokers/types.js";

export type MirrorCommand =
  | { kind: "placeOrder"; request: OrderRequest }
  | { kind: "requestClosePosition"; symbol: string }
  | { kind: "flattenPosition"; symbol: string; side: "long" | "short"; quantity: number }
  | { kind: "placeTrailingStop"; symbol: string; side: "long" | "short"; quantity: number; trailTicks: number }
  | { kind: "placeTakeProfitOrder"; symbol: string; side: "long" | "short"; quantity: number; limitPrice: Decimal }
  | { kind: "cancelRestingOrder"; symbol: string };

export type MirrorCommandKind = MirrorCommand["kind"];

/**
 * A remote PC that can run a MirrorCommand against its own account. In tests
 * this is a fake; in production it is an HTTP client to that PC's executor
 * service over Tailscale (built in a later stage).
 */
export interface RemoteExecutor {
  readonly name: string; // account/PC label, e.g. "pc2"
  dispatch(command: MirrorCommand): Promise<OrderResult>;
  /**
   * "The master is alive" ping that arms/refreshes the executor's dead-man
   * switch (deadMan.ts). Optional so plain test fakes need not implement it.
   */
  heartbeat?(): Promise<void>;
}

/** One remote's outcome for a single mirrored command. */
export interface RemoteOutcome {
  name: string;
  result?: OrderResult; // present when the executor answered (even a rejection)
  error?: string; // present when the dispatch itself failed (network, etc.)
}
