/**
 * TTL-based cache around marketData/dealerGex.ts -- refreshes periodically
 * so dealer GEX levels track live, like any other GEX chart, rather than
 * being a once-per-session snapshot (2026-08-11, operator request: "gex
 * should compute live like any other gex chart"). SUPERSEDES the original
 * session-scoped design (computed once at session open, cached until the
 * next session boundary) -- that made sense for a one-time report, but not
 * for something meant to track spot price moving intraday: the whole point
 * of the gamma-flip level (analytics/dealerGex.ts's findGammaFlip) is which
 * crossing sits NEAREST current spot, which only stays right if spot is
 * kept current.
 *
 * Same TTL-cache shape as consensusBanditCache.ts/sessionPerformanceCache.ts.
 * 60s TTL -- short enough to feel live, long enough that the existing
 * per-bar cadence (engine/loop.ts's scanSymbolContinuously only proceeds
 * once a NEW bar completes, decideOnBar likewise) naturally refreshes this
 * roughly once a minute without a dedicated new timer, and without hammering
 * CBOE's free, unauthenticated endpoint. Every fresh computation is still
 * persisted (marketData/dealerGex.ts's computeAndPersistDealerLevels), so
 * dealer_gex_levels accumulates a real intraday history, not just the
 * latest snapshot -- adjust CACHE_TTL_MS if a different cadence turns out
 * to matter more than fetch cost.
 *
 * Live only. Replay always returns null directly (see
 * replayDecisionContext.ts) -- CBOE's historical options data cannot be
 * backfilled, same fidelity limit as engine/liveOrderFlowCache.ts.
 */
import { computeAndPersistDealerLevels, computeAndPersistDealerLevelsBucketed, type DealerLevelResult, type DealerLevelBucketedResult } from "../marketData/dealerGex.js";
import { prisma } from "../db/client.js";
import type { OhlcBar } from "../regime/indicators.js";
import { childLogger } from "../core/logger.js";

const logger = childLogger("dealerGexCache");

const CACHE_TTL_MS = 60 * 1000;

// SPX/NDX (the CBOE cash-index options this feature is proxied off of --
// see marketData/dealerGex.ts's header) only trade during NYSE cash-equity
// hours, roughly 13:30-20:00 UTC. Confirmed live (2026-08-12, operator
// report: "the proximity gate is based off the gex report and the gex
// report is the exact same numbers as our first calculation... i thought
// we added a live gex calculator"): NQ's dealer_gex_levels spot_price sat
// at exactly 29525.4785 for over 10 straight hours overnight, and CBOE's
// live endpoint confirmed the SAME value plus `data.last_trade_time` from
// the prior day's close, `volume: 0` -- CBOE genuinely stops updating this
// feed outside cash hours, and every risk/engine.ts dealer-level rejection
// during that stretch was measuring distance from hours-stale walls, not
// live dealer positioning. ES/NQ FUTURES trade nearly 24 hours a day, so
// this dead window covers most of the Asian/London/pre-market sessions --
// exactly the hours BUILD_HISTORY.md's earlier v7-rejection investigation
// was looking at.
//
// Detected here by tracking whether the underlying spot price has actually
// CHANGED between successive fetches, not by hardcoding NYSE hours
// (fragile to DST/holidays and doesn't generalize to "CBOE is just down").
// A spot price frozen for longer than STALE_THRESHOLD_MS is treated as no
// data at all -- getDealerLevels returns null, which risk/engine.ts's
// dealer-level gate already fails open on, same posture as a missing
// order-flow snapshot. Hand-set threshold, not fitted -- real markets
// essentially never go 15 minutes without a single tick during actual
// trading hours, so this should never false-positive during the hours the
// gate is meant to apply. Watch real results.
const STALE_THRESHOLD_MS = 15 * 60 * 1000;

interface CacheEntry {
  result: DealerLevelResult;
  computedAt: number;
  lastSpotPrice: string;
  lastChangedAt: number;
}

const cache = new Map<string, CacheEntry>();
// Coalesces concurrent callers within the same tick (onNewBar/
// scanSymbolContinuously can both ask in short succession) into one CBOE
// fetch instead of several parallel ones.
const inFlight = new Map<string, Promise<DealerLevelResult | null>>();

