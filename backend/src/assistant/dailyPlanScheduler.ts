/**
 * Automatically triggers the AI assistant to build and set fresh daily-plan
 * zones (see risk/engine.ts's DailyPlanZone) shortly BEFORE the start of each
 * trading session (New York/London/Asian -- analytics/session.ts), rather
 * than relying on someone remembering to ask in chat (2026-08-29 operator
 * request: "is the daily plan going to be timer based activated? by
 * session times"). Pre-triggered PRE_TRIGGER_WINDOW_MS ahead of the actual
 * boundary (2026-08-31 operator request: "better to trigger 5 minutes
 * before the session"; widened to 10 on 2026-09-21, "10 minutes before each
 * session a daily trading plan is made then set") so the new session's plan
 * is already in effect the instant it begins -- the original design waited
 * for the crossing and then
 * refreshed, leaving a real gap (up to POLL_INTERVAL_MS) where a brand-new
 * session traded with zero zones. Falls back to catching up an already-active
 * session that's still missing its plan (pre-trigger was missed -- backend
 * down, the actions gate was off, etc.), same as this scheduler always did.
 *
 * Deliberately fails toward "no zones" (a complete no-op on the gate),
 * never toward stale/wrong zones: getActiveDailyPlanZones is keyed by
 * session start (see dailyPlanZoneCache.ts), so a session that never got a
 * refresh -- backend down, Gemini erroring, the assistant/actions gate
 * off -- simply trades with zero zones, not last session's now-irrelevant
 * ones. This scheduler is purely opportunistic; it is never load-bearing
 * for correctness.
 *
 * Quota-aware by design (2026-08-30, operator report: the free Gemini tier
 * caps gemini-3.5-flash at 20 generateContent calls/DAY -- confirmed live,
 * exhausted entirely by manual testing the same day). Every functionCall
 * the assistant makes costs one full generateContent round-trip, same as a
 * genuinely new turn -- a plan built by exploring tool-by-tool (market
 * snapshot, then S/R, then dealer levels, then regime...) burns 6-8 calls
 * for ONE session refresh; with 3 sessions/day that alone exceeds the daily
 * cap before counting any manual chat use at all. The fix isn't a shorter
 * prompt (quota is per-REQUEST, not per-token) -- it's fetching everything
 * the assistant would otherwise ask for ITSELF, server-side, for free (see
 * buildContextDigest), and handing it over as plain text in one message.
 * That leaves the assistant needing only to reason and act: one turn to
 * call set_daily_plan_zones for both symbols (ideally as parallel
 * functionCall parts in a single turn, same as it already does for
 * independent read tools), one more to close out with a summary --
 * 2 calls per session, ~6/day for the scheduler, leaving real headroom for
 * manual chat.
 *
 * 2026-09-04 (operator request: "assistant should be ran through qwen now not
 * gemini"): switched from the hardcoded sendGeminiChatMessage to the
 * provider-routed sendChatMessage, so this scheduler now follows
 * ASSISTANT_PROVIDER (backend/.env already has this set to "ollama") like
 * every other caller instead of being the one remaining hardcoded exception.
 * client.ts's own forceProvider comment documents WHY this was hardcoded to
 * Gemini in the first place (2026-09-01: Ollama reproducibly failed to call
 * any tool for this exact prompt, 3 separate mitigation attempts, against
 * whatever model was configured then) -- that finding predates this
 * session's Qwen 3.6 setup, which reliably multi-tool-calls in real testing
 * done the same day this was changed (Scout's own tool loop, not this exact
 * prompt). If it turns out Qwen still can't reliably tool-call for THIS
 * specific prompt, the fail-safe above still holds: worst case is zero
 * zones for a session, never stale/wrong ones -- revert this one import/call
 * back to sendGeminiChatMessage if that's ever observed.
 *
 * 2026-09-24: no longer goes through client.ts at all. attemptRefresh now
 * calls statelessTurn.ts's runStatelessAssistantTurn, which keeps the same
 * ASSISTANT_PROVIDER routing and the same Ollama-falls-back-to-Gemini
 * behaviour but persists no conversation history -- see that file's header for
 * the input-token deadlock that made history fatal here. Everything the
 * paragraph above says about provider selection still applies; only the
 * transcript is gone.
 */
