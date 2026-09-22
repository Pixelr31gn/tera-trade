/**
 * Stop-loss, take-profit, and trailing-stop rules.
 *
 * Every position must have a stop before it can be opened -- enforced here
 * and again in risk/engine.ts's assessNewTrade, defense in depth. The initial
 * stop is whichever is *tighter* of a structure-based swing level and an ATR
 * multiple, so a strategy can't accidentally take on more risk than the ATR
 * model implies just because the last swing point was far away.
 */
import { Decimal } from "decimal.js";
import type { OhlcBar } from "../regime/indicators.js";

export interface StopPlan {
  stopPrice: Decimal;
  stopDistancePoints: Decimal;
  basis: "structure" | "atr" | "swing";
  takeProfitPrice: Decimal;
  trailTicks: number;
}

// Flat, hard point-based caps on stop/target distance (2026-08-06, operator
// request) -- MAX_STOP_DISTANCE_POINTS (5) and MAX_TAKE_PROFIT_DISTANCE_POINTS
// (15, widened from 10 on 2026-08-17). Removed entirely 2026-09-08 (operator
// instruction: "the 1:3 should be calculated based on the tp recommendation
// ... dont do a fixed 15pt to 5pt") -- a flat cap on each side independently
// pinned every capped-stop trade to almost exactly that same 5pt/15pt pair
// (15 = 3 x 5) regardless of what the real ATR/structure distance, a real
// S/R level, or a strategy's own explicit price actually called for, leaving
// no room for a real, wider recommendation to derive a proportionally wider
// (but still exactly-in-ratio) stop. Replaced by MIN_REWARD_RISK_RATIO below
// plus deriving whichever side (stop or target) isn't otherwise given from
// the one that is, everywhere in this system that used to reference either
// constant -- see computeInitialStop's own comment, and tradePlan.ts's
// explicit-stop/explicit-target derivation, for the two places this mattered
// most. No replacement absolute ceiling was added: real ATR/structure
// distances observed in this system are far below any point where an
// unbounded stop would be a practical concern on its own.
//
// risk/engine.ts's hardTakeProfitDollars branch (hasDailyPlanRange case) had
// its own separate zone-boundary-anchored stop and a matching 35pt width cap
// here (MAX_DAILY_PLAN_RANGE_STOP_POINTS, added 2026-09-03 after real stops
// up to 152pts) -- both retired 2026-09-09 (operator instruction: "the stop
// loss is supposed to be set based on the tp not where the daily-plan
// resistance boundary sits ... sl need to be adjusted based on 1/3rd of how
// many points the tp is set to"), after that zone-anchored stop blocked a
// fully-agreeing v1/v2/v3/v7 NQ short outright at 76.25pts against a
// same-session 50pt assistant take-profit read. That branch now derives its
// stop from MIN_REWARD_RISK_RATIO below, same as everywhere else in this
// file, so a separate cap is no longer needed there either.

// Minimum reward:risk ratio enforced on every live trade's FINAL stop/target,
// regardless of which branch/mode computed them (2026-09-08, operator
// instruction: "keep the sl at 1:3 of the reward always or less never more
// what so ever ... the goal is to always manage our risk so we can maintain
// a profitable edge", then, on seeing the fixed-15pt/5pt-pair side effect:
// "the 1:3 should be calculated based on the tp recommendation ... dont do a
// fixed 15pt to 5pt"). Two mechanisms now enforce this, split by whether the
// stop is a generic/derivable one or a real, independently-structural one:
//   - Generic case (ATR/structure, swing, either side of an explicit
//     stop/target left unspecified, or the hardTakeProfitDollars branch's
//     take-profit-first stop): the OTHER side is DERIVED at exactly this
//     ratio -- see computeInitialStop's own comment, tradePlan.ts's
//     explicit-stop/explicit-target derivation, and risk/engine.ts's
//     S/R-level target-override and hardTakeProfitDollars branch (both
//     derive the stop from the target this way as of 2026-09-09). Satisfied
//     by construction, nothing to check.
//   - Structural case (a strategy's own explicit BOTH stop and target, real
//     and independent of each other): checked here, at the very end of
//     risk/engine.ts's assessNewTrade, against whatever stop/target the
//     trade actually ends up with. Rejected outright when violated, same
//     "reject rather than distort" posture used everywhere else in this
//     file -- moving either price after the fact to force the ratio would
//     produce a stop/target that no longer reflects the real structure it
//     was anchored to.
// Related to, but the opposite direction of, tradePlan.ts's
// MIN_RISK_REWARD_DENOMINATOR (which floors risk at reward/3, i.e. caps
// reward:risk at 3:1, guarding against a stop too TIGHT to survive noise
// before reaching a big fixed-dollar target) -- the two coincide exactly at
// 3:1, and together pin every trade's reward:risk to precisely 3:1 whenever
// both are in play. In practice only this constant is live today
// (MIN_RISK_REWARD_DENOMINATOR's branch is dormant -- no account has a
// fixed-dollar profitDollars configured).
export const MIN_REWARD_RISK_RATIO = new Decimal("3");

