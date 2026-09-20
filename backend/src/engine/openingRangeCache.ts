/**
 * Opening-range breakout stats need far more history than the ~300-bar
 * rolling window the regime/ATR calculations use (multiple trading sessions,
 * not minutes) -- this queries a wide slice of bars_1m directly and caches
 * the result per symbol, since recomputing a multi-day backtest on every
 * single price tick would be wasteful.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../db/client.js";
import { computeOpeningRangeStats, type OpeningRangeStats } from "../analytics/openingRange.js";
import { getInstrument } from "../marketData/instruments.js";
import type { OhlcBar } from "../regime/indicators.js";

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour -- this stat moves slowly, no need to recompute every tick
// The scoring gate only requires MIN_OPENING_RANGE_SAMPLE_SIZE=15 sessions
// before using this factor at all (see scoring/ruleScorer.ts) -- 45 calendar
// days gives ~30 trading sessions, a healthy 2x margin above that minimum
// for a statistically stable probability estimate, while halving this
// query's row-scan footprint against bars_1m versus the previous 90-day
// window (this was the single most expensive recurring cold-cache query in
// the system -- see loadWideBarHistory's comment on why it was already
// pushed into a raw SQL aggregate).
const LOOKBACK_DAYS = 45;

const cache = new Map<string, { stats: OpeningRangeStats; computedAt: number }>();

interface RawBucketRow {
  bucket: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

// bars_1m is really raw price ticks (every ~5-10s from the browser watcher,
// not true 1-minute bars -- see browserWatch/watcher.ts), and this stat
// needs a wide, multi-week window to have enough trading sessions to be
// meaningful. Pulling every raw tick over that window and aggregating in JS
// was measured at ~45s cold (tens of thousands of rows transferred + parsed
// for one symbol). Aggregating to true 1-minute OHLC in Postgres first --
// same total time coverage, ~6-10x fewer rows over the wire, and the actual
// MIN/MAX/SUM work happens in the database instead of Node.
async function loadWideBarHistory(symbol: string): Promise<OhlcBar[]> {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);
  const rows = await prisma.$queryRaw<RawBucketRow[]>(Prisma.sql`
    SELECT
      date_trunc('minute', "time") AS bucket,
      (array_agg("open" ORDER BY "time" ASC))[1]::text AS open,
      MAX("high")::text AS high,
      MIN("low")::text AS low,
      (array_agg("close" ORDER BY "time" DESC))[1]::text AS close,
      SUM("volume")::text AS volume
    FROM bars_1m
    WHERE symbol = ${symbol} AND "time" >= ${since}
    GROUP BY bucket
    ORDER BY bucket ASC
  `);
  return rows.map((r) => ({ time: r.bucket, open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume) }));
}

const EMPTY_STATS_TEMPLATE: Omit<OpeningRangeStats, "symbol"> = {
  sessionsAnalyzed: 0,
  probHighBroken: null,
  probLowBroken: null,
  probBothBroken: null,
  probNeitherBroken: null,
};

export async function getOpeningRangeStats(symbol: string): Promise<OpeningRangeStats> {
  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.computedAt < CACHE_TTL_MS) return cached.stats;

  // A symbol outside the static instrument list (e.g. a synthetic test
  // fixture) has no rthOpen hours to analyze against -- report "not enough
  // data" rather than crashing the whole engine loop over one stat.
  let instrument;
  try {
    instrument = getInstrument(symbol);
  } catch {
    return { symbol, ...EMPTY_STATS_TEMPLATE };
  }

  const bars = await loadWideBarHistory(symbol);
  const stats = computeOpeningRangeStats(bars, symbol, instrument.rthOpenHourET, instrument.rthOpenMinuteET);

  cache.set(symbol, { stats, computedAt: Date.now() });
  return stats;
}
