import { Decimal } from "decimal.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OhlcBar } from "../src/regime/indicators.js";

// Regression coverage for the 2026-08-12 finding: SPX/NDX (the CBOE
// cash-index options this feature proxies ES/NQ off of) only trade during
// NYSE cash-equity hours -- confirmed live, NQ's spot_price sat frozen at
// the exact same value for 10+ straight hours overnight, and every
// risk/engine.ts dealer-level rejection in that window was measuring
// distance from hours-stale walls, not live positioning. getDealerLevels
// must return null (same as "no data," which the risk gate already fails
// open on) once the underlying spot price has stopped changing for too
// long, rather than keep serving a frozen snapshot as if it were live.
vi.mock("../src/marketData/dealerGex.js", () => ({
  computeAndPersistDealerLevels: vi.fn(),
  computeAndPersistDealerLevelsBucketed: vi.fn(),
}));

// Mocked so resolveInitialLastChangedAt's cold-start history lookup never
// touches a real database -- without this, a fake test spot price that
// happens to coincide with a real historical value (as 29525.4785 did,
// verbatim, against this exact incident's real DB rows) would silently
// pull in real, uncontrolled history and make these tests non-deterministic.
const findManyMock = vi.fn();
vi.mock("../src/db/client.js", () => ({
  prisma: { dealerGexLevel: { findMany: (...args: unknown[]) => findManyMock(...args) } },
}));

const BARS: OhlcBar[] = [{ time: new Date("2026-01-01T00:00:00Z"), open: 100, high: 101, low: 99, close: 100, volume: 10 }];

function fakeResult(spotPrice: number) {
  return {
    symbol: "NQ",
    spotPrice: new Decimal(spotPrice),
    callWall: new Decimal(29700),
    putWall: new Decimal(29200),
    gammaFlip: new Decimal(27600),
    callWallConfirmed: false,
    putWallConfirmed: false,
  };
}