// Swing-based stop/target sizing (2026-08-17, operator request, final
// version -- supersedes an earlier same-day iteration that sized off the
// average high-low range of the last 5 real 15-minute candles instead; that
// version is gone, not left dormant). Stop = the real swing low (long) / high
// (short) of the last SWING_CANDLE_COUNT real 5-minute candles -- an actual
// recent structural level, not a distance formula. Target is scaled off that
// real stop distance -- see computeSwingBasedPlan's own comment for why (it
// used to be a flat point distance, unrelated to the stop; no longer).
const SWING_CANDLE_COUNT = 5;
const SWING_CANDLE_MINUTES = 5;

/** Groups ascending 1-minute bars into complete 5-minute candles (partial trailing buckets, e.g. a session's first 3 minutes, are dropped -- only real, fully-formed candles count as a "touch" of that range). */
function aggregateToFiveMinuteCandles(bars: OhlcBar[]): OhlcBar[] {
  const bucketMs = SWING_CANDLE_MINUTES * 60 * 1000;
  const buckets = new Map<number, OhlcBar[]>();
  for (const bar of bars) {
    const bucketStart = Math.floor(bar.time.getTime() / bucketMs) * bucketMs;
    const group = buckets.get(bucketStart);
    if (group) group.push(bar);
    else buckets.set(bucketStart, [bar]);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([bucketStart, group]) => ({
      time: new Date(bucketStart),
      open: group[0]!.open,
      high: Math.max(...group.map((b) => b.high)),
      low: Math.min(...group.map((b) => b.low)),
      close: group[group.length - 1]!.close,
      volume: group.reduce((sum, b) => sum + b.volume, 0),
    }));
}

/**
 * Real swing-based stop off the last SWING_CANDLE_COUNT 5-minute candles, with the target scaled
 * off THAT real stop distance by takeProfitRMultiple -- null (never a nonsensical order) when
 * there isn't enough bar history yet, or the computed swing level would land on the wrong side of
 * entry (e.g. a long's "stop" above entry), same fallback trigger either way: the caller falls
 * back to ATR/structure sizing.
 *
 * Target used to be a flat FLAT_TAKE_PROFIT_POINTS (3.00) regardless of how far the real swing
 * stop sat (2026-08-17) -- removed 2026-09-08 (see MIN_REWARD_RISK_RATIO's comment below): a real
 * swing stop routinely runs wider than 3pts, which paired with that flat target produced exactly
 * the "stop far wider than the reward" pattern the operator flagged live (a real swing low several
 * points away against a flat 3pt target). The swing stop itself stays real/structural -- this only
 * changes what the target scales off of, same relationship every other stop basis already uses.
 */
function computeSwingBasedPlan(
  entryPrice: Decimal,
  side: "long" | "short",
  recentBars: OhlcBar[],
  takeProfitRMultiple: Decimal
): { stopPrice: Decimal; stopDistancePoints: Decimal; takeProfitPrice: Decimal } | null {
  const candles = aggregateToFiveMinuteCandles(recentBars);
  if (candles.length < SWING_CANDLE_COUNT) return null;
  const last5 = candles.slice(-SWING_CANDLE_COUNT);
  const stopPrice = side === "long" ? new Decimal(Math.min(...last5.map((c) => c.low))) : new Decimal(Math.max(...last5.map((c) => c.high)));
  if (side === "long" ? stopPrice.gte(entryPrice) : stopPrice.lte(entryPrice)) return null; // wrong side of entry -- not usable
  const stopDistancePoints = entryPrice.minus(stopPrice).abs();
  const takeProfitDistance = stopDistancePoints.times(takeProfitRMultiple);
  const takeProfitPrice = side === "long" ? entryPrice.plus(takeProfitDistance) : entryPrice.minus(takeProfitDistance);
  return { stopPrice, stopDistancePoints, takeProfitPrice };
}

