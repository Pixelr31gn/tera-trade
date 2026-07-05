/**
 * The orchestration loop: new bar -> manage open trades -> evaluate new signals.
 *
 * This is the one place that wires marketData -> regime -> news -> strategy
 * -> scoring -> risk -> execution -> explanation together. Everything above
 * it is a pure, independently-testable module; this is the glue.
 */
import { Decimal } from "decimal.js";
import { prisma } from "../db/client.js";
import { childLogger } from "../core/logger.js";
import { getSettings, TradingMode } from "../core/config.js";
import type { BrokerClient, ClosedSimTrade } from "../brokers/types.js";
import { SimulatedBroker } from "../brokers/simulatedBroker.js";
import { computeAccountEquity, computeAccountRiskState, recordEquityPoint } from "./accounting.js";
import { ensureDefaultAccount, loadRecentBars } from "./bootstrap.js";
import { explainKillSwitch, explainRiskRejection, explainScore, explainTradeExit } from "../explain/engine.js";
import { executeIfApproved } from "../execution/engine.js";
import { getSystemState, tripKillSwitch } from "../execution/mode.js";
import { getInstrument } from "../marketData/instruments.js";
import { getNewsRiskStatus } from "../news/risk.js";
import { classifyRegime } from "../regime/classifier.js";
import { atr as computeAtr, type OhlcBar } from "../regime/indicators.js";
import { RiskEngine, type RiskLimitsConfig } from "../risk/index.js";
import { buildSetupFeatures } from "../scoring/features.js";
import { evaluateSetup } from "../scoring/gate.js";
import { ALL_STRATEGIES } from "../strategy/index.js";
import type { Account } from "@prisma/client";

const logger = childLogger("engineLoop");

const MIN_BARS_FOR_REGIME = 120;

// In-memory MAE/MFE tracking, keyed by trade id. Reset on process restart --
// acceptable for Phase 0 (single-process engine); a durable version would
// persist a running high/low alongside the trade row on every bar.
const tradeExcursion = new Map<number, { mfe: Decimal; mae: Decimal }>();

export type EventSink = (event: Record<string, unknown>) => Promise<void>;

export class TradingEngine {
  private riskEngine = new RiskEngine();

  constructor(
    private broker: BrokerClient = new SimulatedBroker(),
    private eventSink?: EventSink
  ) {}

  private async emit(event: Record<string, unknown>): Promise<void> {
    if (this.eventSink) await this.eventSink(event);
  }

  async onNewBar(symbol: string, barTime: Date, o: Decimal, h: Decimal, l: Decimal, c: Decimal, v: Decimal): Promise<void> {
    const account = await ensureDefaultAccount();
    const systemState = await getSystemState();
    const mode = systemState.mode as TradingMode;

    await this.manageOpenTrades(account, symbol, barTime, h, l, c);

    if (systemState.killSwitch) {
      await this.emit({ type: "kill_switch_active", reason: systemState.killSwitchReason });
    } else {
      await this.evaluateNewSignals(account, mode, symbol, barTime, c);
    }

    const equity = await computeAccountEquity(account, new Map([[symbol, c]]));
    await recordEquityPoint(account.id, equity, new Decimal(account.startingBalance.toString()), barTime);
    await this.emit({ type: "equity_update", accountId: account.id, equity: equity.toString(), time: barTime.toISOString() });
  }

  private async manageOpenTrades(account: Account, symbol: string, barTime: Date, h: Decimal, l: Decimal, c: Decimal): Promise<void> {
    const openTrade = await prisma.trade.findFirst({ where: { accountId: account.id, symbol, status: "open" } });
    if (openTrade) this.trackExcursion(openTrade, h, l);

    if (!(this.broker instanceof SimulatedBroker)) return; // live broker manages its own brackets server-side

    const brokerAccountId = (await this.broker.getAccounts())[0]!.accountId;
    this.broker.updateTrailingStop(brokerAccountId, symbol, c);
    const closed = this.broker.evaluateBar(brokerAccountId, symbol, h, l, barTime);
    if (!closed) return;
    await this.closeTrade(account, closed);
  }

  private trackExcursion(trade: { id: number; side: string; entryPrice: unknown }, h: Decimal, l: Decimal): void {
    const entryPrice = new Decimal(trade.entryPrice as string);
    const direction = trade.side === "long" ? 1 : -1;
    const favorableExtreme = direction === 1 ? h : l;
    const adverseExtreme = direction === 1 ? l : h;
    const favorableMove = Decimal.max(0, favorableExtreme.minus(entryPrice).times(direction));
    const adverseMove = Decimal.max(0, entryPrice.minus(adverseExtreme).times(direction));

    const existing = tradeExcursion.get(trade.id) ?? { mfe: new Decimal(0), mae: new Decimal(0) };
    tradeExcursion.set(trade.id, { mfe: Decimal.max(existing.mfe, favorableMove), mae: Decimal.max(existing.mae, adverseMove) });
  }