describe("getDealerLevels -- stale spot price detection", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00Z"));
    findManyMock.mockReset();
    findManyMock.mockResolvedValue([]); // no persisted history by default -- cold start treats a symbol's first-ever reading as fresh
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("returns the real result while the spot price keeps changing tick to tick", async () => {
    const { getDealerLevels } = await import("../src/engine/dealerGexCache.js");
    const { computeAndPersistDealerLevels } = await import("../src/marketData/dealerGex.js");
    vi.mocked(computeAndPersistDealerLevels)
      .mockResolvedValueOnce(fakeResult(29500))
      .mockResolvedValueOnce(fakeResult(29510));

    const first = await getDealerLevels("NQ", BARS, new Date());
    expect(first?.spotPrice.toNumber()).toBe(29500);

    vi.advanceTimersByTime(61_000); // past the 60s cache TTL, forces a fresh fetch
    const second = await getDealerLevels("NQ", BARS, new Date());
    expect(second?.spotPrice.toNumber()).toBe(29510);
  });

  it("returns null once the spot price has been unchanged for longer than the stale threshold", async () => {
    const { getDealerLevels } = await import("../src/engine/dealerGexCache.js");
    const { computeAndPersistDealerLevels } = await import("../src/marketData/dealerGex.js");
    vi.mocked(computeAndPersistDealerLevels).mockResolvedValue(fakeResult(29525.4785));

    // Poll every 61s (past the cache TTL each time) for 16 minutes -- the
    // exact overnight pattern this bug produced (a fixed 60s refresh timer
    // that kept "successfully" re-fetching the identical frozen snapshot).
    let result = await getDealerLevels("NQ", BARS, new Date());
    expect(result?.spotPrice.toNumber()).toBe(29525.4785); // still fresh on the first read

    for (let i = 0; i < 15; i++) {
      vi.advanceTimersByTime(61_000);
      result = await getDealerLevels("NQ", BARS, new Date());
    }
    expect(result).toBeNull(); // 15 * 61s > the 15-minute stale threshold
  });

  it("recovers (returns real data again) once the spot price starts moving again after a stale stretch", async () => {
    const { getDealerLevels } = await import("../src/engine/dealerGexCache.js");
    const { computeAndPersistDealerLevels } = await import("../src/marketData/dealerGex.js");
    vi.mocked(computeAndPersistDealerLevels).mockResolvedValue(fakeResult(29525.4785));

    for (let i = 0; i < 16; i++) {
      await getDealerLevels("NQ", BARS, new Date());
      vi.advanceTimersByTime(61_000);
    }
    expect(await getDealerLevels("NQ", BARS, new Date())).toBeNull(); // confirmed stale

    vi.mocked(computeAndPersistDealerLevels).mockResolvedValueOnce(fakeResult(29540));
    vi.advanceTimersByTime(61_000);
    const recovered = await getDealerLevels("NQ", BARS, new Date());
    expect(recovered?.spotPrice.toNumber()).toBe(29540);
  });

  it("still returns fresh data within the normal 60s cache window without re-fetching", async () => {
    const { getDealerLevels } = await import("../src/engine/dealerGexCache.js");
    const { computeAndPersistDealerLevels } = await import("../src/marketData/dealerGex.js");
    vi.mocked(computeAndPersistDealerLevels).mockResolvedValueOnce(fakeResult(29500));

    const first = await getDealerLevels("NQ", BARS, new Date());
    vi.advanceTimersByTime(30_000); // within the 60s TTL
    const second = await getDealerLevels("NQ", BARS, new Date());

    expect(first?.spotPrice.toNumber()).toBe(29500);
    expect(second?.spotPrice.toNumber()).toBe(29500);
    expect(vi.mocked(computeAndPersistDealerLevels)).toHaveBeenCalledTimes(1); // cache hit, no second CBOE fetch
  });

  // Regression coverage for the warm-start fix specifically: a fresh process
  // restarted into an already-hours-stale CBOE snapshot must detect that
  // immediately from persisted history, not wait another 15 minutes of its
  // own in-memory tracking before noticing what the database already shows.
  describe("warm-start from persisted history on a cold cache", () => {
    it("detects staleness on the very first call after a restart, using real history older than the threshold", async () => {
      const { getDealerLevels } = await import("../src/engine/dealerGexCache.js");
      const { computeAndPersistDealerLevels } = await import("../src/marketData/dealerGex.js");
      vi.mocked(computeAndPersistDealerLevels).mockResolvedValueOnce(fakeResult(29525.4785));
      // Persisted history shows this exact price going back 20 minutes --
      // older than the 15-minute stale threshold.
      findManyMock.mockResolvedValueOnce([
        { time: new Date("2026-08-11T23:45:00Z"), spotPrice: new Decimal(29525.4785) }, // 15 min ago
        { time: new Date("2026-08-11T23:40:00Z"), spotPrice: new Decimal(29525.4785) }, // 20 min ago
      ]);

      const result = await getDealerLevels("NQ", BARS, new Date());
      expect(result).toBeNull(); // stale immediately, no 15-minute grace period on a cold cache
    });

    it("does NOT falsely flag staleness on a cold cache when history shows the price only just changed", async () => {
      const { getDealerLevels } = await import("../src/engine/dealerGexCache.js");
      const { computeAndPersistDealerLevels } = await import("../src/marketData/dealerGex.js");
      vi.mocked(computeAndPersistDealerLevels).mockResolvedValueOnce(fakeResult(29600));
      // Most recent history row is a DIFFERENT price -- this reading is new.
      findManyMock.mockResolvedValueOnce([{ time: new Date("2026-08-11T23:58:00Z"), spotPrice: new Decimal(29590) }]);

      const result = await getDealerLevels("NQ", BARS, new Date());
      expect(result?.spotPrice.toNumber()).toBe(29600); // fresh, not stale
    });

    it("falls back to treating the reading as fresh if the history lookup itself fails", async () => {
      const { getDealerLevels } = await import("../src/engine/dealerGexCache.js");
      const { computeAndPersistDealerLevels } = await import("../src/marketData/dealerGex.js");
      vi.mocked(computeAndPersistDealerLevels).mockResolvedValueOnce(fakeResult(29500));
      findManyMock.mockRejectedValueOnce(new Error("db unavailable"));

      const result = await getDealerLevels("NQ", BARS, new Date());
      expect(result?.spotPrice.toNumber()).toBe(29500); // best-effort warm-start, not a hard requirement
    });
  });
});