export function computeInitialStop(
  entryPrice: Decimal,
  side: "long" | "short",
  atrValue: Decimal,
  structureSwingPrice: Decimal | null,
  opts: { atrMultiplier?: Decimal; takeProfitRMultiple?: Decimal; tickSize?: Decimal; chandelierAtrMultiplier?: Decimal; recentBars?: OhlcBar[] } = {}
): StopPlan {
  const atrMultiplier = opts.atrMultiplier ?? new Decimal("1.5");
  // 3.0 (not the more common 2.0) so the point-based target already satisfies
  // tradePlan.ts's MIN_RISK_REWARD_DENOMINATOR floor by construction -- see
  // that file's comment for why a fixed-dollar target decoupled from the
  // actual stop distance was dragging tight, structurally-correct stops out
  // to an arbitrary ~4-5pt distance whenever position size got capped.
  const takeProfitRMultiple = opts.takeProfitRMultiple ?? new Decimal("3.0");
  const tickSize = opts.tickSize ?? new Decimal("0.25");
  const chandelierAtrMultiplier = opts.chandelierAtrMultiplier ?? new Decimal("3.0");

  // Chandelier trail distance is a pure ATR read, unrelated to where the
  // initial stop/target sit -- computed once up front so the swing-based
  // early-return below still gets a real trailTicks value.
  const trailDistance = atrValue.times(chandelierAtrMultiplier);
  const trailTicks = tickSize.gt(0) ? Math.max(1, trailDistance.dividedBy(tickSize).floor().toNumber()) : 1;

  if (opts.recentBars) {
    const swingPlan = computeSwingBasedPlan(entryPrice, side, opts.recentBars, takeProfitRMultiple);
    if (swingPlan) {
      return {
        stopPrice: swingPlan.stopPrice,
        stopDistancePoints: swingPlan.stopDistancePoints,
        basis: "swing",
        takeProfitPrice: swingPlan.takeProfitPrice,
        trailTicks,
      };
    }
  }

  const atrStopDistance = atrValue.times(atrMultiplier);
  const atrStopPrice = side === "long" ? entryPrice.minus(atrStopDistance) : entryPrice.plus(atrStopDistance);

  let stopPrice: Decimal;
  let distance: Decimal;
  let basis: "structure" | "atr";

  if (structureSwingPrice !== null) {
    const structureDistance = entryPrice.minus(structureSwingPrice).abs();
    if (structureDistance.gt(0) && structureDistance.lt(atrStopDistance)) {
      stopPrice = structureSwingPrice;
      distance = structureDistance;
      basis = "structure";
    } else {
      stopPrice = atrStopPrice;
      distance = atrStopDistance;
      basis = "atr";
    }
  } else {
    stopPrice = atrStopPrice;
    distance = atrStopDistance;
    basis = "atr";
  }

  // MAX_STOP_DISTANCE_POINTS/MAX_TAKE_PROFIT_DISTANCE_POINTS independently
  // capped this stop and this target here until 2026-09-08 (operator
  // instruction: "the 1:3 should be calculated based on the tp
  // recommendation... dont do a fixed 15pt to 5pt"). Capping stop at a flat
  // 5pt regardless of the real ATR/structure distance, then separately
  // capping target at a flat 15pt, pinned every capped-stop trade to almost
  // exactly the same 5pt/15pt pair no matter what the real distance actually
  // called for -- a real level or a genuinely wider ATR read (NQ/GC
  // routinely run wider than ES) had no room to produce a proportionally
  // wider, still-compliant stop. Removed: the target is simply
  // distance x takeProfitRMultiple, unconditionally, so it's always exactly
  // in ratio with whatever the real structure/ATR distance turned out to be
  // -- see MIN_REWARD_RISK_RATIO (this file) for the live floor this
  // relationship is required to satisfy everywhere else in the system too.
  const takeProfitDistance = distance.times(takeProfitRMultiple);
  const takeProfitPrice = side === "long" ? entryPrice.plus(takeProfitDistance) : entryPrice.minus(takeProfitDistance);

  return { stopPrice, stopDistancePoints: distance, basis, takeProfitPrice, trailTicks };
}

