import { Decimal } from "decimal.js";

export const OrderSide = { BUY: "buy", SELL: "sell" } as const;
export type OrderSide = (typeof OrderSide)[keyof typeof OrderSide];

export const OrderType = { MARKET: "market", LIMIT: "limit", STOP: "stop", TRAILING_STOP: "trailing_stop" } as const;
export type OrderType = (typeof OrderType)[keyof typeof OrderType];

export interface HistoricalBar {
  time: Date;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  volume: Decimal;
}

export interface BrokerAccount {
  accountId: string;
  name: string;
  balance: Decimal;
  equity: Decimal;
}

export interface BrokerPosition {
  accountId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  avgPrice: Decimal;
  unrealizedPnl: Decimal;
}

export interface BrokerOrder {
  brokerOrderId: string;
  accountId: string;
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  quantity: number;
  status: string;
  limitPrice?: Decimal;
  stopPrice?: Decimal;
}

export interface OrderRequest {
  accountId: string;
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  quantity: number;
  limitPrice?: Decimal;
  stopPrice?: Decimal;
  trailTicks?: number;
  stopLossPrice?: Decimal;
  takeProfitPrice?: Decimal;
  customTag?: string;
  /** Needed by SimulatedBroker to compute a realistic fill; ignored by real brokers. */
  referencePrice?: Decimal;
}

export interface OrderResult {
  brokerOrderId: string;
  status: "filled" | "pending" | "rejected";
  filledPrice?: Decimal;
  filledAt?: Date;
  error?: string;
}

export interface ClosedSimTrade {
  symbol: string;
  accountId: string;
  exitTime: Date;
  exitPrice: Decimal;
  exitReason: "stop" | "target";
  customTag?: string;
}

export type MarketDataHandler = (event: { event: string; data: unknown }) => Promise<void>;
export type AccountUpdateHandler = (event: { event: string; data: unknown }) => Promise<void>;

export interface BrokerClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getAccounts(): Promise<BrokerAccount[]>;
  getPositions(accountId: string): Promise<BrokerPosition[]>;
  getOpenOrders(accountId: string): Promise<BrokerOrder[]>;
  placeOrder(request: OrderRequest): Promise<OrderResult>;
  cancelOrder(accountId: string, brokerOrderId: string): Promise<boolean>;
  getHistoricalBars(symbol: string, start: Date, end: Date, unitMinutes?: number, limit?: number): Promise<HistoricalBar[]>;
  startMarketStream?(symbols: string[], handler: MarketDataHandler): Promise<void>;
  startAccountStream?(accountId: string, handler: AccountUpdateHandler): Promise<void>;
  /** Closes the open position in `symbol` entirely. Only implemented by brokers that support it (e.g. BrowserControlBroker). */
  requestClosePosition?(symbol: string): Promise<OrderResult>;
  /**
   * Read-only check: is there currently NO open position in `symbol` on the
   * real broker account? Only implemented by brokers where a position can
   * close outside our own control (e.g. BrowserControlBroker, where
   * TopstepX's own bracket order can close a position server-side without
   * our app ever being told). Returns null when the state genuinely can't
   * be determined (don't guess) -- callers must treat null as "unknown",
   * not as either true or false.
   */
  isPositionFlat?(symbol: string): Promise<boolean | null>;
  /**
   * Closes a position by placing a plain opposite-side order of `quantity`
   * (flattening a long means selling, flattening a short means buying) --
   * no new stop/target bracket is configured, since this is a closing trade,
   * not a new entry. A fallback for when requestClosePosition's dedicated
   * "Close" button doesn't work or isn't available: reuses the exact
   * Buy/Sell click path already proven reliable for entries (2026-07-19
   * operator request), rather than depending on a second, less-exercised UI
   * element. Only implemented by brokers that support it (e.g.
   * BrowserControlBroker).
   */
  flattenPosition?(symbol: string, side: "long" | "short", quantity: number): Promise<OrderResult>;
  /**
   * Places a real, broker-native trailing-stop order protecting an existing
   * position -- opposite side from the position itself (sell to protect a
   * long, buy to protect a short), same quantity, trailing `trailTicks`
   * ticks behind the best price reached. v1.3: this is what actually
   * replaces the internal hard-stop-price check once a trade reaches the
   * halfway-to-target activation point (see engine/loop.ts). A trailing
   * stop is a resting order, not an immediate fill -- returns `status:
   * "pending"` on success, same as a limit order. Only implemented by
   * brokers that support it (e.g. BrowserControlBroker).
   */
  placeTrailingStop?(symbol: string, side: "long" | "short", quantity: number, trailTicks: number): Promise<OrderResult>;
  /**
   * Cancels every resting order for `symbol` -- not a single order by ID.
   * The existing `cancelOrder(accountId, brokerOrderId)` method's signature
   * has no way to carry symbol, and TopstepX's ticket only offers "Cancel
   * Orders" for the whole symbol anyway (no per-order cancel button), so
   * this is a separate, symbol-scoped method rather than a forced fit into
   * the existing one (2026-07-20, Execution Decision Engine's time-decay/
   * opportunity-cost cancellation). Only implemented by brokers that support
   * it (e.g. BrowserControlBroker).
   */
  cancelRestingOrder?(symbol: string): Promise<OrderResult>;
}