import { getSessionStart, getSessionEnd } from "../analytics/session.js";
import { getSettings } from "../core/config.js";
import { getSystemState } from "../execution/mode.js";
import { listActiveDailyPlanZones } from "../engine/dailyPlanZoneCache.js";
import { setDailyPlanSessionOverride } from "../engine/dailyPlanSessionOverride.js";
import { getMarketSnapshot, getSupportResistanceSnapshot } from "../api/routes/market.js";
import { getDealerLevelsSnapshot, getDealerLevelsReportSnapshot } from "../api/routes/dealerLevels.js";
import { getCurrentRegime } from "../api/routes/regime.js";
import { getSystemStateSnapshot } from "../api/routes/system.js";
import { getNewsRiskStatus } from "../news/risk.js";
import { cached, computeSessionPerformanceForAllSessions } from "../api/routes/analytics.js";
import { runStatelessAssistantTurn } from "./statelessTurn.js";
import { childLogger } from "../core/logger.js";

const logger = childLogger("dailyPlanScheduler");

// Session boundaries are hours apart, so this was 5 minutes for most of this
// scheduler's life -- "no need to poll tighter than this to catch a crossing
// promptly," which was true while PRE_TRIGGER_WINDOW_MS matched it.
//
// 2026-09-21 (operator request: "10 minutes before each session a daily
// trading plan is made then set"): tightened to 1 minute. The poll interval,
// not the window, is what actually determines WHEN inside the window the
// refresh lands -- the first tick to fall inside PRE_TRIGGER_WINDOW_MS wins,
// so a 5-minute poll against a 10-minute window would fire anywhere from 10
// to 5 minutes out, i.e. "10 minutes before" only by luck. At 1 minute the
// refresh reliably lands in [10:00, 9:00) before the boundary.
//
// Costs nothing real: a tick is one getSettings, one getSystemState and (only
// inside the window, or when the current session has no plan) one indexed
// zone lookup.
//
// It does not multiply Gemini usage either, but the reason changed on
// 2026-09-24. It used to be that lastHandledSessionStart was set the moment a
// refresh was ATTEMPTED, so there was exactly one attempt per session however
// often this ticked -- which also meant one transient 503 forfeited the whole
// session. Now handled means "confirmed to have zones" and a failed session
// stays retryable, so what bounds the call rate is mayAttemptSession's
// RETRY_INTERVAL_MS, not this interval.
export const POLL_INTERVAL_MS = 60 * 1000;
// One retry after a Gemini failure, matching the transient "high demand"
// 503s confirmed live (2026-08-29): failed twice, succeeded on the very
// next attempt, same session, no code change needed -- just a retry. (The
// actual generateContent call also retries internally now -- see
// client.ts's generateContentWithRetry -- this is the outer, whole-message
// fallback for when even those internal retries are exhausted.)
const RETRY_DELAY_MS = 15_000;

// Matches ACTIVE_INSTRUMENTS (marketData/instruments.ts) -- every symbol the
// daily-plan-zone gate actually applies to. ES/NQ have real dealer-gamma
// coverage; GC (added 2026-09-03) doesn't ("No CBOE index-options proxy
// configured for GC" -- dealerGexCache.ts) and will just come back empty in
// the digest below, same graceful-degradation posture as every other missing
// data source here -- the assistant leans on S/R pivots + regime for it
// instead.
const PLAN_SYMBOLS = ["ES", "NQ", "GC"];

function jsonFor(symbols: string[], bySymbol: Record<string, unknown> | unknown[]): unknown {
  if (Array.isArray(bySymbol)) return bySymbol.filter((row) => symbols.includes((row as { symbol?: string }).symbol ?? ""));
  return Object.fromEntries(Object.entries(bySymbol).filter(([symbol]) => symbols.includes(symbol)));
}

/**
 * Fetches everything a from-scratch daily-plan build would otherwise
 * discover via read-tool calls -- for free, server-side, zero Gemini quota
 * cost -- and formats it as one plain-text block. See this file's header
 * comment for why this exists.
 */
