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
import { computeInitialStop, HARD_TAKE_PROFIT_DOLLARS, REQUIRE_DAILY_PLAN_SYMBOLS } from "../risk/stops.js";
import { RiskEngine } from "../risk/engine.js";
import { computeSmartEntryPrice } from "../analytics/smartEntry.js";
import { buildSetupFeatures } from "../scoring/features.js";
import { evaluateSetup, type GatedScore } from "../scoring/gate.js";
import { strategySymbolKey } from "../engine/strategySymbolEnablementCache.js";
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
import { determineConsensus, isSrProximityGateSuspended } from "../engine/loop.js";

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

  // Checked before anything else -- a disabled symbol has nothing to
  // evaluate at all (2026-09-03, see DecisionContext.disabledSymbols).
  if ((await ctx.disabledSymbols()).has(symbol)) return [];

  const bars = await ctx.recentBars(symbol, 300, barTime);
  if (bars.length < MIN_BARS_FOR_REGIME) return [];

  if (await ctx.hasOpenPosition(symbol, barTime)) return [];

  const regime = classifyRegime(bars);
  const session = classifySession(barTime);
  // Bar-level, not per-strategy -- every strategy attempted on this bar
  // shares the same rolling-session performance selection, so this is
  // computed once and reused across the loop below rather than re-fetched
  // per strategy. See scoring/sessionPerformance.ts.
  const sessionSelection = await ctx.sessionPerformanceSelection(barTime);

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

  // Fetched unconditionally, once per bar -- NOT gated on a strategy firing
  // or consensus being reached (2026-08-11 fix, operator question "where
  // does the report for each session get generated": the original
  // placement, inside `if (consensus.taken)` below, meant a session with no
  // qualifying signal at all never computed dealer levels, so
  // /api/dealer-levels stayed empty indefinitely. This is symbol-level
  // data, not per-strategy, so it's computed once here and reused across
  // the whole loop below -- same reasoning as sessionSelection above.
  // engine/dealerGexCache.ts is still session-scoped underneath, so this
  // costs a real CBOE fetch only on the first bar of each new session, not
  // every bar. The result itself is discarded beyond the degraded[] check --
  // it used to also feed risk/engine.ts's dealer-GEX proximity gate, removed
  // 2026-08-12 (operator request: trades should execute as long as they
  // clear their normal rules, without an additional GEX-distance
  // constraint). This call stays only for the /api/dealer-levels reporting
  // side effect.
  const dealerLevelResult = await ctx.dealerLevels(symbol, bars, barTime);
  if (dealerLevelResult === null) degraded.push("dealerLevels");

  // Symbol-level, not per-strategy -- same placement reasoning as
  // dealerLevelResult above. See DecisionContext.dailyPlanZones's own
  // comment for why this is never pushed to degraded[].
  const dailyPlanZones = await ctx.dailyPlanZones(symbol, barTime);
  // Session take-profit ceiling, injected for the same reasons as the zones
  // above (DB-free decision core, null in replay). Passed into assessNewTrade
  // below -- see DecisionContext.assistantTakeProfitCapPoints.
  const assistantTakeProfitCapPoints = await ctx.assistantTakeProfitCapPoints(symbol, barTime);

  // Bar-level, not per-symbol -- see DecisionContext.disabledStrategyIds's
  // own comment.
  const disabledStrategyIds = await ctx.disabledStrategyIds();
  // Finer-grained: this strategyId specifically on THIS symbol -- see
  // DecisionContext.disabledStrategySymbolPairs's own comment.
  const disabledStrategySymbolPairs = await ctx.disabledStrategySymbolPairs();

  const decisions: BarDecision[] = [];
  const executionSettings = ctx.executionSettings();

  for (const strategy of ALL_STRATEGIES) {
    if (disabledStrategyIds.has(strategy.strategyId)) continue;
    if (disabledStrategySymbolPairs.has(strategySymbolKey(strategy.strategyId, symbol))) continue;
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
      recentBars: bars,
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

    // v7 (2026-08-07, ruleScorerV7.ts) -- plain features in, points out, same
    // shape as v5. Shadow-only, same as v5/v6.
    const v7Gated = await evaluateSetup(features, "v7", barTime);
    gatedByVersion.set("v7", v7Gated);

    const consensus = determineConsensus(gatedByVersion, sessionSelection, session);

    let plan: BarDecision["plan"] = null;
    if (consensus.taken) {
      // One-shot smart entry positioning (2026-08-09, operator request,
      // replacing the removed Execution Decision Engine's resting-order/
      // re-rank machinery): rest at the last 6x5m candles' volume point of
      // control or VWAP instead of the raw signal price, whenever one offers
      // a genuine discount/premium -- see analytics/smartEntry.ts. Computed
      // BEFORE assessNewTrade (not after) so every downstream check --
      // S/R proximity, stop/target, sizing -- is consistent with the price
      // actually being entered at, not the stale signal price.
      const smartEntry = computeSmartEntryPrice(bars, signal.side, closePrice, atrValue, instrument.tickSize, signal.structureSwingPrice);

      // 2026-09-01, operator request: "ES and NQ should never enter into
      // conflicting trades" -- see risk/engine.ts's
      // hasConflictingCrossSymbolPosition param. Applies identically in
      // replay, same as every other check here.
      const hasConflictingCrossSymbolPosition = await ctx.hasConflictingPosition(symbol, signal.side, barTime);

      const assessment = new RiskEngine().assessNewTrade({
        side: signal.side,
        entryPrice: smartEntry.entryPrice,
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
        srProximityGateSuspended: isSrProximityGateSuspended(barTime),
        // 2026-08-18, operator request: this trade fired because v7 cleared
        // its own solo bar (determineConsensus's representativeVersion), not
        // because another version's own gate passed -- see risk/engine.ts's
        // srGateBypass for exactly what this skips. Applies identically in
        // replay, same as every other check here, so backtests stay honest
        // about what a v7-driven signal would actually have done live.
        srGateBypass: consensus.representativeVersion === "v7",
        // 2026-08-18, operator request -- see risk/engine.ts's
        // hardTakeProfitDollars param. Applies identically in replay, same
        // as srGateBypass above.
        hardTakeProfitDollars: HARD_TAKE_PROFIT_DOLLARS[symbol],
        // 2026-09-25, operator report: "still exceeding the tp point cap." It
        // was -- this call site never passed the cap, so every real strategy
        // signal was sized by the generic R-multiple path with no ceiling at
        // all (live trade 121: a 481.50pt target against a 73.33pt session
        // cap). Injected via DecisionContext so risk/ and this file stay
        // DB-free and so replay gets a null ceiling rather than a fabricated
        // one -- see that field's own comment.
        assistantTakeProfitCapPoints,
        // 2026-08-29, operator request -- see risk/engine.ts's
        // DailyPlanZone/classifyDailyPlanZone. Always [] in replay (see
        // DecisionContext.dailyPlanZones's own comment), so the normal
        // fail-open gate has no effect on any historical replay run.
        dailyPlanZones,
        // 2026-09-08, operator request -- see risk/engine.ts's requiresDailyPlan param and
        // risk/stops.ts's REQUIRE_DAILY_PLAN_SYMBOLS. UNLIKE dailyPlanZones above, this one DOES
        // have a real effect in replay: dailyPlanZones is always [] here, so a symbol in
        // REQUIRE_DAILY_PLAN_SYMBOLS is always blocked in a backtest too -- the honest reflection
        // of what live now does with no plan set, not a divergence between the two paths.
        requiresDailyPlan: REQUIRE_DAILY_PLAN_SYMBOLS.has(symbol),
        hasConflictingCrossSymbolPosition,
      });

      plan = { ...assessment, entryPrice: smartEntry.entryPrice, smartEntryBasis: smartEntry.basis, smartEntryReason: smartEntry.reason };
    }

    decisions.push({
      symbol, barTime,
      signal: {
        strategyId: signal.strategyId, side: signal.side, signalKind: signal.signalKind,
        structureSwingPrice: signal.structureSwingPrice, breakoutLevelPrice: signal.breakoutLevelPrice ?? null,
        explicitStopPrice: signal.explicitStopPrice ?? null, explicitTakeProfitPrice: signal.explicitTakeProfitPrice ?? null,
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