  private async closeTrade(account: Account, closed: ClosedSimTrade): Promise<void> {
    const trade = await prisma.trade.findFirst({
      where: { accountId: account.id, symbol: closed.symbol, status: "open" },
      orderBy: { entryTime: "desc" },
    });
    if (!trade) return;

    const instrument = getInstrument(trade.symbol);
    const direction = trade.side === "long" ? 1 : -1;
    const pnl = closed.exitPrice.minus(trade.entryPrice.toString()).times(direction).times(instrument.pointValue).times(trade.quantity);

    const excursion = tradeExcursion.get(trade.id) ?? { mfe: new Decimal(0), mae: new Decimal(0) };
    tradeExcursion.delete(trade.id);

    const explanation = explainTradeExit(trade.symbol, trade.side, closed.exitReason, closed.exitPrice, pnl);
    await prisma.trade.update({
      where: { id: trade.id },
      data: {
        exitTime: closed.exitTime,
        exitPrice: closed.exitPrice.toString(),
        exitReason: closed.exitReason,
        pnl: pnl.toString(),
        mae: excursion.mae.toString(),
        mfe: excursion.mfe.toString(),
        status: "closed",
        explanation: `${trade.explanation} ${explanation}`,
      },
    });

    await this.emit({ type: "trade_closed", tradeId: trade.id, symbol: trade.symbol, pnl: pnl.toString(), explanation });
  }

  private async evaluateNewSignals(account: Account, mode: TradingMode, symbol: string, barTime: Date, closePrice: Decimal): Promise<void> {
    const bars: OhlcBar[] = await loadRecentBars(symbol, 300);
    if (bars.length < MIN_BARS_FOR_REGIME) return;

    const regime = classifyRegime(bars);
    await prisma.regimeSnapshot.upsert({
      where: { time_symbol: { time: barTime, symbol } },
      update: { trendLabel: regime.trendLabel, volLabel: regime.volLabel, confidence: regime.confidence.toString(), features: JSON.parse(JSON.stringify(regime.features)) },
      create: { time: barTime, symbol, trendLabel: regime.trendLabel, volLabel: regime.volLabel, confidence: regime.confidence.toString(), features: JSON.parse(JSON.stringify(regime.features)) },
    });
    await this.emit({ type: "regime", symbol, trendLabel: regime.trendLabel, volLabel: regime.volLabel, confidence: regime.confidence });

    // Skip generating new entries into a symbol that already has an open position.
    const hasOpen = await prisma.trade.findFirst({ where: { accountId: account.id, symbol, status: "open" }, select: { id: true } });
    if (hasOpen) return; // excursion tracking for this open position already happened in manageOpenTrades

    const newsStatus = await getNewsRiskStatus(barTime);
    const settings = getSettings();

    for (const strategy of ALL_STRATEGIES) {
      const signal = strategy.generateSignal(symbol, bars);
      if (!signal) continue;

      const features = buildSetupFeatures(bars, symbol, signal.side, regime, barTime, newsStatus.inRiskWindow, newsStatus.minutesToEvent);
      const gated = evaluateSetup(features);
      const explanation = explainScore(symbol, signal.side, gated, settings.minScoreThreshold);

      await prisma.score.create({
        data: {
          time: barTime, symbol, strategyId: signal.strategyId, side: signal.side,
          probability: gated.probability.toString(), decision: gated.decision,
          features: JSON.parse(JSON.stringify(features)), explanation,
        },
      });
      await this.emit({ type: "score", symbol, side: signal.side, probability: gated.probability, decision: gated.decision, explanation });

      if (gated.decision !== "taken") continue;

      const riskLimitsRow = await prisma.riskLimit.findUniqueOrThrow({ where: { accountId: account.id } });
      const limits: RiskLimitsConfig = {
        perTradeRiskPct: new Decimal(riskLimitsRow.perTradeRiskPct.toString()),
        maxDailyLossPct: new Decimal(riskLimitsRow.maxDailyLossPct.toString()),
        maxTrailingDrawdownPct: new Decimal(riskLimitsRow.maxTrailingDrawdownPct.toString()),
        maxConsecutiveLosses: riskLimitsRow.maxConsecutiveLosses,
        maxDailyTrades: riskLimitsRow.maxDailyTrades,
        maxPositionSize: riskLimitsRow.maxPositionSize,
      };

      const equity = await computeAccountEquity(account, new Map([[symbol, closePrice]]));
      const accountState = await computeAccountRiskState(account, equity);
      const instrument = getInstrument(symbol);
      const atrSeries = computeAtr(bars).filter((v) => !Number.isNaN(v));
      if (atrSeries.length === 0) continue;
      const atrValue = new Decimal(atrSeries[atrSeries.length - 1]!);

      const assessment = this.riskEngine.assessNewTrade({
        side: signal.side, entryPrice: closePrice, atrValue,
        structureSwingPrice: signal.structureSwingPrice, accountState, limits,
        pointValue: instrument.pointValue, tickSize: instrument.tickSize, newsStatus,
      });

      if (assessment.tripKillSwitch) {
        await tripKillSwitch(assessment.reason);
        await this.emit({ type: "kill_switch_tripped", reason: explainKillSwitch(assessment.reason) });
        return;
      }

      if (!assessment.approved) {
        const rejection = explainRiskRejection(symbol, signal.side, assessment);
        await this.emit({ type: "risk_rejected", symbol, reason: rejection });
        continue;
      }

      const brokerAccountId = (await this.broker.getAccounts())[0]!.accountId;
      const result = await executeIfApproved(
        this.broker, mode, account.id, brokerAccountId, signal, gated, assessment,
        closePrice, regime.trendLabel, regime.volLabel, explanation, barTime
      );
      await this.emit({ type: "execution", symbol, executed: result.executed, reason: result.reason, tradeId: result.tradeId });
      return; // one new position per symbol per bar
    }
  }
}