async function buildContextDigest(): Promise<string> {
  const [marketSnapshot, supportResistance, dealerLevels, dealerReport, regime, newsRisk, systemState, sessionPerformance] = await Promise.all([
    getMarketSnapshot(),
    getSupportResistanceSnapshot(),
    getDealerLevelsSnapshot(),
    getDealerLevelsReportSnapshot(),
    getCurrentRegime(),
    getNewsRiskStatus(),
    getSystemStateSnapshot(),
    cached("session-performance", () => computeSessionPerformanceForAllSessions()),
  ]);

  return [
    "## Market snapshot (ES/NQ)",
    JSON.stringify(jsonFor(PLAN_SYMBOLS, marketSnapshot), null, 2),
    "\n## Support/resistance levels (ES/NQ)",
    JSON.stringify(jsonFor(PLAN_SYMBOLS, supportResistance), null, 2),
    "\n## Dealer gamma levels (ES/NQ)",
    JSON.stringify(jsonFor(PLAN_SYMBOLS, dealerLevels), null, 2),
    "\n## Dealer gamma narrative report (ES/NQ)",
    JSON.stringify(jsonFor(PLAN_SYMBOLS, dealerReport), null, 2),
    "\n## Current regime classification (ES/NQ)",
    JSON.stringify(jsonFor(PLAN_SYMBOLS, regime), null, 2),
    "\n## News risk status",
    JSON.stringify(newsRisk, null, 2),
    "\n## Current system state, mode, and scoring settings",
    JSON.stringify(systemState, null, 2),
    "\n## Recent session performance by version (which strategy version is actually winning right now)",
    JSON.stringify(sessionPerformance, null, 2),
  ].join("\n");
}

function buildRefreshPrompt(digest: string): string {
  return `A new trading session has just started. This message is system-generated and unattended -- no operator is reading it in real time, so do not ask a clarifying question or wait for a reply; act on your best judgment from the data given.

You are acting as an experienced quant analyst with deep expertise in breakout dynamics and support/resistance structure. All the live data you need is already gathered below -- it is current as of right now. Do NOT call any read tool to re-fetch anything; everything you need is already in this message.

The daily-plan zones you set are read by a breakout/rejection gate, not a pin-price-inside-a-zone gate: you set exactly TWO zones per symbol -- a support boundary (the lower one) and a resistance boundary (the upper one) -- defining today's key range. From then on, in real time as price actually trades: a short fading the resistance boundary or a long fading the support boundary is allowed, with its stop placed beyond that boundary and its target at the opposite one; a confirmed break through either boundary allows a trade WITH that break (long above resistance, short below support) at normal sizing; a trade fighting a boundary it hasn't broken (a long testing unbroken resistance, a short testing unbroken support, or either side fighting a confirmed break the other way) is blocked; anything strictly between the two boundaries is unrestricted. You are not picking a direction now -- you're choosing the two levels whose reaction (hold vs. break) actually matters for the rest of this session.

Separately, for ES and NQ's fixed-target trades (the ones NOT gated by the zones above -- see set_daily_take_profit_target's own description), you also set today's likely-move estimate: your genuine, undiscounted read of how far price can realistically travel this session given the range and regime strength. Don't pre-shrink this number -- the system takes a conservative fraction of it automatically; give your real estimate, not an already-cautious one.

Do this in ONE turn, as parallel tool calls, not sequential turns, for ALL THREE symbols -- ES, NQ, AND GC. GC has no dealer-gamma coverage (that section of the digest below will be empty for it -- CBOE doesn't publish a usable options chain for it), so lean on its S/R pivot levels and regime reading instead; that's still enough to pick two real boundaries. GC is NOT optional here and has been missed before by only being covered in this instruction's first two symbols -- always include it as a third, equal symbol in every step below.
1. For ES, NQ, and GC, find the single most relevant support boundary and resistance boundary bracketing current price right now -- real, previously-touched structural levels (S/R pivots, dealer gamma walls where available), not arbitrary round numbers. Don't draw them too tight around current price (a 6-point pivot band is unrealistic to trade around cleanly) -- pick the two real levels that actually bound where price is likely to range this session, however wide that is. Also form your likely-move estimate for each symbol from this same read (session range width, ADX/regime strength, whether today looks like a ranging or trending day). Cross-check against the system's current scoring/mode settings included below (active strategy version, minScoreThreshold, recent per-version session performance) -- you don't need to report this reasoning back, just let it inform your picks.
2. Call set_daily_plan_zones once each for ES, NQ, and GC, AND set_daily_take_profit_target once each for ES, NQ, and GC -- all SIX as parallel functionCall parts in this SAME turn, not across separate turns. set_daily_plan_zones needs EXACTLY TWO zones in the array, shaped like the tool's schema (priceLow, priceHigh, enforcement, label). "enforcement" is no longer read as hard/soft by the gate (support/resistance role is inferred from price order, not this field) -- set it to "hard" for both zones and use "label" to say which boundary it is (e.g. "support boundary" / "resistance boundary") and what real level it's based on. Always call both tools for all three symbols, even if you're not fully confident in the exact numbers (GC included, even without dealer-gamma data) -- use your best judgment rather than skipping a call, since no one is available to answer a follow-up question, and GC currently has NO trades allowed at all without a plan set (see risk/engine.ts's evaluateDailyPlanRange).

Worked example (2026-09-03, Gemini agent, a real prior session -- shown ONLY
as a format/behavior reference: four parallel tool calls in one turn, no
prose in between, no clarifying question. The price levels below are that
DIFFERENT session's real numbers, not today's -- never reuse them; always
compute fresh levels from the CURRENT session's own data in this message.
NOTE, 2026-09-08: this example predates GC being required below -- it shows
ES/NQ only, but the identical pattern applies to GC as the third symbol; call
set_daily_plan_zones and set_daily_take_profit_target for GC too, in the same
turn, using S/R pivots since it has no dealer-gamma levels):

set_daily_plan_zones({"symbol": "ES", "zones": [
  {"priceLow": 7747.5, "priceHigh": 7751, "enforcement": "hard", "label": "support boundary (high-volume historical price-action pivot floor at 7749.25)"},
  {"priceLow": 7763, "priceHigh": 7766, "enforcement": "hard", "label": "resistance boundary (key local resistance pivot shelf at 7764.50)"}
]})
set_daily_plan_zones({"symbol": "NQ", "zones": [
  {"priceLow": 29470, "priceHigh": 29480, "enforcement": "hard", "label": "support boundary (0DTE put wall floor and gamma flip zone at 29475.00)"},
  {"priceLow": 29595, "priceHigh": 29605, "enforcement": "hard", "label": "resistance boundary (structural put wall ceiling at 29600.00)"}
]})
set_daily_take_profit_target({"symbol": "ES", "likelyMovePoints": 30, "label": "Asian session with normal volatility supports a 30pt distribution range"})
set_daily_take_profit_target({"symbol": "NQ", "likelyMovePoints": 200, "label": "Asian session with normal volatility supports a 200pt distribution range"})
-- and a sixth/seventh call in the same shape for GC's set_daily_plan_zones and set_daily_take_profit_target, using GC's own S/R pivot levels from the digest below.

This whole task should take exactly 2 turns total: this one (all six tool calls together -- ES, NQ, and GC, each getting both tools), then one more turn with a brief (3-5 sentence) summary of your session read and what you set. Do not call any tool other than set_daily_plan_zones/set_daily_take_profit_target, and do not change any settings. Do not respond with only a text analysis and no tool calls -- a text-only reply to this message is always wrong, regardless of how thorough the analysis is, since no zones would ever get set. Do not skip GC -- skipping it leaves it with zero daily-plan zones, which now blocks it from trading at all this session (see risk/engine.ts's evaluateDailyPlanRange).

${digest}`;
}

