/**
 * Broker adapter for Topstep's ProjectX Gateway API.
 *
 * Built directly against the documented REST + SignalR spec at
 * https://gateway.docs.projectx.com/ (confirmed endpoints as of 2026-07,
 * Contract/search and Order/place's bracket fields re-verified live against
 * the real docs 2026-09-08 -- see resolveContract's and placeOrder's own
 * comments for exactly what changed):
 *
 * - Auth:      POST {base}/api/Auth/loginKey            {userName, apiKey} -> {token}
 * - Contract:  POST {base}/api/Contract/search           {searchText, live} -> {contracts: [{id,
 *                                                          name, description, tickSize, tickValue,
 *                                                          activeContract, symbolId}], success}
 * - Bars:      POST {base}/api/History/retrieveBars      {contractId, live, startTime, endTime,
 *                                                          unit, unitNumber, limit, includePartialBar}
 * - Place:     POST {base}/api/Order/place               {accountId, contractId, type, side, size,
 *                                                          limitPrice?, stopPrice?, trailPrice?,
 *                                                          customTag?, stopLossBracket?: {ticks, type},
 *                                                          takeProfitBracket?: {ticks, type}}
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
import { getInstrument } from "../marketData/instruments.js";
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

interface ResolvedContract {
  contractId: string;
  tickSize: Decimal;
}

export class ProjectXAuthError extends Error {}

export class ProjectXGatewayBroker implements BrokerClient {
  private baseUrl: string;
  private rtcUrl: string;
  private username: string;
  private apiKey: string;
  private token: string | undefined;
  private userHub: signalR.HubConnection | undefined;
  private marketHub: signalR.HubConnection | undefined;
  // Front-month contract IDs roll (quarterly for ES/NQ/GC/CL) -- caching by
  // search text, not persisted across process restarts, so a roll is picked
  // up automatically the first time this process resolves that symbol again
  // after it happens (2026-09-08, see resolveContract's own comment).
  private contractCache = new Map<string, ResolvedContract>();

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

  /**
   * Resolves a search term to the current active contract's real ID and tick size (2026-09-08,
   * verified live against the real docs at https://gateway.docs.projectx.com/docs/api-reference/
   * market-data/search-contracts/ -- this was a documented-but-never-implemented gap: this class's
   * own header comment always described Order/place needing a real `contractId` like
   * "CON.F.US.MES.U26", but nothing anywhere in this codebase ever produced one -- every call site
   * either passed a bare Tera Trade symbol ("ES") or a manually-supplied raw contract string,
   * neither of which the real API accepts as a genuine identifier for a NEW order (the raw string
   * only worked for read calls like getPositions/getOpenOrders, which just echo back whatever
   * contractId the position/order already has).
   *
   * Input can be EITHER a bare instrument symbol Tera Trade knows about (marketData/instruments.ts's
   * "ES"/"NQ"/"GC"/"CL" -- resolved to that instrument's own brokerContractPrefix, e.g. "MES", the
   * actual tradeable micro contract) OR any other free-text search term (a raw prefix like "MES"
   * directly, for ad-hoc/manual use) -- getInstrument throwing on an unrecognized symbol is exactly
   * how these two cases are told apart, no separate flag needed.
   *
   * Picks whichever returned contract has activeContract===true (the current front-month/tradeable
   * one) rather than the first result -- Contract/search can return several expiries for one
   * prefix. Cached in-process by the exact search text used, not persisted -- see contractCache's
   * own comment for why that's fine across a contract roll.
   */
  private async resolveContract(symbolOrSearchText: string): Promise<ResolvedContract> {
    let searchText = symbolOrSearchText;
    try {
      searchText = getInstrument(symbolOrSearchText).brokerContractPrefix;
    } catch {
      // Not a Tera Trade instrument symbol -- use the input verbatim as the search text.
    }

    const cached = this.contractCache.get(searchText);
    if (cached) return cached;

    // live:false, not true -- confirmed empirically 2026-09-08 against the real endpoint: live:true
    // returned zero contracts for every search tried (including "MES", which has a real, active,
    // currently-tradeable contract), while live:false correctly returned it. Counter-intuitive
    // given this account trades real money, but this flag evidently isn't "real vs paper
    // account" -- matches the docs' own example, which also used live:false.
    const data = await this.post<{
      contracts: Array<{ id: string; tickSize: number; activeContract: boolean }>;
      success: boolean;
      errorMessage?: string;
    }>("/api/Contract/search", { searchText, live: false });
    if (!data.success) {
      throw new Error(`ProjectX contract search for "${searchText}" failed: ${data.errorMessage}`);
    }
    const active = data.contracts.find((c) => c.activeContract);
    if (!active) {
      throw new Error(`ProjectX contract search for "${searchText}" returned no active contract (${data.contracts.length} result(s), none active)`);
    }

    const resolved: ResolvedContract = { contractId: active.id, tickSize: new Decimal(active.tickSize) };
    this.contractCache.set(searchText, resolved);
    return resolved;
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

  // 2026-09-10: `size` is NOT signed -- confirmed live against a real, independently-verified
  // short position (Trade/search showed the opening fill as a real sell at 29188, but this
  // endpoint's raw response for that same position was `{"type": 2, "size": 2, ...}`, size
  // positive despite being short). The original `size >= 0 ? BUY : SELL` logic was wrong for
  // every position, not just this one -- `size` is always a plain positive quantity; direction
  // comes from the separate `type` field. Only one value is empirically confirmed (type 2 =
  // short, from the incident above); type 1 = long is inferred by elimination/the standard
  // PositionType convention, not independently confirmed the same way -- watch for this if a
  // long position's side ever looks wrong.
  async getPositions(accountId: string): Promise<BrokerPosition[]> {
    const data = await this.post<{
      positions: Array<{ contractId: string; type: number; size: number; averagePrice: number; unrealizedPnl?: number }>;
    }>("/api/Position/searchOpen", { accountId: Number(accountId) });
    return data.positions.map((p) => ({
      accountId,
      symbol: p.contractId,
      side: p.type === 2 ? OrderSide.SELL : OrderSide.BUY,
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
      // 2026-09-08: fixed live -- the real gateway returns `null` for a field
      // that isn't set (a limit order's stopPrice, a stop order's limitPrice),
      // not `undefined`; `!== undefined` let `new Decimal(null)` through,
      // which throws ("Invalid argument: null") and crashed this call
      // entirely for any account with a mixed order book. `!= null` catches
      // both null and undefined in one check.
      limitPrice: o.limitPrice != null ? new Decimal(o.limitPrice) : undefined,
      stopPrice: o.stopPrice != null ? new Decimal(o.stopPrice) : undefined,
    }));
  }

  /**
   * Places the entry order with a REAL, native ProjectX bracket attached for stopLossPrice/
   * takeProfitPrice when both are given (2026-09-08, operator instruction: "instead of limit
   * orders for sl and tp its setting up actual brackets" -- the gateway's own Order/place
   * genuinely supports this, unlike browserControlBroker's DOM-automation path, which never could
   * and instead rests two separate orders shortly after entry via engine/loop.ts's
   * activateTrailingStop/activateTakeProfitOrder). A real bracket submits atomically with the
   * entry -- no gap between fill and protection existing, which that two-step resting-order
   * pattern always has (however small).
   *
   * stopLossBracket/takeProfitBracket are expressed as a TICK COUNT from wherever the entry
   * actually fills, not an absolute price (verified live against the real docs, see this class's
   * header comment) -- computed here from request.stopLossPrice/takeProfitPrice against
   * request.referencePrice (the caller's expected entry price; execution/engine.ts always supplies
   * this as entryPrice) and resolveContract's real tickSize for this contract, which is why that
   * resolution has to happen before this payload can be built at all. Silently omitted (not an
   * error) when stopLossPrice/takeProfitPrice aren't both given, or when referencePrice is missing
   * and there's therefore nothing to measure ticks from -- an order without a target/stop bracket
   * is a real, valid order, just an unprotected one; the caller decides whether that's acceptable
   * (see risk/engine.ts -- every real signal-driven trade always has both prices, this only
   * matters for hand-built manual orders).
   */
  async placeOrder(request: OrderRequest): Promise<OrderResult> {
    let contractId: string;
    let tickSize: Decimal;
    try {
      const resolved = await this.resolveContract(request.symbol);
      contractId = resolved.contractId;
      tickSize = resolved.tickSize;
    } catch (err) {
      return { brokerOrderId: "", status: "rejected", error: `contract resolution failed: ${String(err)}` };
    }

    const payload: Record<string, unknown> = {
      accountId: Number(request.accountId),
      contractId,
      type: ORDER_TYPE_MAP[request.orderType],
      side: SIDE_MAP[request.side],
      size: request.quantity,
    };
    if (request.limitPrice) payload.limitPrice = request.limitPrice.toNumber();
    if (request.stopPrice) payload.stopPrice = request.stopPrice.toNumber();
    if (request.customTag) payload.customTag = request.customTag;

    if (request.stopLossPrice && request.takeProfitPrice && request.referencePrice && tickSize.gt(0)) {
      const stopTicks = request.referencePrice.minus(request.stopLossPrice).abs().dividedBy(tickSize).round().toNumber();
      const targetTicks = request.referencePrice.minus(request.takeProfitPrice).abs().dividedBy(tickSize).round().toNumber();
      // Never a 0-tick bracket (would sit right on the fill price, effectively
      // triggering itself) -- floor at 1 tick, same "cheap insurance against a
      // genuinely invalid order" posture as risk/stops.ts's roundAwayFromEntry.
      payload.stopLossBracket = { ticks: Math.max(1, stopTicks), type: ORDER_TYPE_MAP[OrderType.STOP] };
      payload.takeProfitBracket = { ticks: Math.max(1, targetTicks), type: ORDER_TYPE_MAP[OrderType.LIMIT] };
    } else if (request.stopLossPrice || request.takeProfitPrice) {
      logger.warn(
        { hasStopLoss: !!request.stopLossPrice, hasTakeProfit: !!request.takeProfitPrice, hasReferencePrice: !!request.referencePrice },
        "order_placed_without_bracket -- stopLossPrice/takeProfitPrice/referencePrice were not all present, so no real bracket was attached"
      );
    }

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

  // 2026-09-10: requestClosePosition/flattenPosition/isPositionFlat did not exist at all before
  // this -- a real incident the same day (engine/loop.ts's brokerForTrade routed a
  // browser_control-opened trade through this broker after a BROKER_KIND switch, and its close
  // request silently did nothing since these were `undefined`, while the trade's stop was already
  // breached) showed that missing this entirely is worse than any DOM-automation fragility the
  // browser_control versions carry. There is no documented dedicated "close position" endpoint in
  // the ProjectX Gateway spec this file's header comment cites -- rather than guess at one, both
  // close methods are built entirely on placeOrder (already verified live) plus getPositions: read
  // (or, for flattenPosition, already know) the real side/quantity, and place the exact opposite-
  // side market order. This is the same mechanism a manual flatten already used successfully to
  // recover from the incident above.
  private async closeBySymbol(symbol: string): Promise<OrderResult> {
    const settings = getSettings();
    if (!settings.projectXAccountId) return { brokerOrderId: "", status: "rejected", error: "PROJECTX_ACCOUNT_ID is not configured" };
    const { contractId } = await this.resolveContract(symbol);
    const positions = await this.getPositions(String(settings.projectXAccountId));
    const position = positions.find((p) => p.symbol === contractId);
    if (!position) return { brokerOrderId: "", status: "rejected", error: `no open position found for "${symbol}" -- nothing to close` };
    return this.flattenPosition(symbol, position.side === OrderSide.BUY ? "long" : "short", position.quantity);
  }

  async requestClosePosition(symbol: string): Promise<OrderResult> {
    return this.closeBySymbol(symbol);
  }

  async flattenPosition(symbol: string, side: "long" | "short", quantity: number): Promise<OrderResult> {
    const settings = getSettings();
    if (!settings.projectXAccountId) return { brokerOrderId: "", status: "rejected", error: "PROJECTX_ACCOUNT_ID is not configured" };
    if (quantity <= 0) return { brokerOrderId: "", status: "rejected", error: "refusing to flatten with non-positive quantity" };
    // Flattening a long means selling, flattening a short means buying -- the opposite of the
    // position's own side, same convention as BrowserControlBroker's own flattenPosition.
    return this.placeOrder({
      accountId: String(settings.projectXAccountId),
      symbol,
      side: side === "long" ? OrderSide.SELL : OrderSide.BUY,
      orderType: OrderType.MARKET,
      quantity,
      customTag: `flatten:${symbol}:${Date.now()}`,
    });
  }

  async isPositionFlat(symbol: string): Promise<boolean | null> {
    try {
      const settings = getSettings();
      if (!settings.projectXAccountId) return null;
      const { contractId } = await this.resolveContract(symbol);
      const positions = await this.getPositions(String(settings.projectXAccountId));
      return !positions.some((p) => p.symbol === contractId && p.quantity > 0);
    } catch (err) {
      logger.warn({ symbol, err: String(err) }, "is_position_flat_check_failed");
      return null; // couldn't determine -- never guess
    }
  }

  // 2026-09-08: resolves through the same contract lookup as placeOrder now uses -- previously
  // passed `symbol` straight through as `contractId`, which only ever worked when the caller
  // already happened to supply a real ProjectX contract ID (e.g. one echoed back from
  // getPositions), not Tera Trade's own "ES"/"NQ"/"GC" symbols.
  async getHistoricalBars(symbol: string, start: Date, end: Date, unitMinutes = 1, limit = 20_000): Promise<HistoricalBar[]> {
    const { contractId } = await this.resolveContract(symbol);
    const data = await this.post<{ bars: Array<{ t: string; o: number; h: number; l: number; c: number; v?: number }> }>(
      "/api/History/retrieveBars",
      {
        contractId,
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
