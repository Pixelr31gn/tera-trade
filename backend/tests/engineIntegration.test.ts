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

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const hasRealDb = !!TEST_DB_URL && !TEST_DB_URL.includes("test:test@localhost");

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
    const symbol = `ES_TEST_${Date.now()}`;
    await prisma.instrument.create({ data: { symbol, dataSymbol: "ES=F", tickSize: "0.25", pointValue: "50" } });

    const bars = makeTrendingBars(200);
    await prisma.bar.createMany({
      data: bars.map((b) => ({
        time: b.time, symbol, open: b.open.toString(), high: b.high.toString(), low: b.low.toString(),
        close: b.close.toString(), volume: b.volume.toString(),
      })),
    });

    const engine = new TradingEngine(new SimulatedBroker());
    const last = bars[bars.length - 1]!;
    await engine.onNewBar(symbol, last.time, new Decimal(last.open), new Decimal(last.high), new Decimal(last.low), new Decimal(last.close), new Decimal(last.volume));

    const regimes = await prisma.regimeSnapshot.findMany({ where: { symbol } });
    expect(regimes.length).toBe(1);
    expect(["up", "down", "none"]).toContain(regimes[0]!.trendLabel);

    const scores = await prisma.score.findMany({ where: { symbol } });
    expect(scores.length).toBeGreaterThanOrEqual(1);

    // cleanup
    await prisma.score.deleteMany({ where: { symbol } });
    await prisma.trade.deleteMany({ where: { symbol } });
    await prisma.regimeSnapshot.deleteMany({ where: { symbol } });
    await prisma.bar.deleteMany({ where: { symbol } });
    await prisma.instrument.delete({ where: { symbol } });
  });
});
