/**
 * Risk engine: the single gate every candidate trade must pass through.
 *
 * Order of checks (fail fast, cheapest/most-important first):
 * 0. ES/NQ cross-symbol conflict (2026-09-01, operator request) -- a
 *    correlated instrument already holding an open position in the opposite
 *    direction blocks this trade outright, unconditionally, before anything
 *    else below even runs. See hasConflictingCrossSymbolPosition's own
 *    comment.
 * 1. Circuit breakers (daily loss, trailing drawdown, consecutive losses,
 *    daily trade cap) are still COMPUTED but no longer block a trade or trip
 *    the kill switch (2026-08-17, operator request, confirmed explicitly
 *    after being shown this removes real safety mechanisms on a live funded
 *    account: a setup that clears its scoring threshold should actually
 *    execute rather than being silently vetoed by account-level circuit
 *    breakers). See checkCircuitBreakers's own call below -- its
 *    reason/tripKillSwitch fields are simply never acted on anymore.
 * 2. Support/resistance validation -- a real, previously-touched level must
 *    exist nearby at all (see analytics/supportResistance.ts). The
 *    distance-from-that-level band (MAX/MIN_ENTRY_DISTANCE_ATR) is a
 *    separate sub-check and can be temporarily suspended via
 *    srProximityGateSuspended (2026-08-06, see that param's own comment) --
 *    the level-existence/touch-count requirement itself never is. This gate
 *    stays fully active and enforced regardless of (1) above.
 * 3. Daily-plan-zone gate (2026-08-29, operator request) -- entirely opt-in
 *    per symbol via the AI assistant's set_daily_plan_zones tool (empty for
 *    a symbol with no zones set this session = complete no-op). An entry outside
 *    every zone is either rejected outright ("hard") or size-penalized
 *    ("soft"), per whichever zone is nearest. See classifyDailyPlanZone.
 * 4. Stop-loss plan (structure vs ATR vs swing) -- no valid stop, no trade
 * 5. Position sizing from the stop distance -- if it sizes to zero contracts, no trade
 * 6. Stop-loss for the hardTakeProfitDollars branch (2026-09-09, operator
 *    instruction: "the stop loss is supposed to be set based on the tp ...
 *    sl need to be adjusted based on 1/3rd of how many points the tp is set
 *    to") -- take-profit is primary (the assistant's real per-session
 *    likely-move read, or the flat configured dollar distance with no
 *    daily-plan range yet) and the stop is always exactly take-profit /
 *    MIN_REWARD_RISK_RATIO, never anchored to the daily-plan zone boundary.
 *    Retires the 2026-09-03 zone-boundary-anchored stop and its separate
 *    35pt width cap (stops.ts's since-removed MAX_DAILY_PLAN_RANGE_STOP_POINTS)
 *    -- a real incident the same day this changed showed the zone boundary
 *    was the wrong thing to size a stop off of at all: a fully-agreeing
 *    v1/v2/v3/v7 NQ short was blocked outright by a 76.25pt zone-anchored
 *    stop, even though the assistant's own real take-profit read for the
 *    session was only 50pts.
 *
 * The hard news-risk-window block that used to sit here (reject any trade
 * within N minutes of a high-impact event) has been removed -- news
 * proximity is meant to be predictive signal (how the market actually reacts
 * to a release), not a blanket blocker, so it no longer vetoes an
 * already-approved setup. newsStatus is still threaded through for scoring
 * to use (see scoring/ruleScorer.ts's newsRisk factor).
 */
import { Decimal } from "decimal.js";
import {
  computeSupportResistanceLevels,
  findLevelNearBreakout,
  findNearestRelevantLevel,
  findNearestTargetLevel,
  MIN_LEVEL_TOUCHES,
  type SrLevel,
} from "../analytics/supportResistance.js";
import type { NewsRiskStatus } from "../news/risk.js";
import type { OhlcBar } from "../regime/indicators.js";
import { checkCircuitBreakers, type AccountRiskState, type RiskLimitsConfig } from "./circuitBreakers.js";
import { computeConfidenceTierQuantity } from "./sizing.js";
// NO_STOP_LOSS_SENTINEL_POINTS and resolveHardTakeProfitDistance are no
// longer imported here: as of 2026-09-21 no path in this file produces a
// sentinel stop or a flat placeholder target (see the hardTakeProfitDollars
// branch's own comment). Both remain exported from stops.ts as the record of
// what that branch used to do, and as what to restore if the reward:risk
// floor is ever relaxed.
import { MIN_REWARD_RISK_RATIO, roundAwayFromEntry } from "./stops.js";
import { computeTradePlan } from "./tradePlan.js";

/**
 * Null when this trade's final stop/target clears MIN_REWARD_RISK_RATIO;
 * otherwise the rejection reason (2026-09-08, see MIN_REWARD_RISK_RATIO's
 * comment in stops.ts). One shared check point for both of assessNewTrade's
 * approved-with-a-real-stop return paths below, rather than duplicated logic
 * at each -- both need the exact same comparison against whatever stop/
 * target they ended up computing, from whichever source.
 */
function rewardRiskFloorViolation(stopDistancePoints: Decimal, takeProfitPrice: Decimal, entryPrice: Decimal): string | null {
  const takeProfitDistancePoints = takeProfitPrice.minus(entryPrice).abs();
  const minTakeProfitDistance = stopDistancePoints.times(MIN_REWARD_RISK_RATIO);
  if (takeProfitDistancePoints.gte(minTakeProfitDistance)) return null;
  return `stop (${stopDistancePoints.toFixed(2)} pts) is more than 1/${MIN_REWARD_RISK_RATIO.toString()} of the take-profit distance (${takeProfitDistancePoints.toFixed(2)} pts) -- needs at least ${MIN_REWARD_RISK_RATIO.toString()}:1 reward:risk`;
}

/**
 * Null when this stop/target risks strictly LESS than it stands to make;
 * otherwise the rejection reason.
 *
 * 2026-09-21, operator instruction stated as an absolute: "the risk has to be
 * smaller than what we are trying to win at all times no exceptions." This is
 * the last line rather than the main one -- rewardRiskFloorViolation above
 * enforces the real 3:1 policy, and every branch that derives one side from
 * the other satisfies that by construction. This exists because "by
 * construction" had quietly stopped being true on two paths at once, and a
 * ratio invariant that only holds where someone remembered to check it is not
 * an invariant.
 *
 * Deliberately 1:1, not MIN_REWARD_RISK_RATIO: it must never false-reject a
 * trade that construction already made compliant. roundAwayFromEntry widens
 * both the stop and the target to their own ticks independently, so a
 * correctly-built 3:1 plan can land a hair under 3.00 after rounding; it can
 * never land at or under 1.00. Also checks SIDE, since a target on the wrong
 * side of entry (a long whose take-profit sits below its fill -- seen on five
 * real trades this session) is the degenerate case of the same fault.
 */
