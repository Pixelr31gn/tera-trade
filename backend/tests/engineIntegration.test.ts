/**
 * End-to-end engine test: synthetic bars -> regime/score/risk/execution -> a
 * closed trade in the DB, entirely against SimulatedBroker.
 *
 * Requires a reachable Postgres (TEST_DATABASE_URL or DATABASE_URL) with the
 * schema already migrated -- skips cleanly if neither is set, since this
 * sandbox may not have a database available.
 */
import { Decimal } from "decimal.js";
import { beforeAll, describe, expect, it } from "vitest";
import { makeTrendingBars } from "./fixtures.js";
import { getLatestRegimeSnapshot } from "../src/engine/regimeSnapshotCache.js";
import { computeContextBucket } from "../src/analytics/contextBucket.js";
import type { OhlcBar } from "../src/regime/indicators.js";
import type { SetupFeatures } from "../src/scoring/features.js";

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const hasRealDb = !!TEST_DB_URL && !TEST_DB_URL.includes("test:test@localhost");
const MIN_BARS_FOR_REGIME = 120; // keep in sync with engine/loop.ts and replay/decisionCore.ts

// Real instrument symbol, not a synthetic one -- getInstrument (called deep
// inside decideOnBar) has no fallback for an unrecognized symbol and throws
// outright (confirmed live -- see tests/replayEquivalence.test.ts's identical
// comment, which this test didn't originally follow and should have).
//
// "CL", not "ES" or "NQ" -- those two are ACTIVE_INSTRUMENTS (marketData/
// instruments.ts), meaning real historical backfills and the live price feed
// both write real Bar rows for them. engine/bootstrap.ts's loadRecentBars
// has no upper time bound, so a synthetic future-dated symbol sharing a
// symbol name with real data gets its bar window padded with real trailing
// data once enough exists -- confirmed live (2026-08-02) this broke
// replayEquivalence.test.ts's live-vs-replay equivalence the moment real "ES"
// data was backfilled for actual backtesting use, even though the two test
// files' own synthetic windows never overlapped each other. "CL" is
// registered (getInstrument-safe) but deliberately excluded from
// ACTIVE_INSTRUMENTS, so nothing ever backfills or live-feeds it -- the only
// permanent fix, not just a same-day workaround. (replayEquivalence.test.ts
// uses "GC" for the same reason -- different symbol per file, still, in case
// both ever run concurrently.)
const SYMBOL = "CL";
const SYNTHETIC_START = new Date("2099-06-01T00:00:00Z");

function shiftToSyntheticWindow(bars: OhlcBar[]): OhlcBar[] {
  const originalStart = bars[0]!.time.getTime();
  return bars.map((b) => ({ ...b, time: new Date(SYNTHETIC_START.getTime() + (b.time.getTime() - originalStart)) }));
}

