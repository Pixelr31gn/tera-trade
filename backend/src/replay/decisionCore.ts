/**
 * decideOnBar — the pure decision pipeline, lifted verbatim out of
 * TradingEngine.evaluateNewSignals (engine/loop.ts:842).
 *
 * This is the single highest-value refactor in the whole plan. Today that
 * logic is welded to prisma, to the caches, and to the broker. Once it lives
 * here, BOTH callers use it:
 *
 *   live:    TradingEngine.onNewBar  -> decideOnBar(LiveContext)  -> executeIfApproved(...)
 *   replay:  harness.run             -> decideOnBar(ReplayContext) -> simulateFill(...)
 *
 * That equivalence is the only thing that makes replay numbers trustworthy.
 * The moment the two paths diverge, you are backtesting a system you do not
 * actually run.
 *
 * Everything called below is ALREADY pure in your codebase — I checked:
 *   classifyRegime, generateSignal, computeAtr, computeInitialStop,
 *   buildSetupFeatures, scoreSetup (gate.ts), RiskEngine.assessNewTrade.
 * The only impure things were the context lookups, and those are now injected.
 */
import { Decimal } from "decimal.js";
import { classifySession } from "../analytics/session.js";
import { classifyRegime } from "../regime/classifier.js";
import { atr as computeAtr } from "../regime/indicators.js";
import { getInstrument } from "../marketData/instruments.js";
import { computeInitialStop } from "../risk/stops.js";
import { RiskEngine } from "../risk/engine.js";
import { buildSetupFeatures } from "../scoring/features.js";
import { evaluateSetup, type GatedScore } from "../scoring/gate.js";
import type { StrategyVersion } from "../scoring/ruleScorer.js";
import { ALL_STRATEGIES } from "../strategy/index.js";
import type { DecisionContext, BarDecision } from "./types.js";

const MIN_BARS_FOR_REGIME = 120; // keep in sync with engine/loop.ts:160

/**
 * NOTE: consensus lives in engine/loop.ts today (determineConsensus /
 * determineContinuousScanConsensus, both already exported and already pure).
 * Import them here rather than reimplementing — a second copy of the
 * consensus rule is how the harness and live silently drift apart.
 */
import { determineConsensus } from "../engine/loop.js";

const ALL_SCORED_VERSIONS: StrategyVersion[] = ["v1", "v2", "v3", "v5"];

/**
 * evaluateNewSignals doesn't stop at the first strategy that fires a signal
 * — it tries EVERY strategy in ALL_STRATEGIES order for the bar, persisting
 * a Score row for each one attempted, and only stops early once one either
 * gets executed or trips the kill switch (loop.ts:914-920's `continue` on
 * consensus_not_reached/risk_rejected, `return` otherwise). An earlier
 * version of this function returned on the FIRST strategy with any signal
 * at all, regardless of whether it reached consensus — a real divergence
 * from live whenever two strategies both fire on the same bar. Fixed
 * 2026-08-01 after reading evaluateNewSignals directly; see
 * .claude/rules/replay-harness.md's "one rule that matters."
 *
 * Returns one BarDecision per strategy actually attempted this bar (empty
 * array if there weren't enough bars yet or a position was already open —
 * nothing was evaluated, so nothing to record).
 */