// v1.3: fixed trailing-stop distance and activation threshold for the real
// (browser-controlled) broker -- a separate, simpler mechanism from the
// chandelier ATR trail above (which stays simulated-broker-only). Hand-set
// per operator request, not fitted/ATR-derived; once reached, a real
// broker-side Trailing Stop order (see brokers/types.ts's placeTrailingStop)
// takes over as the trade's downside protection, replacing the internal
// stop-price check in engine/loop.ts's manageLiveOpenTrade.
//
// 2026-09-21 (operator instruction: "the trailing stop loss should be set
// when the trade hits 65% of its tp goal"): raised from 0.5 to 0.65, so the
// real trailing order arms later and a trade has to earn more of its target
// before its structural stop is handed over to a trail.
export const TRAILING_STOP_ACTIVATION_FRACTION = 0.65;

// Fallback trailing-stop distance, in TICKS, for instruments with no
// trailingStopTickBand of their own (2026-09-09, operator instruction: "a
// trailing stop loss with 5 ticks should be applied when an execution hits
// half way to the target tp") -- superseded the previous flat-15-POINT
// distance (2026-08-18, converted to ticks per instrument via a
// since-removed helper).
//
// 2026-09-21: no longer used for NQ. A flat 5 ticks is 1.25 points on NQ,
// which is inside the bid/ask-and-noise band -- confirmed live the same day,
// when essentially every trade on the book exited `trailing_stop` almost
// immediately after arming, including one that gave back 36 points of an
// open winner and another that closed -$204. Instruments that DO still use
// this value keep the exact prior behavior; see
// resolveTrailingStopDistanceTicks.
export const TRAILING_STOP_DISTANCE_TICKS = 5;

// Fraction of current ATR used as the trailing distance for instruments with
// a trailingStopTickBand (marketData/instruments.ts). Half of ATR is a
// deliberately ordinary choice -- wide enough to sit outside routine
// two-way noise, tight enough to still be a trail rather than a second
// initial stop. The band does the real work of keeping the result sane.
export const TRAILING_STOP_ATR_FRACTION = new Decimal("0.5");

// Absolute floor, in ticks, for any banded trailing distance -- 2026-09-21
// operator instruction: NQ "should be at 20 ticks to 35 at the least never
// less than 15". Every current band's own minimum already clears this, so
// this is a standing invariant rather than an active clamp: it exists so
// that lowering a band minimum later cannot silently reintroduce a
// sub-noise trail. Deliberately NOT applied to TRAILING_STOP_DISTANCE_TICKS
// above, which is a different (smaller) regime for instruments the operator
// has not re-specified.
export const TRAILING_STOP_MIN_TICKS = 15;

/**
 * Trailing distance in ticks for `instrument` given the current `atrValue`
 * (in price points, from regime/indicators.ts's atr).
 *
 * Instruments with a `trailingStopTickBand` get TRAILING_STOP_ATR_FRACTION of
 * ATR converted to ticks and clamped into that band, then floored at
 * TRAILING_STOP_MIN_TICKS -- so a quiet tape trails at the band minimum, a
 * fast tape at its maximum, and neither can produce a distance that is
 * meaningless for the instrument. Everything else keeps the flat
 * TRAILING_STOP_DISTANCE_TICKS it already used.
 *
 * `atrValue` null (or non-positive, or a zero tickSize) means ATR could not
 * be computed -- resolves to the band MINIMUM rather than the flat fallback,
 * since for a banded instrument the fallback is the very value the band
 * exists to replace. Failing toward "a real trail we know is too wide" beats
 * failing toward "a trail we know is too tight": too wide gives back some
 * open profit, too tight closes the trade outright.
 */