// Build the UPCOMING session's plan this far ahead of its actual start
// (2026-08-31, operator request: "better to trigger 5 minutes before the
// session") -- so the new session's zones/take-profit target are already in
// effect the instant it begins, instead of leaving a gap right at the
// boundary where the new session has zero zones until the first
// post-boundary poll catches it (up to POLL_INTERVAL_MS late under the old
// "wait for the crossing, then refresh" design).
//
// 2026-09-21 (operator request: "10 minutes before each session a daily
// trading plan is made then set"): widened from 5 to 10 minutes. This is the
// EARLIEST the refresh may start, not when it lands -- POLL_INTERVAL_MS
// (now 1 minute) is what pins it to the top of the window; see that
// constant's own comment for why the two have to be chosen together. The
// previous note here said "widening the window buys nothing since ticks are
// already this frequent," which was only true while the two were equal.
//
// 10 minutes is also the more useful number on its own terms: the digest
// (buildContextDigest) plus two Gemini round-trips took ~40s on a good run
// and over 2 minutes across the retry path on 2026-09-21, so a 5-minute
// window left little margin before the boundary it exists to beat.
export const PRE_TRIGGER_WINDOW_MS = 10 * 60 * 1000;

// Only set once a session has actually been handled (zones already existed,
// or a refresh was attempted, success or failure) -- deliberately NOT set
// when skipped because the assistant/actions gate is off, so a later tick
// after the operator flips it back on can still catch this same session
// rather than waiting for the next one.
let lastHandledSessionStart: number | null = null;
let refreshInFlight = false;

