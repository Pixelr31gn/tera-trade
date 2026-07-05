/**
 * Broker adapter for Topstep's ProjectX Gateway API.
 *
 * Built directly against the documented REST + SignalR spec at
 * https://gateway.docs.projectx.com/ (confirmed endpoints as of 2026-07):
 *
 * - Auth:      POST {base}/api/Auth/loginKey            {userName, apiKey} -> {token}
 * - Bars:      POST {base}/api/History/retrieveBars      {contractId, live, startTime, endTime,
 *                                                          unit, unitNumber, limit, includePartialBar}
 * - Place:     POST {base}/api/Order/place               {accountId, contractId, type, side, size,
 *                                                          limitPrice?, stopPrice?, trailPrice?,
 *                                                          customTag?, stopLossBracket?, takeProfitBracket?}
 * - Orders:    POST {base}/api/Order/searchOpen           {accountId}
 * - Positions: POST {base}/api/Position/searchOpen        {accountId}
 * - Trades:    POST {base}/api/Trade/search               {accountId, startTimestamp, endTimestamp?}
 * - Realtime:  wss://{rtc}/hubs/user?access_token=JWT     events: GatewayUserAccount/Order/Position/Trade
 *              wss://{rtc}/hubs/market?access_token=JWT   events: GatewayQuote/Trade/Depth
 *
 * This class can only be integration-tested once real ProjectX Gateway
 * credentials are configured (PROJECTX_USERNAME / PROJECTX_API_KEY) -- until
 * then it's exercised by unit tests against a mocked fetch. The engine
 * defaults to SimulatedBroker; this adapter is only used once TRADING_MODE
 * reaches `live` AND BROKER_KIND=projectx is explicitly configured.
 */
import * as signalR from "@microsoft/signalr";
import { Decimal } from "decimal.js";
import { getSettings } from "../core/config.js";
import { childLogger } from "../core/logger.js";
import type {
  AccountUpdateHandler,
  BrokerAccount,
  BrokerClient,
  BrokerOrder,
  BrokerPosition,
  HistoricalBar,
  MarketDataHandler,
  OrderRequest,
  OrderResult,
} from "./types.js";
import { OrderSide, OrderType } from "./types.js";

const logger = childLogger("projectXGatewayBroker");

const ORDER_TYPE_MAP: Record<OrderType, number> = {
  [OrderType.LIMIT]: 1,
  [OrderType.MARKET]: 2,
  [OrderType.STOP]: 4,
  [OrderType.TRAILING_STOP]: 5,
};
const SIDE_MAP: Record<OrderSide, number> = { [OrderSide.BUY]: 0, [OrderSide.SELL]: 1 };
const BAR_UNIT_MINUTE = 2; // 1=Second,2=Minute,3=Hour,4=Day,5=Week,6=Month

export class ProjectXAuthError extends Error {}

export class ProjectXGatewayBroker implements BrokerClient {
  private baseUrl: string;
  private rtcUrl: string;
  private username: string;
  private apiKey: string;
  private token: string | undefined;
  private userHub: signalR.HubConnection | undefined;
  private marketHub: signalR.HubConnection | undefined;

  constructor() {
    const settings = getSettings();
    this.baseUrl = settings.projectXBaseUrl.replace(/\/$/, "");
    this.rtcUrl = settings.projectXRtcUrl.replace(/\/$/, "");
    this.username = settings.projectXUsername;
    this.apiKey = settings.projectXApiKey;
  }