export function resolveTrailingStopDistanceTicks(
  instrument: { tickSize: Decimal; trailingStopTickBand?: { minTicks: number; maxTicks: number } },
  atrValue: Decimal | null
): number {
  const band = instrument.trailingStopTickBand;
  if (!band) return TRAILING_STOP_DISTANCE_TICKS;

  if (atrValue === null || atrValue.lte(0) || instrument.tickSize.lte(0)) {
    return Math.max(band.minTicks, TRAILING_STOP_MIN_TICKS);
  }

  const atrTicks = atrValue.times(TRAILING_STOP_ATR_FRACTION).dividedBy(instrument.tickSize).round().toNumber();
  const withinBand = Math.min(Math.max(atrTicks, band.minTicks), band.maxTicks);
  // TRAILING_STOP_MIN_TICKS is applied LAST, deliberately: it outranks the
  // band's own ceiling, so a band configured entirely below the floor still
  // cannot produce a sub-floor trail. Folding it into the lower bound before
  // the maxTicks clamp instead let the clamp undo it -- caught by
  // tests/trailingStop.test.ts's floor-invariant case, which is the only
  // reason to write the two steps in this order rather than the obvious one.
  return Math.max(withinBand, TRAILING_STOP_MIN_TICKS);
}

// Flat take-profit override, per symbol, in raw PRICE POINTS -- not real P&L
// dollars via the instrument's point-value multiplier (2026-08-18, operator
// correction after an initial dollars/pointValue reading: "if NQ's at 30,000
// we want to take profit at 30,005" -- i.e. a flat +5 on the quoted price
// itself, the same units the entry/exit price is already in). Named
// "Dollars" for the operator's own phrasing ("five dollars from entry"), but
// treated as a point distance, matching the concrete example exactly: NQ
// 30,000 -> 30,005 is +5 on the price, not +5 real dollars (which would only
// be +2.5 points at NQ's $2/point value). When a symbol has an entry here,
// risk/engine.ts's assessNewTrade replaces its ENTIRE stop-loss/take-profit
// pipeline for that trade: no stop-loss is computed or sent to the broker at
// all (see NO_STOP_LOSS_SENTINEL_POINTS below for what actually gets
// persisted and why), and the take-profit is this flat point distance from
// entry -- not ATR/structure/swing/S/R/R-multiple derived. Symbols with no
// entry here are entirely unaffected and keep the existing sizing pipeline.
// Fallback only as of 2026-08-31 (see DAILY_PLAN_TAKE_PROFIT_FRACTION below)
// -- used when the assistant hasn't set a daily-plan take-profit estimate
// for a symbol yet this session (assistant/dailyPlanScheduler.ts hasn't run,
// or the session just started). Original 2026-08-18 values, unchanged.
export const HARD_TAKE_PROFIT_DOLLARS: Partial<Record<string, number>> = {
  NQ: 5,
  ES: 1,
};

// 2026-09-08 (operator report: daily-plan zones had gone unset for GC three
// separate sessions in a row -- see assistant/dailyPlanScheduler.ts's prompt
// fix the same day for the actual root cause, GC was never asked for -- and
// explicit instruction: "i dont want any trades taken for gc unless it has a
// daily trading plan"). Every OTHER symbol keeps the existing fail-open
// posture (no zones this session = evaluateDailyPlanRange's gate is a
// complete no-op, trade normally) -- this is a deliberate, symbol-scoped
// INVERSION of that default for GC specifically: no valid daily-plan range
// this session blocks GC outright, rather than letting it trade unrestricted.
// Resolved by the caller (same convention as HARD_TAKE_PROFIT_DOLLARS above)
// and passed into risk/engine.ts's assessNewTrade as requiresDailyPlan, which
// stays symbol-agnostic itself. Applies identically in replay (see
// replay/decisionCore.ts) -- replay's own DailyPlanZone posture is always
// empty zones (a live assistant toggle has no meaning for a historical
// replay date), so this correctly means GC never trades in a backtest
// either, which is the honest reflection of what the live system now does
// when nothing has set its plan, not a replay-only quirk.
export const REQUIRE_DAILY_PLAN_SYMBOLS = new Set<string>(["GC"]);