function rewardBelowRiskViolation(entryPrice: Decimal, stopPrice: Decimal, takeProfitPrice: Decimal, side: "long" | "short"): string | null {
  const wrongSideTarget = side === "long" ? takeProfitPrice.lte(entryPrice) : takeProfitPrice.gte(entryPrice);
  if (wrongSideTarget) {
    return `take-profit (${takeProfitPrice.toFixed(2)}) is on the wrong side of entry (${entryPrice.toFixed(2)}) for a ${side}`;
  }
  const wrongSideStop = side === "long" ? stopPrice.gte(entryPrice) : stopPrice.lte(entryPrice);
  if (wrongSideStop) {
    return `stop (${stopPrice.toFixed(2)}) is on the wrong side of entry (${entryPrice.toFixed(2)}) for a ${side}`;
  }
  const risk = entryPrice.minus(stopPrice).abs();
  const reward = takeProfitPrice.minus(entryPrice).abs();
  if (reward.gt(risk)) return null;
  return `risk (${risk.toFixed(2)} pts) is not smaller than reward (${reward.toFixed(2)} pts) -- every trade must stand to make more than it risks`;
}

/**
 * A key price zone for one symbol, for one trading SESSION -- set by the AI
 * assistant's set_daily_plan_zones tool from its own daily-plan analysis
 * (2026-08-29, operator request: "only activate...strategies or
 * recommendations during those levels", later refined the same day to be
 * session-scoped rather than calendar-day-scoped: "is the daily plan going
 * to be timer based activated? by session times"). This is the pure,
 * Decimal-based shape assessNewTrade actually gates on; the DB row (prisma's
 * DailyPlanZone model) carries the extra id/symbol/sessionStart bookkeeping
 * that's the caller's job to resolve before this module ever sees it -- see
 * engine/dailyPlanZoneCache.ts.
 *
 * `enforcement` is a schema leftover from the original hard/soft
 * price-presence gate (see evaluateDailyPlanRange's header comment for why
 * that was replaced 2026-08-31) -- still accepted from the assistant's tool
 * call and still persisted, but no longer read by anything below. Kept
 * rather than migrated away to avoid an unforced DB/tool-schema change; a
 * future pass can drop it once nothing depends on the old shape.
 */
export interface DailyPlanZone {
  priceLow: Decimal;
  priceHigh: Decimal;
  enforcement: "hard" | "soft";
  label: string;
}

export interface DailyPlanRangeResult {
  mode: "none" | "blocked" | "breakout" | "fade";
  reason?: string;
  /** Only set when mode === "fade" -- the level-anchored stop, unrounded. */
  stopPrice?: Decimal;
  /** Only set when mode === "fade" -- the opposite boundary as target, unrounded. */
  takeProfitPrice?: Decimal;
  /**
   * The resolved support/resistance boundary zones, set whenever exactly two
   * valid (non-overlapping) zones exist for this symbol this session --
   * regardless of mode, including "none"/"blocked"/"breakout", not just
   * "fade". Lets a caller (risk/engine.ts's hardTakeProfitDollars branch) use
   * today's real levels for its own stop placement even on a trade this gate
   * itself doesn't otherwise touch.
   */
  support?: DailyPlanZone;
  resistance?: DailyPlanZone;
}

/**
 * Reads this session's daily-plan range (2026-08-31, operator request,
 * replacing the original 2026-08-29 hard/soft price-presence gate) --
 * real incident that day: the old gate treated "outside a hard zone" as a
 * single undifferentiated block, direction-blind. A confirmed NQ breakout
 * above its 29350-356 resistance kept getting a SHORT rejected as "outside a
 * hard zone" (correct, it was fighting the breakout) -- but the exact same
 * mechanism would have ALSO rejected a LONG at that same price, which the
 * breakout actually favored. Minutes later ES broke below its own
 * 7686-689 support and got a LONG rejected the identical way. The gate
 * couldn't tell "fighting the move" apart from "trading with it" because it
 * never looked at direction at all.
 *
 * New model, direct from the operator: exactly two zones per symbol this
 * session -- a support boundary and a resistance boundary (e.g. NQ's real
 * 29350-356 / 29480-502 range) -- and this function reads what a candidate
 * trade is actually doing at them:
 *   - Testing a level from inside its own band, trading the fade (short at
 *     resistance, long at support): allowed, with the stop placed beyond the
 *     level and the target at the opposite boundary -- both prices real and
 *     independent of each other (operator-confirmed 2026-08-31), taken as-is
 *     by computeTradePlan rather than one derived from the other (see
 *     tradePlan.ts's "both explicit" branch).
 *   - Testing a level fighting the fade (long into unbroken resistance,
 *     short into unbroken support): blocked -- neither the fade nor the
 *     breakout case describes it.
 *   - Confirmed break through a level, trading with it (long above a broken
 *     resistance, short below a broken support): allowed, normal
 *     ATR/structure stop and R-multiple target -- unchanged, this only gates
 *     direction.
 *   - Confirmed break fought (short below... no, short into a break that
 *     favors longs, or the reverse): blocked.
 *   - Strictly between the two boundaries, touching neither: unrestricted
 *     (operator-confirmed 2026-08-31) -- normal scoring/consensus decides,
 *     same as if this gate didn't exist.
 *
 * Requires EXACTLY two zones to activate at all -- with 0 or 1 zone there's
 * nothing to bracket a range with, and with 3+ there's no unambiguous way to
 * pick which two are "the" boundaries (a stale leftover zone from the old
 * model shouldn't silently become one), so this is a no-op in either case,
 * same fail-open posture as the empty-zones case always had. The assistant's
 * prompt (assistant/dailyPlanScheduler.ts) now asks for exactly two zones
 * per symbol going forward for this reason.
 */
export function evaluateDailyPlanRange(entryPrice: Decimal, side: "long" | "short", tickSize: Decimal, zones: DailyPlanZone[]): DailyPlanRangeResult {
  if (zones.length !== 2) return { mode: "none" };
  const a = zones[0]!;
  const b = zones[1]!;
  const support = a.priceLow.lte(b.priceLow) ? a : b;
  const resistance = support === a ? b : a;
  if (!support.priceHigh.lt(resistance.priceLow)) return { mode: "none" }; // overlapping/degenerate -- don't guess

  return { ...resolveDailyPlanRangeMode(entryPrice, side, tickSize, support, resistance), support, resistance };
}