  async connect(): Promise<void> {
    if (!this.username || !this.apiKey) {
      throw new ProjectXAuthError(
        "PROJECTX_USERNAME / PROJECTX_API_KEY are not configured; cannot connect to ProjectX Gateway"
      );
    }
    const resp = await fetch(`${this.baseUrl}/api/Auth/loginKey`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userName: this.username, apiKey: this.apiKey }),
    });
    const data = (await resp.json()) as { success: boolean; token: string; errorMessage?: string };
    if (!data.success) {
      throw new ProjectXAuthError(`ProjectX login failed: ${data.errorMessage}`);
    }
    this.token = data.token;
    logger.info({ username: this.username }, "connected");
  }

  async disconnect(): Promise<void> {
    await this.userHub?.stop();
    await this.marketHub?.stop();
  }

  private requireToken(): string {
    if (!this.token) throw new ProjectXAuthError("Not connected -- call connect() first");
    return this.token;
  }

  private async post<T>(path: string, payload: unknown): Promise<T> {
    const token = this.requireToken();
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      throw new Error(`ProjectX request to ${path} failed: HTTP ${resp.status}`);
    }
    return (await resp.json()) as T;
  }

  async getAccounts(): Promise<BrokerAccount[]> {
    const data = await this.post<{ accounts: Array<{ id: number; name?: string; balance?: number; equity?: number }> }>(
      "/api/Account/search",
      { onlyActiveAccounts: true }
    );
    return data.accounts.map((a) => ({
      accountId: String(a.id),
      name: a.name ?? String(a.id),
      balance: new Decimal(a.balance ?? 0),
      equity: new Decimal(a.equity ?? a.balance ?? 0),
    }));
  }

  async getPositions(accountId: string): Promise<BrokerPosition[]> {
    const data = await this.post<{
      positions: Array<{ contractId: string; size: number; averagePrice: number; unrealizedPnl?: number }>;
    }>("/api/Position/searchOpen", { accountId: Number(accountId) });
    return data.positions.map((p) => ({
      accountId,
      symbol: p.contractId,
      side: p.size >= 0 ? OrderSide.BUY : OrderSide.SELL,
      quantity: Math.abs(p.size),
      avgPrice: new Decimal(p.averagePrice),
      unrealizedPnl: new Decimal(p.unrealizedPnl ?? 0),
    }));
  }

  async getOpenOrders(accountId: string): Promise<BrokerOrder[]> {
    const data = await this.post<{
      orders: Array<{ id: number; contractId: string; side: number; size: number; status?: string; limitPrice?: number; stopPrice?: number }>;
    }>("/api/Order/searchOpen", { accountId: Number(accountId) });
    return data.orders.map((o) => ({
      brokerOrderId: String(o.id),
      accountId,
      symbol: o.contractId,
      side: o.side === 0 ? OrderSide.BUY : OrderSide.SELL,
      orderType: OrderType.MARKET,
      quantity: o.size,
      status: o.status ?? "pending",
      limitPrice: o.limitPrice !== undefined ? new Decimal(o.limitPrice) : undefined,
      stopPrice: o.stopPrice !== undefined ? new Decimal(o.stopPrice) : undefined,
    }));
  }

  async placeOrder(request: OrderRequest): Promise<OrderResult> {
    const payload: Record<string, unknown> = {
      accountId: Number(request.accountId),
      contractId: request.symbol,
      type: ORDER_TYPE_MAP[request.orderType],
      side: SIDE_MAP[request.side],
      size: request.quantity,
    };
    if (request.limitPrice) payload.limitPrice = request.limitPrice.toNumber();
    if (request.stopPrice) payload.stopPrice = request.stopPrice.toNumber();
    if (request.customTag) payload.customTag = request.customTag;
    // Bracket orders are expressed as tick offsets by the gateway, not absolute
    // prices -- the caller (execution engine) is responsible for converting
    // stopLossPrice/takeProfitPrice into tick distances before this point is
    // reached in a live-mode build-out; left as an explicit TODO because it
    // requires the live instrument's tickSize, which this adapter doesn't own.

    try {
      const data = await this.post<{ success: boolean; orderId: number; errorMessage?: string }>("/api/Order/place", payload);
      if (!data.success) {
        return { brokerOrderId: "", status: "rejected", error: data.errorMessage };
      }
      return { brokerOrderId: String(data.orderId), status: "pending" };
    } catch (err) {
      return { brokerOrderId: "", status: "rejected", error: String(err) };
    }
  }

  async cancelOrder(accountId: string, brokerOrderId: string): Promise<boolean> {
    const data = await this.post<{ success: boolean }>("/api/Order/cancel", {
      accountId: Number(accountId),
      orderId: Number(brokerOrderId),
    });
    return data.success;
  }

  async getTradeHistory(accountId: string, start: Date, end?: Date): Promise<unknown[]> {
    const payload: Record<string, unknown> = { accountId: Number(accountId), startTimestamp: start.toISOString() };
    if (end) payload.endTimestamp = end.toISOString();
    const data = await this.post<{ trades: unknown[] }>("/api/Trade/search", payload);
    return data.trades;
  }

  async getHistoricalBars(symbol: string, start: Date, end: Date, unitMinutes = 1, limit = 20_000): Promise<HistoricalBar[]> {
    const data = await this.post<{ bars: Array<{ t: string; o: number; h: number; l: number; c: number; v?: number }> }>(
      "/api/History/retrieveBars",
      {
        contractId: symbol,
        live: false,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        unit: BAR_UNIT_MINUTE,
        unitNumber: unitMinutes,
        limit,
        includePartialBar: false,
      }
    );
    return data.bars.map((b) => ({
      time: new Date(b.t),
      open: new Decimal(b.o),
      high: new Decimal(b.h),
      low: new Decimal(b.l),
      close: new Decimal(b.c),
      volume: new Decimal(b.v ?? 0),
    }));
  }

  private buildHub(hubPath: string): signalR.HubConnection {
    const token = this.requireToken();
    return new signalR.HubConnectionBuilder()
      .withUrl(`${this.rtcUrl}/hubs/${hubPath}?access_token=${token}`, { skipNegotiation: true, transport: signalR.HttpTransportType.WebSockets })
      .withAutomaticReconnect([1000, 3000, 5000, 10000, 15000])
      .build();
  }

  async startMarketStream(symbols: string[], handler: MarketDataHandler): Promise<void> {
    const hub = this.buildHub("market");
    for (const event of ["GatewayQuote", "GatewayTrade", "GatewayDepth"]) {
      hub.on(event, (data: unknown) => void handler({ event, data }));
    }
    await hub.start();
    for (const symbol of symbols) {
      await hub.send("SubscribeContractQuotes", symbol);
      await hub.send("SubscribeContractTrades", symbol);
    }
    this.marketHub = hub;
  }

  async startAccountStream(accountId: string, handler: AccountUpdateHandler): Promise<void> {
    const hub = this.buildHub("user");
    for (const event of ["GatewayUserAccount", "GatewayUserOrder", "GatewayUserPosition", "GatewayUserTrade"]) {
      hub.on(event, (data: unknown) => void handler({ event, data }));
    }
    await hub.start();
    await hub.send("SubscribeAccounts");
    this.userHub = hub;
  }
}