// 2026-08-31, operator request: "it shouldn't go for short profits, it
// should go for the best trade possible based on the trading range or
// direction but divided by 3" -- the flat 1pt(ES)/5pt(NQ) targets above were
// the "short profits" being pointed at. Replaced with a real, per-session
// target: the AI assistant now estimates the likely achievable point move
// for each symbol as part of building its daily plan (its own read of
// range/direction/dealer levels -- see assistant/dailyPlanScheduler.ts and
// prisma's DailyPlanTakeProfitTarget), and engine/dailyPlanTakeProfitCache.ts's
// resolveHardTakeProfitDollars takes this fraction of THAT estimate as the
// real target -- deliberately a system-owned constant applied consistently
// server-side, not a number the LLM computes itself each time (arithmetic
// an LLM does inconsistently is worse than arithmetic it doesn't have to
// do at all). 1/3 chosen as the starting value from the operator's own
// primary suggestion in the same request ("1/3rd... or even half") -- not
// backtested, watch real results and move toward 1/2 if 1/3 proves too
// conservative to ever get reached before the session's read stops holding.
export const DAILY_PLAN_TAKE_PROFIT_FRACTION = new Decimal(1).dividedBy(3);

/** Resolves a HARD_TAKE_PROFIT_DOLLARS entry to the point distance actually used -- a flat point distance already (see this const's own comment), just floored to at least one tick as a sanity guard. */
export function resolveHardTakeProfitDistance(points: number, tickSize: Decimal): Decimal {
  return Decimal.max(new Decimal(points), tickSize);
}

// Sentinel "no real stop-loss" distance, in POINTS (2026-08-18, operator
// request: "remove stop loss constraints right now" -- explicitly confirmed
// as "no stop-loss at all," not merely a looser sizing formula). Trade.stopPrice
// is a NOT NULL database column, and BrowserControlBroker.placeOrder refuses
// to submit any order without a stopLossPrice -- both exist as real safety
// invariants the rest of this system assumes hold for every trade, and
// changing either is a much bigger change (schema migration; touches every
// consumer of Trade.stopPrice) than this request called for. This distance
// is wide enough that it will never realistically be hit by ES or NQ intraday
// (thousands of points, vs. a real ATR/structure stop typically in the
// single digits), satisfying both invariants technically while behaving as "no stop" in
// practice. Not a general-purpose value -- only used by the
// HARD_TAKE_PROFIT_DOLLARS override path above.
//
// Demoted to a fallback-only value (2026-08-31, operator request: "100k
// point is way too wide, we're setting it based on our levels for the day"
// -- said right after seeing three live HARD_TAKE_PROFIT_DOLLARS positions
// carrying this literal sentinel as their real broker-side stop). Still used
// exactly as before when this session's daily-plan range (risk/engine.ts's
// evaluateDailyPlanRange) hasn't been set yet for the symbol; once it has,
// the hardTakeProfitDollars branch derives a real stop from the take-profit
// target instead (MIN_REWARD_RISK_RATIO above) -- see that branch's own
// comment.
//
// Cut from 100,000 to 100 (2026-09-03, operator report: "the stop loss bug
// needs to be fixed it keeps setting fiction nubers... this stop isnt
// possible", then explicit instruction "it should be 100 or less never
// more"). The 100,000 value was never actually "wide" for these instruments
// -- it's LARGER than ES/NQ/GC's own price level, so entryPrice.minus(this)
// on a long always went negative (confirmed live: trades #233/#235/#236,
// e.g. NQ entry 29494.25 -> stored stop -70505.75). A negative price isn't
// "unreachable," it's invalid -- Decimal math accepted it silently with no
// bound check. 100 points is still far wider than any of these instruments'
// real intraday range, so it keeps behaving as "no real stop, rely on the
// take-profit target" in practice, while never being able to produce an
// invalid price for any instrument this system trades.
export const NO_STOP_LOSS_SENTINEL_POINTS = new Decimal("100");