export async function decideOnBar(params: {
  ctx: DecisionContext;
  symbol: string;
  barTime: Date;
  closePrice: Decimal;
}): Promise<BarDecision[]> {
  const { ctx, symbol, barTime, closePrice } = params;
  const degraded: string[] = [];

  const bars = await ctx.recentBars(symbol, 300, barTime);
  if (bars.length < MIN_BARS_FOR_REGIME) return [];

  if (await ctx.hasOpenPosition(symbol, barTime)) return [];

  const regime = classifyRegime(bars);
  const session = classifySession(barTime);

  const [newsStatus, openingRangeStats, dailyTrend, dailyEma20Trend] = await Promise.all([
    ctx.newsRisk(barTime),
    ctx.openingRange(symbol, barTime),
    ctx.dailyTrend(symbol, barTime),
    ctx.dailyEmaTrend(symbol, barTime),
  ]);
  // Live always reports none here; replay may flag missing dailyBar/newsEvent
  // coverage for this bar's as-of window (see ReplayDecisionContext).
  degraded.push(...ctx.contextDegradations());

  const orderFlow = ctx.orderFlow(symbol, barTime);
  if (orderFlow === null) degraded.push("orderFlow");

  const decisions: BarDecision[] = [];
  const executionSettings = ctx.executionSettings();

  for (const strategy of ALL_STRATEGIES) {
    const signal = strategy.generateSignal(symbol, bars);
    if (!signal) continue;

    const openingRangeBreakoutProbability =
      signal.side === "long" ? openingRangeStats.probHighBroken : openingRangeStats.probLowBroken;

    const longTargetEdge =
      signal.side === "long" ? await ctx.fixedTargetEdge(symbol, session, "long", barTime) : null;
    if (signal.side === "long" && longTargetEdge === null) degraded.push("fixedTargetEdge");

    const instrument = getInstrument(symbol);
    const atrSeries = computeAtr(bars).filter((v) => !Number.isNaN(v));
    if (atrSeries.length === 0) continue;
    const atrValue = new Decimal(atrSeries[atrSeries.length - 1]!);

    const stopPlan = computeInitialStop(closePrice, signal.side, atrValue, signal.structureSwingPrice, {
      tickSize: instrument.tickSize,
      takeProfitRMultiple: executionSettings.takeProfitRMultiple,
    });
    const riskRewardRatio = stopPlan.stopDistancePoints.gt(0)
      ? stopPlan.takeProfitPrice.minus(closePrice).abs().dividedBy(stopPlan.stopDistancePoints).toNumber()
      : null;

    const features = buildSetupFeatures(
      bars, symbol, signal.side, regime, barTime,
      newsStatus.inRiskWindow, newsStatus.minutesToEvent,
      null, openingRangeBreakoutProbability, openingRangeStats.sessionsAnalyzed,
      dailyTrend.trendLabel, dailyTrend.confidence,
      longTargetEdge?.winRate ?? null, longTargetEdge?.sampleSize ?? 0,
      riskRewardRatio, orderFlow, dailyEma20Trend,
    );

    // Shadow-score every version, same features, same bar — identical to live.
    //
    // evaluateSetup is POSITIONAL: (features, version, at, v3Inputs?).
    // Ordering is load-bearing, not stylistic: v3 needs v1Gated and v2Gated
    // for its v1v2Override (gate.ts), so v1 and v2 MUST be resolved first.
    // The live path does the same in scoreAllVersions (loop.ts:641) — if you
    // parallelize this with Promise.all you will silently disable the
    // override and the harness stops matching live.
    //
    // `at: barTime` is what gives computeHistoricalAdjustment's time bound
    // (scoring/v3HistoricalAdjustment.ts) any teeth in replay — passing
    // Date.now() here instead would silently reopen the look-ahead landmine
    // the bound exists to close.
    const gatedByVersion = new Map<StrategyVersion, GatedScore>();

    const v1Gated = await evaluateSetup(features, "v1", barTime);
    gatedByVersion.set("v1", v1Gated);

    const v2Gated = await evaluateSetup(features, "v2", barTime);
    gatedByVersion.set("v2", v2Gated);

    gatedByVersion.set(
      "v3",
      await evaluateSetup(features, "v3", barTime, {
        bars,
        v1Gated,
        v2Gated,
        signalKind: signal.signalKind,
      }),
    );

    // v5 is shadow-only: scored on every signal, excluded from
    // determineConsensus's STRATEGY_VERSIONS. Keep scoring it — the whole
    // point of the harness is deciding whether to promote it.
    const v5Gated = await evaluateSetup(features, "v5", barTime);
    gatedByVersion.set("v5", v5Gated);

    // v6 is a complete, self-contained scorer (ruleScorerV6.ts) as of
    // 2026-08-03 -- it only needs bars, not v1/v2/v3/v5's results, so
    // there's no real ordering requirement anymore. Scored here after the
    // other four purely to match SHADOW_ONLY_VERSIONS' declared order.
    // Shadow-only, same as v5.
    gatedByVersion.set("v6", await evaluateSetup(features, "v6", barTime, { bars }));

    const consensus = determineConsensus(gatedByVersion);

    let plan: BarDecision["plan"] = null;
    if (consensus.taken) {
      const assessment = new RiskEngine().assessNewTrade({
        side: signal.side,
        entryPrice: closePrice,
        atrValue,
        structureSwingPrice: signal.structureSwingPrice,
        signalKind: signal.signalKind,
        breakoutLevelPrice: signal.breakoutLevelPrice ?? null,
        accountState: ctx.accountState(barTime),
        limits: ctx.riskLimits(),
        pointValue: instrument.pointValue,
        tickSize: instrument.tickSize,
        newsStatus,
        bars,
        averageProbability: consensus.averageProbability,
        takeProfitRMultiple: executionSettings.takeProfitRMultiple,
        confidenceTiers: executionSettings.confidenceTiers,
        explicitStopPrice: signal.explicitStopPrice,
        explicitTakeProfitPrice: signal.explicitTakeProfitPrice,
      });

      plan = { ...assessment, entryPrice: closePrice };
    }

    decisions.push({
      symbol, barTime,
      signal: {
        strategyId: signal.strategyId, side: signal.side, signalKind: signal.signalKind,
        structureSwingPrice: signal.structureSwingPrice, breakoutLevelPrice: signal.breakoutLevelPrice ?? null,
      },
      features, atrValue, riskRewardRatio,
      gatedByVersion, consensus, plan, degraded: [...degraded],
    });

    // Matches loop.ts:919-920 exactly: consensus_not_reached or
    // risk_rejected means try the NEXT strategy on this same bar;
    // executed (plan.approved) or a kill-switch trip stops the bar here.
    if (plan?.approved || plan?.tripKillSwitch) break;
  }

  if (decisions.length === 0) {
    // No strategy fired. Still worth recording for the continuous-scan dataset.
    decisions.push({
      symbol, barTime, signal: null,
      features: null, atrValue: null, riskRewardRatio: null,
      gatedByVersion: new Map(),
      consensus: { taken: false, representativeVersion: null, averageProbability: 0, summary: "no strategy fired on this bar" },
      plan: null, degraded,
    });
  }

  return decisions;
}
