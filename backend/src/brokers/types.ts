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
  // 2026-09-03 (operator report: manually-closed positions weren't
  // auto-clearing) -- required, not derived from symbol, so
  // TradingEngine.closeTrade closes the EXACT trade being evaluated instead
  // of guessing "the most recent open trade on this symbol." That guess
  // silently broke once more than one trade could be open on the same
  // symbol at once (a known consequence of the same-symbol duplicate-entry
  // race) -- see engine/loop.ts's manageOpenTrades for the matching fix.
  tradeId: number;
  symbol: string;
  accountId: string;
  exitTime: Date;
  exitPrice: Decimal;
  // "trailing_stop" added 2026-08-12 -- see engine/loop.ts's
  // manageLiveOpenTrade for why a real trailing-stop close needs its own
  // reason distinct from "stop" (explain/engine.ts's explainTradeExit
  // already had the right message for it, this type was the only thing
  // blocking that call site from using it).
  exitReason: "stop" | "target" | "trailing_stop";
  customTag?: string;
}

/**
 * A single real, confirmed row from the broker's own closed-trade history --
 * not this app's own estimate. See browserControl/tradeHistoryPanel.ts for
 * where this is read for BrowserControlBroker (TopstepX's own "Trade
 * History" grid, confirmed live 2026-08-31 against real account data).
 */
export interface ClosedTradeHistoryEntry {
  brokerTradeId: string;
  contractCode: string;
  quantity: number;
  side: "long" | "short";
  entryTime: Date;
  exitTime: Date;
  entryPrice: Decimal;
  exitPrice: Decimal;
  /** Gross P&L before commissions/fees, exactly as the broker's own grid reports it. */
  grossPnl: Decimal;
  /** commissions + fees summed (both already negative/deductions on the source row). */
  totalDeductions: Decimal;
  /** grossPnl + totalDeductions -- the real, net realized dollar result that hit the account. */
  netPnl: Decimal;
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
   * Places a real, broker-native resting LIMIT order at `limitPrice` that closes an existing
   * position if price reaches it -- opposite side from the position itself (sell to take profit
   * on a long, buy to take profit on a short), same quantity. 2026-09-04 (operator report: a
   * position's own recorded price data showed it crossing takeProfitPrice more than once while
   * still open -- root cause was the browser price feed going stale, which silently stops
   * engine/loop.ts's own polling-based target check along with it, since both run off the same
   * price-tick stream). This gives the target a real broker-side enforcement path independent of
   * our own feed's health, mirroring placeTrailingStop's own resting-order shape exactly -- NOT
   * TopstepX's native Position Brackets feature (checkbox + popover + Save Changes), which caused
   * a real incident when tried 2026-07-21 and was deliberately ruled out (see
   * browserControlBroker.ts's own header comment). This reuses the same plain order-ticket
   * automation (setOrderType/setLimitPrice/setQuantity + a normal Buy/Sell submit) already proven
   * live by placeOrder's own limit-order path and by placeTrailingStop. A resting order, not an
   * immediate fill -- returns `status: "pending"` on success, same convention as
   * placeTrailingStop/a limit order. Only implemented by brokers that support it (e.g.
   * BrowserControlBroker).
   */
  placeTakeProfitOrder?(symbol: string, side: "long" | "short", quantity: number, limitPrice: Decimal): Promise<OrderResult>;
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
  /**
   * Reads the broker's own closed-trade history for `symbol`, most recent
   * first -- real confirmed fills/P&L/fees, not this app's own estimates.
   * Only implemented by brokers with such a panel (e.g. BrowserControlBroker,
   * TopstepX's own Trade History grid). Returns null when the panel itself
   * can't be read (don't guess, same posture as isPositionFlat); an empty
   * array is a real "no closed trades found for this symbol," never confused
   * with null.
   */
  readClosedTradeHistory?(symbol: string): Promise<ClosedTradeHistoryEntry[] | null>;
}