function resolveDailyPlanRangeMode(
  entryPrice: Decimal,
  side: "long" | "short",
  tickSize: Decimal,
  support: DailyPlanZone,
  resistance: DailyPlanZone
): DailyPlanRangeResult {
  const testingResistance = entryPrice.gte(resistance.priceLow) && entryPrice.lte(resistance.priceHigh);
  const testingSupport = entryPrice.gte(support.priceLow) && entryPrice.lte(support.priceHigh);

  if (testingResistance) {
    if (side === "short") {
      return {
        mode: "fade",
        reason: `fading resistance "${resistance.label}" (${resistance.priceLow.toFixed(2)}-${resistance.priceHigh.toFixed(2)}) -- stop beyond it, target toward support "${support.label}" (${support.priceLow.toFixed(2)}-${support.priceHigh.toFixed(2)})`,
        stopPrice: resistance.priceHigh.plus(tickSize),
        takeProfitPrice: support.priceHigh,
      };
    }
    return {
      mode: "blocked",
      reason: `entry ${entryPrice.toFixed(2)} is a long testing unbroken resistance "${resistance.label}" (${resistance.priceLow.toFixed(2)}-${resistance.priceHigh.toFixed(2)}) -- only a short fade or a confirmed break above it is allowed here`,
    };
  }

  if (testingSupport) {
    if (side === "long") {
      return {
        mode: "fade",
        reason: `fading support "${support.label}" (${support.priceLow.toFixed(2)}-${support.priceHigh.toFixed(2)}) -- stop beyond it, target toward resistance "${resistance.label}" (${resistance.priceLow.toFixed(2)}-${resistance.priceHigh.toFixed(2)})`,
        stopPrice: support.priceLow.minus(tickSize),
        takeProfitPrice: resistance.priceLow,
      };
    }
    return {
      mode: "blocked",
      reason: `entry ${entryPrice.toFixed(2)} is a short testing unbroken support "${support.label}" (${support.priceLow.toFixed(2)}-${support.priceHigh.toFixed(2)}) -- only a long fade or a confirmed break below it is allowed here`,
    };
  }

  if (entryPrice.gt(resistance.priceHigh)) {
    if (side === "long") {
      return { mode: "breakout", reason: `confirmed break above resistance "${resistance.label}" (${resistance.priceLow.toFixed(2)}-${resistance.priceHigh.toFixed(2)}) favors longs` };
    }
    return {
      mode: "blocked",
      reason: `entry ${entryPrice.toFixed(2)} is a short fighting a confirmed break above resistance "${resistance.label}" (${resistance.priceLow.toFixed(2)}-${resistance.priceHigh.toFixed(2)})`,
    };
  }

  if (entryPrice.lt(support.priceLow)) {
    if (side === "short") {
      return { mode: "breakout", reason: `confirmed break below support "${support.label}" (${support.priceLow.toFixed(2)}-${support.priceHigh.toFixed(2)}) favors shorts` };
    }
    return {
      mode: "blocked",
      reason: `entry ${entryPrice.toFixed(2)} is a long fighting a confirmed break below support "${support.label}" (${support.priceLow.toFixed(2)}-${support.priceHigh.toFixed(2)})`,
    };
  }

  return { mode: "none" }; // strictly between the two boundaries -- unrestricted
}

export interface RiskAssessment {
  approved: boolean;
  quantity: number;
  stopPrice: Decimal | null;
  takeProfitPrice: Decimal | null;
  trailTicks: number | null;
  stopDistancePoints: Decimal | null;
  reason: string;
  tripKillSwitch: boolean;
  nearestSrLevel: SrLevel | null;
  /** The real S/R level the take-profit was set to (see the take-profit targeting block below) -- null when no such level existed and the generic R-multiple target was used instead. */
  targetSrLevel: SrLevel | null;
}

// How close an entry must be to the nearest relevant support/resistance
// level, in ATR units, to be allowed at all -- "close as possible," made
// concrete. Hand-set (not fitted): 0.5 ATR is already the level-clustering
// tolerance (see supportResistance.ts), so 1.0 ATR gives a little room
// around a level's own footprint without allowing an entry chosen mid-air
// far from any real pivot. (2026-07-20: loosened 25%, 1.0 -> 1.25, after
// several strong-trend setups were getting rejected for running slightly
// past this on continuous-scan signals. 2026-07-22: loosened again, 1.25 ->
// 1.9, operator request, after a sustained strong-trend session blocked
// essentially every continuous-scan signal on both ES and NQ -- entries were
// running 6-9x ATR past the nearest level, well beyond what the 25% bump
// covered. 2026-07-27: loosened again, 1.9 -> 3.0, operator request, same
// pattern recurring -- entries still getting blocked at ~2.9x ATR during a
// strong trend. 2026-07-28: removed entirely, operator request, then
// reinstated the same day at the same 1.25x-3.0x band. 2026-07-29: tightened
// back, 3.0 -> 1.95, operator request. 2026-08-01: scoped to reversal signals
// only -- this ceiling was being applied identically to breakout signals,
// which invert the premise: a reversal that's run far from the level it was
// supposed to bounce off really is stale, but a breakout is *supposed* to
// run away from the level it broke, and "too extended" is exactly the
// conviction a breakout strategy is trying to catch. Concrete evidence: a
// real ES short breakout (v1/v2/v3 all agreed, 68-97% confidence) was
// rejected three times as the move strengthened -- 1.00x -> 2.05x -> 3.88x
// ATR past the broken level -- purely because this ceiling didn't
// distinguish breakout from reversal (see docs/BUILD_HISTORY.md's account of
// this incident). The touch-count validation and MIN_ENTRY_DISTANCE_ATR
// floor below still apply to breakouts; only this ceiling is now
// reversal-only. 2026-08-17: widened again, 1.95 -> 3.25, operator request,
// then tightened back the same day, 3.25 -> 2.75 -- final active band is
// 0.25x-2.75x ATR.
const MAX_ENTRY_DISTANCE_ATR = 2.75;

// Floor for the same check, added alongside the 2026-07-27 ceiling bump --
// entries sitting too close to the level itself are rejected too, not just
// ones that have run too far past it. Together these carve out a
// 0.25x-1.95x ATR "sweet spot" band instead of a single one-sided ceiling.
// (2026-07-29: loosened 1.25 -> 0.25, operator request.)
const MIN_ENTRY_DISTANCE_ATR = 0.25;