// When each session was last ATTEMPTED, successful or not (2026-09-24).
// Separate from lastHandledSessionStart, which now means "confirmed to have
// zones" -- see refreshForSession's finally block. A session whose refresh
// genuinely failed stays retryable, and this is what stops that becoming a
// hammer: without it, the catch-up path would re-attempt on every tick, which
// at POLL_INTERVAL_MS = 1min is 60 attempts an hour against an API that is
// rate-limited by the minute. Keyed by session start, so it never grows beyond
// a handful of entries per day.
const lastAttemptAtBySession = new Map<number, number>();

// How long to wait before re-attempting a session whose refresh failed. Chosen
// so a transient outage gets several shots across a session (Gemini 503s have
// cleared in under a minute in practice) without the per-minute poll turning
// into per-minute API calls. Not tuned against anything; lower it if sessions
// are still being lost to failures that would have cleared.
const RETRY_INTERVAL_MS = 10 * 60 * 1000;

/** Has enough time passed since the last attempt at `sessionStartMs` to try again? True when it has never been attempted. */
function mayAttemptSession(sessionStartMs: number): boolean {
  const last = lastAttemptAtBySession.get(sessionStartMs);
  return last === undefined || Date.now() - last >= RETRY_INTERVAL_MS;
}

/**
 * `at` is the session this refresh is FOR, not necessarily "now" -- the
 * pre-trigger path below calls this up to PRE_TRIGGER_WINDOW_MS before that
 * session actually starts. dailyPlanSessionOverride.ts is how that gets
 * threaded through to assistant/tools.ts's write handlers, which otherwise
 * have no way to know "which session" beyond real current time.
 */
async function attemptRefresh(at: Date): Promise<void> {
  const digest = await buildContextDigest();
  setDailyPlanSessionOverride(at);
  try {
    // 2026-09-24: runStatelessAssistantTurn, NOT client.ts's sendChatMessage.
    // See statelessTurn.ts's header for the deadlock that forced this -- in
    // short, sendChatMessage persists this prompt (which embeds a ~29 KB
    // digest) to AssistantMessage BEFORE calling the model, so every failure
    // left an orphan row, and 40 of those in the history window exceeded
    // Gemini's per-minute input-token cap on their own. Three consecutive
    // sessions got no plan at all. A stateless turn reads and writes no
    // history, so a failed refresh leaves nothing behind and the next attempt
    // is exactly as cheap as the first. Tool execution, the actions gate and
    // the AssistantAction audit trail are all unchanged.
    await runStatelessAssistantTurn(buildRefreshPrompt(digest));
  } finally {
    setDailyPlanSessionOverride(null);
  }
}

export async function refreshForSession(sessionStart: Date): Promise<void> {
  if (refreshInFlight) return; // never overlap two live LLM calls
  refreshInFlight = true;
  // Recorded before the attempt so mayAttemptSession can space retries out;
  // lastHandledSessionStart is NOT set here -- see the finally block.
  lastAttemptAtBySession.set(sessionStart.getTime(), Date.now());
  logger.info({ sessionStart: sessionStart.toISOString() }, "daily_plan_scheduler_refresh_starting");
  try {
    await attemptRefresh(sessionStart);
  } catch (err) {
    logger.warn({ err: String(err) }, "daily_plan_scheduler_refresh_failed_retrying_once");
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    try {
      await attemptRefresh(sessionStart);
    } catch (retryErr) {
      logger.warn({ err: String(retryErr) }, "daily_plan_scheduler_refresh_threw_checking_whether_zones_landed_anyway");
    }
  } finally {
    refreshInFlight = false;
    // Success is whether ZONES EXIST for this session, not whether the turn
    // threw (2026-09-24). Two separate faults, both observed live:
    //
    //  - The old code logged "this session trades with no daily-plan-zone
    //    gate" whenever the message errored, even when every set_daily_plan_
    //    zones call had already succeeded and the failure was the closing
    //    summary turn hitting a quota. On 2026-09-22 the 22:00 session had a
    //    complete, correct plan written at 21:52:38 and was reported as
    //    ungated -- the log inverted the fail-safe, and anyone acting on it
    //    (including me) would have set a manual plan over a good one.
    //  - lastHandledSessionStart was set BEFORE the attempt, so one transient
    //    503 forfeited the whole session: the catch-up path saw the session as
    //    handled and never tried again. Three consecutive sessions were lost
    //    that way (2026-09-23 NY through 2026-09-24 NY).
    //
    // Marking handled only on confirmed zones fixes both: a partial success is
    // recognised as success, and a real failure stays retryable. A failed
    // lookup is treated as "not confirmed" -- retrying a session that actually
    // has a plan is cheap (the pre-trigger path checks for existing zones
    // first and returns), while wrongly marking one handled is not.
    const planned = await listActiveDailyPlanZones(sessionStart).catch(() => ({} as Record<string, unknown>));
    const plannedSymbols = Object.keys(planned);
    if (plannedSymbols.length > 0) {
      lastHandledSessionStart = sessionStart.getTime();
      logger.info({ sessionStart: sessionStart.toISOString(), symbols: plannedSymbols }, "daily_plan_scheduler_refresh_succeeded");
    } else {
      logger.error(
        { sessionStart: sessionStart.toISOString(), retryInMs: RETRY_INTERVAL_MS },
        "daily_plan_scheduler_refresh_failed -- no zones written, this session trades with no daily-plan-zone gate until a later attempt succeeds"
      );
    }
  }
}