// The in-memory cache above resets on every process restart, which would
// otherwise re-arm a fresh STALE_THRESHOLD_MS grace period every time --
// meaning a backend restarted into an already-hours-stale CBOE snapshot
// (exactly what happened the night this fix was written) would still serve
// that stale data for another 15 minutes post-restart before detecting it,
// even though the real staleness clearly predates the restart. Warm-starts
// `lastChangedAt` from persisted history instead of assuming "just seen for
// the first time = fresh": walks the most recent `dealer_gex_levels` rows
// backward and finds how far back the SAME spot price genuinely goes, so a
// cold cache immediately knows what a warm one would have known. Bounded
// lookback (50 rows, ~50 minutes at the normal 60s cadence) -- if even that
// whole window is one unchanged price, treating "50 rows ago" as the change
// point is a fine approximation; the exact age beyond that doesn't change
// the stale/not-stale verdict at a 15-minute threshold either way.
async function resolveInitialLastChangedAt(symbol: string, currentSpotPriceStr: string, now: number): Promise<number> {
  try {
    const rows = await prisma.dealerGexLevel.findMany({
      where: { symbol, bucket: "blended" },
      orderBy: { time: "desc" },
      take: 50,
      select: { time: true, spotPrice: true },
    });
    let lastChangedAt = now;
    for (const row of rows) {
      if (row.spotPrice.toString() !== currentSpotPriceStr) break;
      lastChangedAt = row.time.getTime();
    }
    return lastChangedAt;
  } catch {
    // History lookup is a best-effort warm-start, not a correctness
    // requirement -- if it fails for any reason, fall back to "just seen
    // for the first time," same as before this warm-start existed.
    return now;
  }
}

export async function getDealerLevels(symbol: string, recentBars: OhlcBar[], at: Date): Promise<DealerLevelResult | null> {
  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.computedAt < CACHE_TTL_MS) {
    return Date.now() - cached.lastChangedAt < STALE_THRESHOLD_MS ? cached.result : null;
  }

  const existingInFlight = inFlight.get(symbol);
  if (existingInFlight) return existingInFlight;

  const promise = (async (): Promise<DealerLevelResult | null> => {
    try {
      const result = await computeAndPersistDealerLevels(symbol, recentBars, at);
      const spotPriceStr = result.spotPrice.toString();
      const previous = cache.get(symbol);
      const now = Date.now();
      const lastChangedAt = previous
        ? (previous.lastSpotPrice === spotPriceStr ? previous.lastChangedAt : now)
        : await resolveInitialLastChangedAt(symbol, spotPriceStr, now);
      cache.set(symbol, { result, computedAt: now, lastSpotPrice: spotPriceStr, lastChangedAt });
      if (now - lastChangedAt >= STALE_THRESHOLD_MS) {
        logger.warn({ symbol, spotPrice: spotPriceStr, staleForMs: now - lastChangedAt }, "dealer_gex_stale_spot_price");
        return null;
      }
      return result;
    } catch (err) {
      // Never throw -- a CBOE hiccup (rate limit, transient 5xx, a symbol
      // CBOE doesn't cover) means "no dealer levels available this bar," not
      // "block the engine loop." risk/engine.ts's dealer-level gate already
      // fails open on null, same posture as a missing order-flow snapshot.
      logger.warn({ symbol, err: err instanceof Error ? err.message : String(err) }, "dealer_gex_fetch_failed");
      return null;
    } finally {
      inFlight.delete(symbol);
    }
  })();
  inFlight.set(symbol, promise);
  return promise;
}

// Separate cache/in-flight map from getDealerLevels above -- deliberately
// independent so the bucketed (report-only) computation can never share
// state with, or accidentally affect, whatever feeds the live proximity
// gate. Same TTL/coalescing shape otherwise.
const bucketedCache = new Map<string, { result: DealerLevelBucketedResult; computedAt: number }>();
const bucketedInFlight = new Map<string, Promise<DealerLevelBucketedResult | null>>();

export async function getDealerLevelsBucketed(symbol: string, recentBars: OhlcBar[], at: Date): Promise<DealerLevelBucketedResult | null> {
  const cached = bucketedCache.get(symbol);
  if (cached && Date.now() - cached.computedAt < CACHE_TTL_MS) return cached.result;

  const existingInFlight = bucketedInFlight.get(symbol);
  if (existingInFlight) return existingInFlight;

  const promise = (async (): Promise<DealerLevelBucketedResult | null> => {
    try {
      const result = await computeAndPersistDealerLevelsBucketed(symbol, recentBars, at);
      bucketedCache.set(symbol, { result, computedAt: Date.now() });
      return result;
    } catch (err) {
      logger.warn({ symbol, err: err instanceof Error ? err.message : String(err) }, "dealer_gex_bucketed_fetch_failed");
      return null;
    } finally {
      bucketedInFlight.delete(symbol);
    }
  })();
  bucketedInFlight.set(symbol, promise);
  return promise;
}
