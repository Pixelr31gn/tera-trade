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
}