async function maybeRefreshForNewSession(): Promise<void> {
  const settings = getSettings();
  if (!settings.assistantEnabled) return;

  const now = new Date();
  const currentSessionStart = getSessionStart(now);
  const upcomingSessionStart = getSessionEnd(now); // = start of the NEXT session in sequence

  const systemState = await getSystemState();
  if (!systemState.assistantActionsEnabled) {
    logger.info("daily_plan_scheduler_skipped_actions_disabled");
    return; // not marked handled -- retry next tick in case this flips on mid-session
  }

  // Pre-trigger: within PRE_TRIGGER_WINDOW_MS of the NEXT session boundary
  // and that session hasn't been handled yet.
  const msUntilUpcoming = upcomingSessionStart.getTime() - now.getTime();
  if (msUntilUpcoming >= 0 && msUntilUpcoming <= PRE_TRIGGER_WINDOW_MS && upcomingSessionStart.getTime() !== lastHandledSessionStart) {
    const upcomingExisting = await listActiveDailyPlanZones(upcomingSessionStart);
    if (Object.keys(upcomingExisting).length > 0) {
      // Already set (e.g. a manual operator request beat the scheduler to
      // it) -- mark handled, no catch-up needed either since the upcoming
      // session isn't the CURRENT one yet.
      lastHandledSessionStart = upcomingSessionStart.getTime();
      return;
    }
    // mayAttemptSession spaces out retries for a session whose refresh failed
    // -- lastHandledSessionStart above only excludes CONFIRMED-planned sessions
    // now, so without this a persistent failure would re-attempt every tick.
    if (!refreshInFlight && mayAttemptSession(upcomingSessionStart.getTime())) {
      await refreshForSession(upcomingSessionStart);
      return;
    }
  }

  // Catch-up: the CURRENT session has no plan yet -- the pre-trigger above
  // was missed (backend was down, the actions gate was off, a restart lost
  // the in-memory lastHandledSessionStart, etc.). Same fallback this
  // scheduler has always had; unchanged by the pre-trigger addition above.
  const currentSessionStartMs = currentSessionStart.getTime();
  if (currentSessionStartMs === lastHandledSessionStart) return;

  const existing = await listActiveDailyPlanZones(now);
  if (Object.keys(existing).length > 0) {
    lastHandledSessionStart = currentSessionStartMs;
    return;
  }

  if (refreshInFlight || !mayAttemptSession(currentSessionStartMs)) return;
  await refreshForSession(currentSessionStart);
}

function tick(): void {
  maybeRefreshForNewSession().catch((err) => logger.error({ err: String(err) }, "daily_plan_scheduler_tick_failed"));
}

/** Starts the scheduler -- call once at boot. Returns the interval handle (unused by any current caller, but matches every other timer in index.ts for a consistent shutdown story if one is ever added). */
export function startDailyPlanScheduler(): NodeJS.Timeout {
  tick();
  return setInterval(tick, POLL_INTERVAL_MS);
}