export class RiskEngine {
  assessNewTrade(params: {
    side: "long" | "short";
    entryPrice: Decimal;
    atrValue: Decimal;
    structureSwingPrice: Decimal | null;
    signalKind: "breakout" | "reversal";
    breakoutLevelPrice: Decimal | null;
    accountState: AccountRiskState;
    limits: RiskLimitsConfig;
    pointValue: Decimal;
    tickSize: Decimal;
    newsStatus: NewsRiskStatus;
    bars: OhlcBar[];
    /** Cross-version consensus average probability (0-1) -- see risk/tradePlan.ts's computeTradePlan. */
    averageProbability: number;
    /** Operator-adjustable (SystemState, see execution/mode.ts's setTakeProfitRMultiple) -- see this param's use below for the value's own history. */
    takeProfitRMultiple: Decimal;
    /** Operator-adjustable (SystemState, see execution/mode.ts's setConfidenceTiers). */
    confidenceTiers: [minAverageProbability: number, quantity: number][];
    /** Strategy-provided explicit stop/target -- see strategy/types.ts's Signal.explicitStopPrice/explicitTakeProfitPrice and risk/tradePlan.ts's computeTradePlan for how this overrides the generic stop/target. */
    explicitStopPrice?: Decimal;
    explicitTakeProfitPrice?: Decimal;
    /**
     * 2026-08-06 (operator request, 24h-boxed): skips both the
     * MAX_ENTRY_DISTANCE_ATR ceiling and MIN_ENTRY_DISTANCE_ATR floor checks
     * below -- the S/R *validation* requirement (a real 2+-touch level must
     * still exist nearby at all, see MIN_LEVEL_TOUCHES above) is unchanged,
     * only the distance-from-it band is suspended. This module stays pure
     * (no Date/Date.now() in risk/, see CLAUDE.md) -- the expiry check
     * itself lives in the caller (engine/loop.ts's
     * isSrProximityGateSuspended), which passes the already-computed
     * boolean in here. Defaults to false so every existing call site
     * (including replay) is unaffected unless it explicitly opts in.
     */
    srProximityGateSuspended?: boolean;
    /**
     * 2026-08-18 (operator request: "all v7 taken not executed should be
     * executed"): skips the ENTIRE S/R block below -- the existence check
     * (a real level must be found at all), the breakout touch-count check,
     * AND the distance-band check srProximityGateSuspended already covers.
     * Set true by callers when this trade's consensus was driven by v7
     * clearing its own solo bar (engine/loop.ts's determineConsensus,
     * representativeVersion === "v7") -- every other version's trades are
     * unaffected and still go through the full gate. `nearest` is still
     * computed below regardless (and still reported back via
     * nearestSrLevel when one exists) -- this only stops it from ever
     * blocking the trade. Defaults to false so every existing call site is
     * unaffected unless it explicitly opts in.
     */
    srGateBypass?: boolean;
    /**
     * 2026-08-18 (operator request: "remove stop loss constraints right now
     * set a hard take profit for five dollars from entry price on NQ and one
     * dollar from entry price on ES") -- when set, this trade's ENTIRE
     * stop-loss/take-profit pipeline below is replaced: no real stop-loss
     * (see risk/stops.ts's NO_STOP_LOSS_SENTINEL_POINTS for what's actually
     * persisted and why it isn't literally null), and the take-profit is
     * this flat dollar amount from entry via the instrument's own point
     * value, not ATR/structure/swing/S/R/R-multiple derived. Quantity comes
     * from the confidence tiers directly, no longer gated by a stop
     * distance (there isn't a real one). The S/R *entry* gate above (does a
     * real level exist nearby at all) is UNCHANGED by this -- it only
     * replaces stop/target sizing, not whether the entry itself is allowed.
     * Callers resolve this via risk/stops.ts's HARD_TAKE_PROFIT_DOLLARS,
     * keeping this module itself symbol-agnostic, same convention as
     * pointValue/tickSize above.
     */
    hardTakeProfitDollars?: number;
    /**
     * This session's real assistant-estimated take-profit read for this
     * symbol, in points -- DAILY_PLAN_TAKE_PROFIT_FRACTION of its likely-move
     * estimate, or null/undefined when the assistant hasn't set one yet this
     * session (see engine/dailyPlanTakeProfitCache.ts's
     * getAssistantTakeProfitCapPoints). Used below (2026-08-31 fix) as a CAP
     * on the hardTakeProfitDollars branch's R-multiple target -- never as the
     * target directly -- so a real daily-plan-range stop always gets a target
     * proportional to it, without demanding more than the assistant's own
     * honest read of today's realistic range.
     */
    assistantTakeProfitCapPoints?: Decimal | null;
    /**
     * Today's key price zones for this symbol, from the AI assistant's daily
     * plan (2026-08-29, see the DailyPlanZone interface above). Empty/absent
     * -- this gate is a complete no-op, same behavior as before this feature
     * existed. Resolved by the caller (engine/dailyPlanZoneCache.ts) and
     * passed in already-filtered to this symbol, same convention as
     * hardTakeProfitDollars above -- this module stays symbol-agnostic and
     * DB/Date-free.
     */
    dailyPlanZones?: DailyPlanZone[];
    /**
     * 2026-09-08 (operator request: "i dont want any trades taken for gc
     * unless it has a daily trading plan"). Inverts dailyPlanZones' own
     * fail-open default for THIS trade's symbol specifically -- when true, no
     * valid two-zone daily-plan range this session (dailyPlanRange.mode ===
     * "none") rejects the trade outright, instead of the normal no-op.
     * Resolved by the caller from risk/stops.ts's REQUIRE_DAILY_PLAN_SYMBOLS
     * (same convention as hardTakeProfitDollars above) -- this module stays
     * symbol-agnostic; it only ever sees a plain boolean. Defaults to false
     * so every existing call site is unaffected unless it explicitly opts in.
     */
    requiresDailyPlan?: boolean;
    /**
     * Is a correlated instrument (ES<->NQ) currently holding an open
     * position on the OPPOSITE side of this trade? Resolved by the caller
     * (engine/crossSymbolConflictCheck.ts live, DecisionContext.
     * hasConflictingPosition in replay) -- this module stays symbol-agnostic
     * and DB-free, same convention as hardTakeProfitDollars above. Defaults
     * to false so every existing call site is unaffected unless it
     * explicitly opts in. (2026-09-01, operator request: "ES and NQ should
     * never enter into conflicting trades" -- confirmed live, e.g. an open
     * NQ long simultaneous with an open ES short: a real long/short split on
     * two ~90%+ correlated index futures that amounts to betting against
     * yourself, not diversification.)
     */
    hasConflictingCrossSymbolPosition?: boolean;
  }): RiskAssessment {
    const { side, entryPrice, atrValue, structureSwingPrice, signalKind, breakoutLevelPrice, accountState, limits, pointValue, tickSize, bars, averageProbability, takeProfitRMultiple, confidenceTiers, explicitStopPrice, explicitTakeProfitPrice, srProximityGateSuspended = false, srGateBypass = false, hardTakeProfitDollars, assistantTakeProfitCapPoints, dailyPlanZones = [], requiresDailyPlan = false, hasConflictingCrossSymbolPosition = false } = params;

    // Checked first, before circuit breakers even -- a hard, unconditional
    // block that doesn't depend on anything computed below (2026-09-01, see
    // this method's hasConflictingCrossSymbolPosition param comment).
    if (hasConflictingCrossSymbolPosition) {
      return {
        approved: false, quantity: 0, stopPrice: null, takeProfitPrice: null, trailTicks: null, stopDistancePoints: null,
        reason: "blocked: a correlated instrument (ES/NQ) already has an open position in the opposite direction -- ES and NQ must never hold conflicting long/short positions at the same time",
        tripKillSwitch: false, nearestSrLevel: null, targetSrLevel: null,
      };
    }

    // Computed but no longer acted on (2026-08-17, see this class's header
    // comment) -- checkCircuitBreakers still runs so its account-state
    // inputs stay exercised/observable, but its allowed/reason/tripKillSwitch
    // fields no longer block this trade or trip the kill switch.
    checkCircuitBreakers(accountState, limits);

    const levels = computeSupportResistanceLevels(bars, entryPrice.toNumber(), atrValue.toNumber());

    // Breakout signals must be validated against the specific level they
    // broke, not the nearest same-direction level to current price -- see
    // Signal.signalKind's comment. Reversal/bounce signals keep the original
    // "enter near a level in the trade's favor" check.
    const nearest =
      signalKind === "breakout" && breakoutLevelPrice !== null
        ? findLevelNearBreakout(levels, breakoutLevelPrice.toNumber(), entryPrice.toNumber(), atrValue.toNumber())
        : findNearestRelevantLevel(levels, side, entryPrice.toNumber(), atrValue.toNumber());

    if (!srGateBypass) {
      if (!nearest) {
        return {
          approved: false, quantity: 0, stopPrice: null, takeProfitPrice: null, trailTicks: null, stopDistancePoints: null,
          reason:
            signalKind === "breakout"
              ? "no historical level found near the breakout point -- can't confirm this was a real, previously-tested level"
              : `no ${side === "long" ? "support" : "resistance"} level found nearby -- entries are only taken close to a real swing-pivot level`,
          tripKillSwitch: false, nearestSrLevel: null, targetSrLevel: null,
        };
      }
      if (signalKind === "breakout" && nearest.level.touches < MIN_LEVEL_TOUCHES) {
        return {
          approved: false, quantity: 0, stopPrice: null, takeProfitPrice: null, trailTicks: null, stopDistancePoints: null,
          reason: `breakout level (${nearest.level.price.toFixed(2)}) was only touched ${nearest.level.touches} time(s) -- not a validated support/resistance zone, needs at least ${MIN_LEVEL_TOUCHES}`,
          tripKillSwitch: false, nearestSrLevel: nearest.level, targetSrLevel: null,
        };
      }
      // Reversal-only: see MAX_ENTRY_DISTANCE_ATR's 2026-08-01 comment. A
      // breakout running far past the level it broke is the strategy working,
      // not a reason to reject it -- only a reversal signal stales out this way.
      // Both this and the floor below are skippable via srProximityGateSuspended
      // (2026-08-06, see that param's comment) -- the level-existence/touch-count
      // checks above still ran and still apply either way.
      if (!srProximityGateSuspended) {
        if (signalKind === "reversal" && nearest.distanceInAtr > MAX_ENTRY_DISTANCE_ATR) {
          return {
            approved: false, quantity: 0, stopPrice: null, takeProfitPrice: null, trailTicks: null, stopDistancePoints: null,
            reason: `entry is ${nearest.distanceInAtr.toFixed(2)}x ATR from the nearest ${nearest.level.type} level (${nearest.level.price.toFixed(2)}, ${nearest.level.touches} touches) -- needs to be within ${MAX_ENTRY_DISTANCE_ATR}x ATR`,
            tripKillSwitch: false, nearestSrLevel: nearest.level, targetSrLevel: null,
          };
        }
        if (nearest.distanceInAtr < MIN_ENTRY_DISTANCE_ATR) {
          return {
            approved: false, quantity: 0, stopPrice: null, takeProfitPrice: null, trailTicks: null, stopDistancePoints: null,
            reason: `entry is only ${nearest.distanceInAtr.toFixed(2)}x ATR from the nearest ${nearest.level.type} level (${nearest.level.price.toFixed(2)}, ${nearest.level.touches} touches) -- too close, needs to be at least ${MIN_ENTRY_DISTANCE_ATR}x ATR away`,
            tripKillSwitch: false, nearestSrLevel: nearest.level, targetSrLevel: null,
          };
        }
      }
    }

    // Daily-plan-zone gate (2026-08-29, redesigned 2026-08-31 -- see
    // evaluateDailyPlanRange's header comment for the incident that drove
    // the redesign and the new rule). Runs after the S/R existence/distance
    // checks above (an entry still needs a real, previously-touched level
    // nearby regardless of this) but before ANY stop/target/sizing branch
    // below, so it applies uniformly to the hard-dollar-target path and the
    // normal path alike.
    const dailyPlanRange = evaluateDailyPlanRange(entryPrice, side, tickSize, dailyPlanZones);
    // 2026-09-08: see requiresDailyPlan's own param comment -- a symbol-scoped inversion of the
    // normal fail-open default, checked right alongside "blocked" since both are the same class of
    // outcome (reject before any stop/target/sizing logic runs). Deliberately checks
    // support/resistance presence, NOT dailyPlanRange.mode === "none" -- mode is "none" both when
    // no valid zones exist AND when valid zones exist but price is simply sitting strictly
    // mid-range (the common case) -- see evaluateDailyPlanRange's own comment on support/
    // resistance being set "regardless of mode". Same hasDailyPlanRange check the
    // hardTakeProfitDollars branch below already uses for exactly this reason.
    const hasDailyPlanRange = dailyPlanRange.support !== undefined && dailyPlanRange.resistance !== undefined;
    if (requiresDailyPlan && !hasDailyPlanRange) {
      return {
        approved: false, quantity: 0, stopPrice: null, takeProfitPrice: null, trailTicks: null, stopDistancePoints: null,
        reason: "daily plan range: this symbol requires a daily-plan range to be set before it can trade, and none is set for this session",
        tripKillSwitch: false, nearestSrLevel: nearest?.level ?? null, targetSrLevel: null,
      };
    }
    if (dailyPlanRange.mode === "blocked") {
      return {
        approved: false, quantity: 0, stopPrice: null, takeProfitPrice: null, trailTicks: null, stopDistancePoints: null,
        reason: `daily plan range: ${dailyPlanRange.reason}`,
        tripKillSwitch: false, nearestSrLevel: nearest?.level ?? null, targetSrLevel: null,
      };
    }
    // A fade trade's stop/target are anchored to the range's own boundaries
    // -- a real zone needs a stop beyond it and a target at the opposite
    // one, not a generic distance. Setting BOTH explicitStopPrice and
    // explicitTakeProfitPrice routes this through computeTradePlan's
    // "both explicit -- taken as-is" branch (tradePlan.ts), same as a
    // strategy's own fully-specified setup -- neither price gets derived
    // from the other, since both are already real. Only applied when the
    // strategy itself hasn't already supplied its own explicit stop/target
    // -- same "more specific wins" precedence as every other override in
    // this file.
    const effectiveExplicitStopPrice =
      explicitStopPrice ?? (dailyPlanRange.mode === "fade" ? roundAwayFromEntry(dailyPlanRange.stopPrice!, entryPrice, tickSize) : undefined);
    const effectiveExplicitTakeProfitPrice =
      explicitTakeProfitPrice ?? (dailyPlanRange.mode === "fade" ? roundAwayFromEntry(dailyPlanRange.takeProfitPrice!, entryPrice, tickSize) : undefined);

    // Hard-dollar take-profit override (2026-08-18, see this method's
    // hardTakeProfitDollars param comment) -- entirely replaces the
    // stop-loss/take-profit/sizing pipeline below for a configured symbol.
    // Returns directly; none of the ATR/structure/swing sizing, S/R
    // target-override, or reward:risk floor logic below applies to this
    // trade at all.
    //
    // Stop-loss (2026-08-31, operator request: "100k point is way too wide,
    // we're setting it based on our levels for the day") -- when this
    // session's daily-plan range is resolvable for this symbol (see
    // evaluateDailyPlanRange), the stop sits just beyond the boundary this
    // trade's own direction is anchored to: a long's stop goes below the
    // support boundary, a short's goes above the resistance boundary --
    // real, structural room instead of an arbitrary distance. Falls back to
    // NO_STOP_LOSS_SENTINEL_POINTS (the original 2026-08-18 "no real
    // stop-loss" behavior) only when no daily-plan range exists yet for this
    // symbol this session (0, 1, or 3+ zones) -- same fail-open posture as
    // every other daily-plan-range case, not a silent behavior change for a
    // session that hasn't had its levels set.
    // 2026-09-21, operator instruction, stated as an absolute: "the risk has
    // to be smaller than what we are trying to win at all times no
    // exceptions ... we have been willing to lose more than we are willing
    // to win." This branch was the only place in the system that violated
    // that, and it did so in two different ways, both confirmed live the
    // same day:
    //
    //   - With a daily-plan range but no assistant likely-move read, the
    //     target fell back to HARD_TAKE_PROFIT_DOLLARS (NQ 5, ES 1) and the
    //     stop was then derived as target/MIN_REWARD_RISK_RATIO -- a 5.00pt
    //     target against a 1.75pt stop on NQ. Correct 1:3 on paper, an
    //     untradeable trade in practice; it fired on five real trades.
    //
    //   - With NO daily-plan range, the path below used a
    //     NO_STOP_LOSS_SENTINEL_POINTS (100) stop against that same flat
    //     5pt target: 100 points of risk for 5 points of reward, 1:0.05.
    //     That was deliberate (the 2026-08-18 "remove stop loss
    //     constraints" request, kept because the path measured net +$2497
    //     across 127 trades) and is exactly the behavior the operator has
    //     now ruled out. Retired rather than tuned: the instruction above
    //     admits no ratio below 1:1, let alone 20:1 against us.
    //
    // So this branch is now entered ONLY when a real per-session likely-move
    // read exists to size the target from. Without one there is nothing
    // honest to scale against, and the trade falls through to the ordinary
    // ATR/structure/swing pipeline below -- which derives its target as
    // stopDistance x takeProfitRMultiple and therefore satisfies the ratio
    // by construction, with real structural distances instead of a
    // placeholder. HARD_TAKE_PROFIT_DOLLARS and NO_STOP_LOSS_SENTINEL_POINTS
    // are both left in place, unused by this path, since they are still the
    // documented record of what this branch used to do.
    if (hardTakeProfitDollars !== undefined && assistantTakeProfitCapPoints != null) {
      const quantity = computeConfidenceTierQuantity(averageProbability, limits.maxPositionSize, confidenceTiers);

      // 2026-09-09, operator instruction: "the stop loss is supposed to be
      // set based on the tp not where the daily-plan resistance boundary
      // sits ... sl need to be adjusted based on 1/3rd of how many points
      // the tp is set to". Retires the 2026-08-31/2026-09-03 design (stop
      // anchored to the daily-plan zone boundary, target then scaled off
      // THAT stop via takeProfitRMultiple, width-capped at stops.ts's
      // since-removed MAX_DAILY_PLAN_RANGE_STOP_POINTS) -- confirmed live the
      // same day this changed that the old design produced exactly the
      // failure the operator flagged: a fully-agreeing v1/v2/v3/v7 NQ short
      // blocked outright because the zone-anchored stop worked out to
      // 76.25pts, even though the assistant's own real take-profit read for
      // the session (assistantTakeProfitCapPoints) was only 50pts. Target is
      // now that same real per-session read when the assistant has set one,
      // else the flat configured hard-dollar distance (unchanged fallback,
      // same as the original 2026-08-18 behavior) when it hasn't -- and the
      // stop is always exactly target/MIN_REWARD_RISK_RATIO, satisfying the
      // reward:risk floor by construction (same reasoning as the S/R-level-
      // derived stop further down this file), so neither a separate width
      // cap nor an end-of-branch floor check is needed here anymore.
      if (hasDailyPlanRange) {
        // No `?? resolveHardTakeProfitDistance(...)` any more -- the branch
        // condition above guarantees a real read exists, and that fallback
        // was the 5pt target behind the 1.75pt stop.
        const targetDistance = assistantTakeProfitCapPoints;
        const takeProfitPrice = roundAwayFromEntry(side === "long" ? entryPrice.plus(targetDistance) : entryPrice.minus(targetDistance), entryPrice, tickSize);
        const stopDistancePoints = targetDistance.dividedBy(MIN_REWARD_RISK_RATIO);
        const stopPrice = roundAwayFromEntry(side === "long" ? entryPrice.minus(stopDistancePoints) : entryPrice.plus(stopDistancePoints), entryPrice, tickSize);
        const targetReason = `take-profit set to the assistant's session likely-move read (${targetDistance.toFixed(2)} pts)`;
        const inversion = rewardBelowRiskViolation(entryPrice, stopPrice, takeProfitPrice, side);
        if (inversion) {
          return {
            approved: false, quantity: 0, stopPrice: null, takeProfitPrice: null, trailTicks: null, stopDistancePoints: null,
            reason: `reward:risk invariant: ${inversion}`,
            tripKillSwitch: false, nearestSrLevel: nearest?.level ?? null, targetSrLevel: null,
          };
        }
        return {
          approved: quantity > 0,
          quantity,
          stopPrice,
          takeProfitPrice,
          trailTicks: null,
          stopDistancePoints,
          reason: `${targetReason}, stop derived at 1/${MIN_REWARD_RISK_RATIO.toString()} of that distance (${stopDistancePoints.toFixed(2)} pts) -- confidence tier: ${Math.round(averageProbability * 100)}% avg -> ${quantity} contract(s)`,
          tripKillSwitch: false,
          nearestSrLevel: nearest?.level ?? null,
          targetSrLevel: null,
        };
      }

      // No daily-plan range set yet this session, but a real assistant
      // likely-move read DOES exist (guaranteed by this branch's own
      // condition) -- so the geometry is identical to the hasDailyPlanRange
      // case above: target from that read, stop at 1/MIN_REWARD_RISK_RATIO
      // of it. The zones only ever gated WHICH trades may run, never how
      // far the stop sat, so there is no reason for their absence to change
      // the stop/target relationship.
      //
      // Replaces the original 2026-08-18 pairing of a
      // NO_STOP_LOSS_SENTINEL_POINTS (100pt) stop with a flat
      // HARD_TAKE_PROFIT_DOLLARS target -- 100 points of risk against 5 of
      // reward. That pairing measured net +$2497 across 127 trades and was
      // kept for that reason; it is retired here only because the
      // 2026-09-21 instruction at the top of this branch rules out ANY
      // trade risking more than it stands to make. If that ratio floor is
      // ever relaxed, this is the behavior to restore, and both constants
      // are still exported for it.
      const targetDistance = assistantTakeProfitCapPoints;
      const takeProfitPrice = roundAwayFromEntry(side === "long" ? entryPrice.plus(targetDistance) : entryPrice.minus(targetDistance), entryPrice, tickSize);
      const stopDistancePoints = targetDistance.dividedBy(MIN_REWARD_RISK_RATIO);
      const stopPrice = roundAwayFromEntry(side === "long" ? entryPrice.minus(stopDistancePoints) : entryPrice.plus(stopDistancePoints), entryPrice, tickSize);
      const inversion = rewardBelowRiskViolation(entryPrice, stopPrice, takeProfitPrice, side);
      if (inversion) {
        return {
          approved: false, quantity: 0, stopPrice: null, takeProfitPrice: null, trailTicks: null, stopDistancePoints: null,
          reason: `reward:risk invariant: ${inversion}`,
          tripKillSwitch: false, nearestSrLevel: nearest?.level ?? null, targetSrLevel: null,
        };
      }
      return {
        approved: quantity > 0,
        quantity,
        stopPrice,
        takeProfitPrice,
        trailTicks: null,
        stopDistancePoints,
        reason: `take-profit set to the assistant's session likely-move read (${targetDistance.toFixed(2)} pts), stop derived at 1/${MIN_REWARD_RISK_RATIO.toString()} of that distance (${stopDistancePoints.toFixed(2)} pts) -- no daily-plan range set for this symbol yet, so the range gate is a no-op, but the stop/target relationship is unchanged -- confidence tier: ${Math.round(averageProbability * 100)}% avg -> ${quantity} contract(s)`,
        tripKillSwitch: false,
        nearestSrLevel: nearest?.level ?? null,
        targetSrLevel: null,
      };
    }

    // Fixed-dollar risk overrides percentage-of-equity when configured, so
    // the risk budget stays constant regardless of intraday equity swings.
    const riskAmount = limits.perTradeRiskDollars ?? accountState.currentEquity.times(limits.perTradeRiskPct).dividedBy(100);

    const plan = computeTradePlan({
      side, entryPrice, atrValue, structureSwingPrice, tickSize, pointValue,
      riskAmount, profitDollars: limits.perTradeProfitDollars ?? null, maxPositionSize: limits.maxPositionSize,
      averageProbability,
      // Was hardcoded 2:1 here (2026-07-29, operator request, effective the
      // same day v5 became a required gate on every real execution -- v5's
      // own backtested win rate, 28.1% as of that change, was measured
      // against stops.ts's 3:1 default, an easier target to miss than 2:1;
      // that number does NOT directly carry over to real 2:1 performance,
      // breakeven moves from ~25% to ~33.3%, so re-validate once enough
      // real/simulated-at-2:1 outcomes accumulate rather than assuming the
      // same edge holds). 2026-08-02: made operator-adjustable at runtime
      // instead (SystemState.takeProfitRMultiple) -- 2:1 remains the
      // seeded default (see the migration), so nothing changes until the
      // operator deliberately moves it.
      takeProfitRMultiple,
      confidenceTiers,
      explicitStopPrice: effectiveExplicitStopPrice,
      explicitTakeProfitPrice: effectiveExplicitTakeProfitPrice,
      bars,
    });

    // Take-profit target (2026-08-11, operator request): "every score's
    // stop/target should be based on where price is actually headed, not a
    // blind multiple." Overrides the plan's take-profit with the nearest
    // real, 2+-touch S/R level in the trade's favor (a long's target =
    // nearest resistance above price; a short's = nearest support below),
    // when one exists, instead of stopDistance x takeProfitRMultiple.
    // Applied as a post-processing override AFTER computeTradePlan runs
    // (rather than threaded through as explicitTakeProfitPrice) deliberately
    // -- an earlier version reused that parameter and it silently suppressed
    // the fixed-dollar profitDollars override above (tradePlan.ts skips that
    // branch whenever explicitTakeProfitPrice is set, which broke real,
    // unrelated tests). Falls back to whatever computeTradePlan already
    // produced (its own explicit/profitDollars/R-multiple precedence,
    // unaffected) when no real target-direction level exists at all, e.g. a
    // strong trend that's already run past every prior pivot -- same
    // fail-open posture as the dealer level gate above, missing data is not
    // a reason to block an otherwise-approved trade. A strategy's own
    // explicit target (Signal.explicitTakeProfitPrice) is checked first and
    // wins outright -- it's more specific to the exact setup than a generic
    // S/R lookup.
    //
    // 2026-09-08 (operator instruction: "the 1:3 should be calculated based
    // on the tp recommendation... dont do a fixed 15pt to 5pt"): the stop is
    // now DERIVED from a used level's real distance (level distance /
    // MIN_REWARD_RISK_RATIO), replacing plan's own ATR/structure-based stop,
    // rather than checking the level against that pre-existing stop and
    // rejecting/falling back when the pairing came up short. This retires
    // the whole reject-and-fall-back mechanism this comment used to describe
    // (2026-08-11's original 1/3-of-stop floor, tightened 2026-08-17 to a
    // real minimum reward:risk after real trades near ~0.36:1 R:R got
    // through anyway) -- a real level can no longer offer a "bad ratio" at
    // all once the stop is sized to match it, so every validated level found
    // gets used. The MAX_TAKE_PROFIT_DISTANCE_POINTS re-cap this comment
    // used to describe is gone too, for the same reason removed everywhere
    // else in this file: a flat ceiling here would silently reintroduce the
    // fixed-pair problem for any level further out than that number. No
    // separate minimum-distance floor replaces it -- a level close enough to
    // derive a very tight stop is a known, accepted trade-off of "tighter
    // is fine, wider than 1:3 never is," not a bug.
    const targetLevel = effectiveExplicitTakeProfitPrice === undefined ? findNearestTargetLevel(levels, side, entryPrice.toNumber()) : null;
    let takeProfitPrice = plan.takeProfitPrice;
    let stopPrice = plan.stopPrice;
    let stopDistancePoints = plan.stopDistancePoints;
    if (targetLevel !== null) {
      const levelDistance = new Decimal(targetLevel.price).minus(entryPrice).abs();
      takeProfitPrice = roundAwayFromEntry(side === "long" ? entryPrice.plus(levelDistance) : entryPrice.minus(levelDistance), entryPrice, tickSize);
      stopDistancePoints = levelDistance.dividedBy(MIN_REWARD_RISK_RATIO);
      stopPrice = roundAwayFromEntry(side === "long" ? entryPrice.minus(stopDistancePoints) : entryPrice.plus(stopDistancePoints), entryPrice, tickSize);
    }
    // Daily-plan take-profit CEILING, applied to whatever this branch ended up
    // with from any source -- generic ATR/swing R-multiple, an S/R level
    // override, or a strategy's own explicit target.
    //
    // 2026-09-25, operator report: "still exceeding the tp point cap." They
    // were. assistantTakeProfitCapPoints had only ever been read inside the
    // hardTakeProfitDollars branch above, and that branch is skipped for every
    // real strategy signal (decideOnBar passed the static
    // HARD_TAKE_PROFIT_DOLLARS constant and, until today, no cap at all). So
    // the session's own read of today's realistic range constrained almost
    // nothing: live trade 121 took a 481.50pt target -- 3x a 160.50pt stop --
    // against a 73.33pt cap, and trade 119 a 374.25pt target against the same.
    //
    // The stop is RE-DERIVED from the capped target rather than left alone,
    // and that is the whole point. Capping 481.50 to 73.33 while leaving a
    // 160.50pt stop would risk more than twice the reward -- the exact
    // inversion the operator ruled out absolutely on 2026-09-21 ("the risk has
    // to be smaller than what we are trying to win at all times no
    // exceptions"). Deriving stop = cap / MIN_REWARD_RISK_RATIO keeps 3:1 by
    // construction, and is the same operator-stated principle this file
    // already applies in the hardTakeProfitDollars and S/R-level branches
    // (2026-09-09: "sl need to be adjusted based on 1/3rd of how many points
    // the tp is set to").
    //
    // Fail-open on a null cap: no assistant read this session means no
    // ceiling, exactly as before, not a zero.
    let cappedByDailyPlan: Decimal | null = null;
    if (assistantTakeProfitCapPoints != null && assistantTakeProfitCapPoints.gt(0)) {
      const targetDistance = takeProfitPrice.minus(entryPrice).abs();
      if (targetDistance.gt(assistantTakeProfitCapPoints)) {
        cappedByDailyPlan = targetDistance;
        takeProfitPrice = roundAwayFromEntry(
          side === "long" ? entryPrice.plus(assistantTakeProfitCapPoints) : entryPrice.minus(assistantTakeProfitCapPoints),
          entryPrice,
          tickSize
        );
        // Rounded TOWARD entry, unlike every other stop in this file, and the
        // exception is load-bearing: cap / 3 is rarely tick-aligned, and
        // rounding a derived stop away from entry makes it fractionally WIDER,
        // which drops the ratio a hair under 3:1 and gets the trade rejected by
        // rewardRiskFloorViolation below on pure rounding. Caught by the
        // short-side test with a 5pt cap -- 5/3 = 1.666...7, and 3x that is
        // marginally more than the 5pt target. Rounding toward entry makes the
        // stop marginally tighter instead, so the floor can only be satisfied.
        // Consistent with stops.ts's stated posture for derived stops:
        // "tighter is fine, wider than 1:3 never is."
        const rawStop = side === "long"
          ? entryPrice.minus(assistantTakeProfitCapPoints.dividedBy(MIN_REWARD_RISK_RATIO))
          : entryPrice.plus(assistantTakeProfitCapPoints.dividedBy(MIN_REWARD_RISK_RATIO));
        stopPrice = side === "long" ? rawStop.toNearest(tickSize, Decimal.ROUND_CEIL) : rawStop.toNearest(tickSize, Decimal.ROUND_FLOOR);
        // Recomputed from the ROUNDED price so the reported distance is the one
        // actually in force, not the pre-rounding ideal.
        stopDistancePoints = entryPrice.minus(stopPrice).abs();
      }
    }
    const dailyPlanCapReason =
      cappedByDailyPlan !== null
        ? `; take-profit capped at the assistant's session likely-move read (${assistantTakeProfitCapPoints!.toFixed(2)} pts, down from ${cappedByDailyPlan.toFixed(2)}), stop re-derived at 1/${MIN_REWARD_RISK_RATIO.toString()} of it (${stopDistancePoints.toFixed(2)} pts)`
        : "";

    const usedTargetLevel = targetLevel;
    const dailyPlanRangeReason = dailyPlanRange.mode === "fade" || dailyPlanRange.mode === "breakout" ? `; daily plan range: ${dailyPlanRange.reason}` : "";

    // 2026-09-08: reward:risk floor (see MIN_REWARD_RISK_RATIO's comment in
    // stops.ts) -- the backstop for the one source left in this branch that
    // has no ratio awareness of its own: a strategy's own explicit BOTH
    // stop and target (or fade-mode's own, both anchored to real daily-plan-
    // range boundaries this way -- see effectiveExplicitStopPrice/
    // effectiveExplicitTakeProfitPrice above), taken as-is rather than
    // derived, since overriding either of two prices a strategy specifically
    // chose would defeat the point of "explicit." Every other source
    // reaching this point (generic ATR/structure, swing, explicit-one-side,
    // or the S/R-level override just above) already satisfies this ratio
    // exactly by construction, so this mostly fires against that one
    // remaining case in practice.
    const rewardRiskViolation = rewardRiskFloorViolation(stopDistancePoints, takeProfitPrice, entryPrice);
    if (rewardRiskViolation) {
      return {
        approved: false, quantity: 0, stopPrice: null, takeProfitPrice: null, trailTicks: null, stopDistancePoints: null,
        reason: `reward:risk floor: ${rewardRiskViolation}`,
        tripKillSwitch: false, nearestSrLevel: nearest?.level ?? null, targetSrLevel: usedTargetLevel,
      };
    }

    return {
      approved: plan.quantity > 0,
      quantity: plan.quantity,
      stopPrice,
      takeProfitPrice,
      trailTicks: plan.trailTicks,
      stopDistancePoints,
      reason:
        (usedTargetLevel
          ? `${plan.sizingReason}; take-profit targets the nearest real ${usedTargetLevel.type} level (${usedTargetLevel.price.toFixed(2)}, ${usedTargetLevel.touches} touches), stop derived at 1/${MIN_REWARD_RISK_RATIO.toString()} of that distance (${stopDistancePoints.toFixed(2)} pts) instead of a generic R-multiple`
          : plan.sizingReason) + dailyPlanCapReason + dailyPlanRangeReason,
      tripKillSwitch: false,
      // nearest can be null here only when srGateBypass skipped the
      // existence check above entirely (e.g. no real level was ever found)
      // -- still report whatever WAS found, if anything.
      nearestSrLevel: nearest?.level ?? null,
      targetSrLevel: usedTargetLevel,
    };
  }
}
