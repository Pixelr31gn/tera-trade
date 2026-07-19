/**
 * Paper-trading broker: realistic simulated fills against reference prices
 * supplied by the caller (the engine, driven by real/historical bars), with a
 * simple slippage model and self-contained stop/target/trailing-stop bracket
 * tracking. This is the default broker for Phase 0/1/2 -- it never talks to a
 * network.
 */
import { Decimal } from "decimal.js";
import { childLogger } from "../core/logger.js";
import type {
  BrokerAccount,
  BrokerClient,
  BrokerOrder,
  BrokerPosition,
  ClosedSimTrade,
  HistoricalBar,
  OrderRequest,
  OrderResult,
} from "./types.js";
import { OrderSide } from "./types.js";

const logger = childLogger("simulatedBroker");

let orderIdCounter = 1;
const DEFAULT_SLIPPAGE_TICKS = 1;

interface SimBracket {
  accountId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  entryPrice: Decimal;
  stopPrice: Decimal;
  takeProfitPrice?: Decimal;
  trailTicks?: number;
  tickSize: Decimal;
  customTag?: string;
  highestFavorable: Decimal;
}

export class SimulatedBroker implements BrokerClient {
  private balance: Decimal;
  private equity: Decimal;
  private positions = new Map<string, BrokerPosition>();
  private brackets = new Map<string, SimBracket>();
  private orders = new Map<string, BrokerOrder>();

  constructor(startingBalance: Decimal = new Decimal(50000)) {
    this.balance = startingBalance;
    this.equity = startingBalance;
  }

  private key(accountId: string, symbol: string): string {
    return `${accountId}:${symbol}`;
  }

  async connect(): Promise<void> {
    logger.info("connect");
  }

  async disconnect(): Promise<void> {
    logger.info("disconnect");
  }

  async getAccounts(): Promise<BrokerAccount[]> {
    return [{ accountId: "sim-1", name: "Simulated", balance: this.balance, equity: this.equity }];
  }

  async getPositions(accountId: string): Promise<BrokerPosition[]> {
    return [...this.positions.values()].filter((p) => p.accountId === accountId);
  }

  async getOpenOrders(accountId: string): Promise<BrokerOrder[]> {
    return [...this.orders.values()].filter((o) => o.accountId === accountId && o.status === "pending");
  }

  async placeOrder(request: OrderRequest): Promise<OrderResult> {
    if (!request.referencePrice) {
      return { brokerOrderId: "", status: "rejected", error: "referencePrice required for simulated fills" };
    }

    const orderId = `SIM-${orderIdCounter++}`;
    const tickSize = new Decimal("0.25");
    const slippage = tickSize.times(DEFAULT_SLIPPAGE_TICKS);
    const fillPrice =
      request.side === OrderSide.BUY ? request.referencePrice.plus(slippage) : request.referencePrice.minus(slippage);
    const now = new Date();
    const key = this.key(request.accountId, request.symbol);

    this.positions.set(key, {
      accountId: request.accountId,
      symbol: request.symbol,
      side: request.side,
      quantity: request.quantity,
      avgPrice: fillPrice,
      unrealizedPnl: new Decimal(0),
    });

    if (request.stopLossPrice) {
      this.brackets.set(key, {
        accountId: request.accountId,
        symbol: request.symbol,
        side: request.side,
        quantity: request.quantity,
        entryPrice: fillPrice,
        stopPrice: request.stopLossPrice,
        takeProfitPrice: request.takeProfitPrice,
        trailTicks: request.trailTicks,
        tickSize,
        customTag: request.customTag,
        highestFavorable: fillPrice,
      });
    }

    this.orders.set(orderId, {
      brokerOrderId: orderId,
      accountId: request.accountId,
      symbol: request.symbol,
      side: request.side,
      orderType: request.orderType,
      quantity: request.quantity,
      status: "filled",
    });

    logger.info({ orderId, symbol: request.symbol, price: fillPrice.toString() }, "fill");
    return { brokerOrderId: orderId, status: "filled", filledPrice: fillPrice, filledAt: now };
  }