describe.skipIf(!hasRealDb)("engine integration", () => {
  let prisma: (typeof import("../src/db/client.js"))["prisma"];
  let TradingEngine: (typeof import("../src/engine/loop.js"))["TradingEngine"];
  let SimulatedBroker: (typeof import("../src/brokers/simulatedBroker.js"))["SimulatedBroker"];

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB_URL;
    ({ prisma } = await import("../src/db/client.js"));
    ({ TradingEngine } = await import("../src/engine/loop.js"));
    ({ SimulatedBroker } = await import("../src/brokers/simulatedBroker.js"));
  });

  it("produces a regime snapshot and at least one score without placing real orders", async () => {
    const bars = shiftToSyntheticWindow(makeTrendingBars(200));
    const engine = new TradingEngine(new SimulatedBroker(), null, null);

    // Self-healing: a PRIOR run of this exact test that was interrupted
    // before its own `finally` cleanup below (e.g. a vitest-level timeout
    // under full-suite DB contention -- confirmed happens, see
    // vitest.config.ts's testTimeout comment) leaves synthetic rows behind
    // that collide with this run's own inserts on the (time, symbol) unique
    // constraint. Clearing the same window up front makes a fresh run
    // recover on its own instead of failing on someone else's leftovers.
    await prisma.score.deleteMany({ where: { symbol: SYMBOL, time: { gte: SYNTHETIC_START } } });
    await prisma.trade.deleteMany({ where: { symbol: SYMBOL, entryTime: { gte: SYNTHETIC_START } } });
    await prisma.bar.deleteMany({ where: { symbol: SYMBOL, time: { gte: SYNTHETIC_START } } });

    try {
      // Bars are inserted and decided one at a time -- bulk-inserting the
      // whole dataset upfront and then calling onNewBar would let
      // loadRecentBars see bars from the "future" relative to whichever one
      // is being decided, exactly the look-ahead
      // tests/replayEquivalence.test.ts's own comment warns about. Also: no
      // strategy is guaranteed to fire on any single specific bar (confirmed
      // live -- the old single-call version of this test, calling onNewBar
      // only for the very last bar, produced zero signals because this
      // fixture's last breakout happens to land well before the final bar) --
      // deciding every bar and checking cumulative results afterward is
      // robust to exactly which bar(s) end up firing.
      for (let i = 0; i < bars.length; i++) {
        const b = bars[i]!;
        await prisma.bar.create({
          data: {
            time: b.time, symbol: SYMBOL, open: b.open.toString(), high: b.high.toString(), low: b.low.toString(),
            close: b.close.toString(), volume: b.volume.toString(),
          },
        });
        if (i + 1 < MIN_BARS_FOR_REGIME) continue;
        await engine.onNewBar(SYMBOL, b.time, new Decimal(b.open), new Decimal(b.high), new Decimal(b.low), new Decimal(b.close), new Decimal(b.volume));
      }

      // regime_history was dropped as an unused DB table (2026-07-20
      // migration "drop_unused_position_rollup_regime_orderflow_tables") once
      // nothing in scoring ever read it back -- regime is now held in-memory
      // only (see engine/regimeSnapshotCache.ts). This test used to check the
      // DB table; updated to check the cache it was replaced with instead.
      const regimeSnapshot = getLatestRegimeSnapshot(SYMBOL);
      expect(regimeSnapshot).not.toBeNull();
      expect(["up", "down", "none"]).toContain(regimeSnapshot!.trendLabel);

      const scores = await prisma.score.findMany({ where: { symbol: SYMBOL, time: { gte: SYNTHETIC_START } } });
      expect(scores.length).toBeGreaterThanOrEqual(1);

      // Every signal is shadow-scored under v1/v2/v3 (STRATEGY_VERSIONS) plus
      // v5 (SHADOW_ONLY_VERSIONS, see engine/loop.ts) -- confirm all four
      // actually land in the DB with distinct rows, not just one version
      // silently winning or an insert failing against the
      // (time, symbol, strategyId, strategyVersion) unique constraint.
      const versions = new Set(scores.map((s) => s.strategyVersion));
      expect(versions.has("v1")).toBe(true);
      expect(versions.has("v2")).toBe(true);
      expect(versions.has("v3")).toBe(true);
      expect(versions.has("v5")).toBe(true);
      expect(scores.length % 4).toBe(0); // exactly one v1 + one v2 + one v3 + one v5 per signal

      // persistScores writes contextBucket from the same `features` blob it
      // stores on the row (engine/loop.ts) -- confirm the two never drift,
      // for every row, not just one signal's worth (scoring/consensusBandit.ts
      // depends on this column matching what the row's own features say).
      for (const score of scores) {
        const features = score.features as unknown as SetupFeatures;
        const expectedBucket = computeContextBucket(features.session, features.trendLabel as "up" | "down" | "none", features.volLabel as "high" | "normal" | "low");
        expect(score.contextBucket, `contextBucket mismatch for score ${score.id}`).toBe(expectedBucket);
      }
    } finally {
      // Scoped to the synthetic time range, not the symbol -- "ES" is a real,
      // permanently-registered instrument other rows may legitimately use,
      // and must not itself be deleted (see supportResistance.ts's touch
      // history and every real trade/score row already in this shared DB).
      await prisma.score.deleteMany({ where: { symbol: SYMBOL, time: { gte: SYNTHETIC_START } } });
      await prisma.trade.deleteMany({ where: { symbol: SYMBOL, entryTime: { gte: SYNTHETIC_START } } });
      await prisma.bar.deleteMany({ where: { symbol: SYMBOL, time: { gte: SYNTHETIC_START } } });
    }
  });
});
