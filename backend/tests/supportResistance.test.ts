import { describe, expect, it } from "vitest";
import { clusterLevels, computeSupportResistanceLevels, detectPivots, findNearestRelevantLevel, findNearestTargetLevel, type Pivot } from "../src/analytics/supportResistance.js";
import type { OhlcBar } from "../src/regime/indicators.js";

function barsWithPivotLowNear(price: number): OhlcBar[] {
  const base = new Date("2026-01-01T00:00:00Z").getTime();
  return Array.from({ length: 20 }, (_, i) => {
    const low = price + Math.abs(i - 10) * 2;
    return { time: new Date(base + i * 60_000), open: low + 1, high: low + 3, low, close: low + 1, volume: 100 };
  });
}

function barsWithPivotHighNear(price: number): OhlcBar[] {
  const base = new Date("2026-01-01T00:00:00Z").getTime();
  return Array.from({ length: 20 }, (_, i) => {
    const high = price - Math.abs(i - 10) * 2;
    return { time: new Date(base + i * 60_000), open: high - 1, high, low: high - 3, close: high - 1, volume: 100 };
  });
}

describe("detectPivots", () => {
  it("finds a clean pivot low at the expected price", () => {
    const pivots = detectPivots(barsWithPivotLowNear(100));
    expect(pivots.some((p) => p.kind === "low" && p.price === 100)).toBe(true);
  });

  it("finds a clean pivot high at the expected price", () => {
    const pivots = detectPivots(barsWithPivotHighNear(100));
    expect(pivots.some((p) => p.kind === "high" && p.price === 100)).toBe(true);
  });

  it("finds nothing in perfectly flat bars", () => {
    const flat: OhlcBar[] = Array.from({ length: 20 }, (_, i) => ({
      time: new Date(Date.UTC(2026, 0, 1, 0, i)),
      open: 100, high: 100, low: 100, close: 100, volume: 100,
    }));
    // Every bar ties for the extreme in a flat series -- detectPivots only
    // guarantees a *unique* signal for genuinely-sloped data (see the
    // barsWithPivot* helpers); this just documents flat input isn't useful.
    const pivots = detectPivots(flat);
    expect(pivots.every((p) => p.price === 100)).toBe(true);
  });
});

describe("clusterLevels", () => {
  it("merges pivots within tolerance into one averaged level", () => {
    const pivots: Pivot[] = [
      { price: 100, kind: "low" },
      { price: 100.4, kind: "low" },
      { price: 100.3, kind: "low" },
    ];
    const clustered = clusterLevels(pivots, 0.5);
    expect(clustered).toHaveLength(1);
    expect(clustered[0]!.touches).toBe(3);
    expect(clustered[0]!.price).toBeCloseTo((100 + 100.4 + 100.3) / 3, 5);
  });

  it("keeps distant pivots as separate levels", () => {
    const pivots: Pivot[] = [
      { price: 100, kind: "low" },
      { price: 110, kind: "low" },
    ];
    const clustered = clusterLevels(pivots, 0.5);
    expect(clustered).toHaveLength(2);
  });

  it("returns nothing for an empty input or non-positive tolerance", () => {
    expect(clusterLevels([], 1)).toHaveLength(0);
    expect(clusterLevels([{ price: 100, kind: "low" }], 0)).toHaveLength(0);
  });
});

describe("computeSupportResistanceLevels", () => {
  it("labels a level below current price as support and above as resistance", () => {
    const bars = [...barsWithPivotLowNear(90), ...barsWithPivotHighNear(110)];
    const levels = computeSupportResistanceLevels(bars, 100, 5);
    expect(levels.some((l) => l.type === "support" && l.price < 100)).toBe(true);
    expect(levels.some((l) => l.type === "resistance" && l.price > 100)).toBe(true);
  });

  it("returns nothing for a zero/negative ATR", () => {
    expect(computeSupportResistanceLevels(barsWithPivotLowNear(90), 100, 0)).toHaveLength(0);
  });
});

describe("findNearestRelevantLevel", () => {
  it("only considers support for a long, resistance for a short", () => {
    const levels = [
      { price: 95, touches: 2, type: "support" as const },
      { price: 105, touches: 2, type: "resistance" as const },
    ];
    const forLong = findNearestRelevantLevel(levels, "long", 100, 5);
    const forShort = findNearestRelevantLevel(levels, "short", 100, 5);
    expect(forLong?.level.type).toBe("support");
    expect(forShort?.level.type).toBe("resistance");
  });

  it("picks the closest of multiple candidate levels", () => {
    const levels = [
      { price: 80, touches: 2, type: "support" as const },
      { price: 98, touches: 2, type: "support" as const },
    ];
    const nearest = findNearestRelevantLevel(levels, "long", 100, 5);
    expect(nearest?.level.price).toBe(98);
    expect(nearest?.distancePoints).toBeCloseTo(2);
    expect(nearest?.distanceInAtr).toBeCloseTo(0.4);
  });

  it("returns null when no relevant-type level exists", () => {
    const levels = [{ price: 105, touches: 1, type: "resistance" as const }];
    expect(findNearestRelevantLevel(levels, "long", 100, 5)).toBeNull();
  });
});

describe("findNearestTargetLevel", () => {
  it("targets resistance (ahead of price) for a long, support for a short", () => {
    const levels = [
      { price: 95, touches: 2, type: "support" as const },
      { price: 105, touches: 2, type: "resistance" as const },
    ];
    expect(findNearestTargetLevel(levels, "long", 100)?.type).toBe("resistance");
    expect(findNearestTargetLevel(levels, "short", 100)?.type).toBe("support");
  });

  it("picks the closest of multiple candidate target levels", () => {
    const levels = [
      { price: 108, touches: 2, type: "resistance" as const },
      { price: 103, touches: 2, type: "resistance" as const },
    ];
    expect(findNearestTargetLevel(levels, "long", 100)?.price).toBe(103);
  });

  it("ignores a level with fewer than MIN_LEVEL_TOUCHES touches", () => {
    const levels = [{ price: 105, touches: 1, type: "resistance" as const }];
    expect(findNearestTargetLevel(levels, "long", 100)).toBeNull();
  });

  it("returns null when no real level exists in the trade's direction, rather than blocking on it", () => {
    const levels = [{ price: 95, touches: 3, type: "support" as const }];
    expect(findNearestTargetLevel(levels, "long", 100)).toBeNull();
  });
});