  async cancelOrder(accountId: string, brokerOrderId: string): Promise<boolean> {
    const order = this.orders.get(brokerOrderId);
    if (!order || order.status !== "pending") return false;
    this.orders.set(brokerOrderId, { ...order, status: "cancelled" });
    return true;
  }

  /** Force-close (kill switch / manual). Returns realized pnl in points. */
  async closePosition(accountId: string, symbol: string, exitPrice: Decimal): Promise<Decimal> {
    const key = this.key(accountId, symbol);
    const position = this.positions.get(key);
    this.positions.delete(key);
    this.brackets.delete(key);
    if (!position) return new Decimal(0);
    const direction = position.side === OrderSide.BUY ? 1 : -1;
    return exitPrice.minus(position.avgPrice).times(direction);
  }

  /** Ratchet a chandelier/structure trailing stop forward. Called every bar. */
  updateTrailingStop(accountId: string, symbol: string, currentPrice: Decimal): void {
    const bracket = this.brackets.get(this.key(accountId, symbol));
    if (!bracket || bracket.trailTicks === undefined) return;
    const trailDistance = bracket.tickSize.times(bracket.trailTicks);

    if (bracket.side === OrderSide.BUY) {
      bracket.highestFavorable = Decimal.max(bracket.highestFavorable, currentPrice);
      const newStop = bracket.highestFavorable.minus(trailDistance);
      if (newStop.gt(bracket.stopPrice)) bracket.stopPrice = newStop;
    } else {
      bracket.highestFavorable = Decimal.min(bracket.highestFavorable, currentPrice);
      const newStop = bracket.highestFavorable.plus(trailDistance);
      if (newStop.lt(bracket.stopPrice)) bracket.stopPrice = newStop;
    }
  }

  /**
   * The bracket's current (possibly trailed) stop price, if this broker
   * instance still remembers opening the position -- null if it doesn't
   * (e.g. a process restart wiped this in-memory map; brackets/positions are
   * never persisted). Callers must not treat null as "no stop exists" --
   * fall back to the durable, DB-persisted stop instead. See
   * engine/loop.ts's manageOpenTrades for why this distinction matters.
   */
  getBracketStopPrice(accountId: string, symbol: string): Decimal | null {
    return this.brackets.get(this.key(accountId, symbol))?.stopPrice ?? null;
  }

  /** Check whether this bar's range triggered the resting stop or target. */
  evaluateBar(accountId: string, symbol: string, high: Decimal, low: Decimal, barTime: Date): ClosedSimTrade | null {
    const key = this.key(accountId, symbol);
    const bracket = this.brackets.get(key);
    if (!bracket) return null;

    let hitStop: boolean;
    let hitTarget: boolean;
    if (bracket.side === OrderSide.BUY) {
      hitStop = low.lte(bracket.stopPrice);
      hitTarget = bracket.takeProfitPrice !== undefined && high.gte(bracket.takeProfitPrice);
    } else {
      hitStop = high.gte(bracket.stopPrice);
      hitTarget = bracket.takeProfitPrice !== undefined && low.lte(bracket.takeProfitPrice);
    }

    if (!hitStop && !hitTarget) return null;

    // Conservative: if both could have hit intrabar, assume the adverse one (stop) triggered first.
    const exitReason: "stop" | "target" = hitStop ? "stop" : "target";
    const exitPrice = hitStop ? bracket.stopPrice : bracket.takeProfitPrice!;
    this.positions.delete(key);
    this.brackets.delete(key);
    return { symbol, accountId, exitTime: barTime, exitPrice, exitReason, customTag: bracket.customTag };
  }

  async getHistoricalBars(): Promise<HistoricalBar[]> {
    throw new Error("SimulatedBroker has no market data of its own; use src/marketData instead");
  }
}