/**
 * Re-anchors a stop/target pair onto a corrected entry price, preserving both
 * DISTANCES exactly. Same operation execution/engine.ts performs at entry with
 * its fillOffset, factored out here so the other place that corrects an entry
 * price can't forget it.
 *
 * 2026-09-21, operator instruction: "defently fix the stop_price and
 * take_profit_price issue until its resolved." engine/loop.ts corrects
 * Trade.entryPrice from TopstepX's own Trade History in two places (closeTrade
 * and reconcileBrokerFlatTrade, both via tryReadRealClosedTrade) and neither
 * touched stopPrice or takeProfitPrice. The entry moved and the bracket did
 * not, so the stored row's risk and reward silently drifted apart from the
 * distances the risk engine actually sized -- in proportion to the slippage.
 * Confirmed live the same session: closed trades reading 11.50/11.50 (1.00),
 * 33.00/32.25 (0.98) and 60.50/51.00 (0.84) risk:reward, while the one trade
 * still open and therefore un-rewritten read a clean 28.00/83.50 (2.98).
 *
 * Why this matters after the trade is already closed: these rows are what
 * every win-rate, expectancy and R-multiple number in the system is computed
 * from, including the per-version session stats that pick which scoring
 * version is allowed to trade (engine/loop.ts's session-best-version gate). A
 * row claiming a trade risked more than it could win misprices every one of
 * those, and it is also simply not what happened.
 *
 * Pure and total: a zero offset is a no-op, and a null target stays null.
 */
export function reanchorBracketToRealEntry(
  recordedEntryPrice: Decimal,
  realEntryPrice: Decimal,
  stopPrice: Decimal,
  takeProfitPrice: Decimal | null
): { stopPrice: Decimal; takeProfitPrice: Decimal | null; offset: Decimal } {
  const offset = realEntryPrice.minus(recordedEntryPrice);
  return {
    stopPrice: stopPrice.plus(offset),
    takeProfitPrice: takeProfitPrice === null ? null : takeProfitPrice.plus(offset),
    offset,
  };
}

// Rounds a computed stop/target price to a valid tick, away from entry
// (2026-08-29). Every stop/target price up to this point is built from
// Decimal arithmetic over ATR/structure/swing distances -- none of those
// inputs are tick quantities themselves, so the result routinely lands
// off-tick (confirmed live: 7723.2372249 on an ES stop, far more precision
// than a real price can have).
//
// Away from entry, not nearest-tick: tried nearest-tick first, and
// tests/tradePlan.test.ts caught the real failure mode -- a near-zero-ATR
// stop can widen to less than half a tick from entry, and nearest-tick
// rounding collapsed that straight onto the entry price itself (a
// zero-distance "stop," not a merely-imprecise one). Rounding away from
// entry instead can only ever *increase* the distance from the raw computed
// value, by at most half a tick, so it can never collapse onto or cross
// entry as long as the raw distance was positive. The dollar cost of that
// half-tick, worst case, is trivial relative to a real multi-point stop
// (e.g. $1.25 on one ES contract) -- cheap insurance against a genuinely
// invalid order, not a real change to the risk model.
//
// Confirmed live: TopstepX's broker (BrowserControlBroker) never sends a
// stop-loss price to the broker at all (see that file's own comment --
// protection is internal-only), and Tradesea's order ticket
// (browserControl/tradesea/orderTicket.ts) already defensively verifies its
// price fields landed within half a tick of what was requested, throwing
// rather than silently placing a naked position -- so this rounding is a
// correctness/hygiene fix for a real (if mostly cosmetic) off-tick-precision
// issue, not a fix for a broker-rejection failure mode that was actually
// observed happening.
export function roundAwayFromEntry(price: Decimal, entryPrice: Decimal, tickSize: Decimal): Decimal {
  if (tickSize.lte(0)) return price;
  return price.gte(entryPrice) ? price.toNearest(tickSize, Decimal.ROUND_CEIL) : price.toNearest(tickSize, Decimal.ROUND_FLOOR);
}

/** Has price reached TRAILING_STOP_ACTIVATION_FRACTION of the way from entry to the take-profit target, in the trade's favor? */
export function hasReachedTrailingStopActivation(
  entryPrice: Decimal,
  takeProfitPrice: Decimal,
  side: "long" | "short",
  high: Decimal,
  low: Decimal
): boolean {
  const activationPrice = entryPrice.plus(takeProfitPrice.minus(entryPrice).times(TRAILING_STOP_ACTIVATION_FRACTION));
  return side === "long" ? high.gte(activationPrice) : low.lte(activationPrice);
}
