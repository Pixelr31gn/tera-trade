import type { FastifyInstance } from "fastify";
import { Decimal } from "decimal.js";
import { prisma } from "../../db/client.js";
import { requireApiKey } from "../../core/security.js";
import { computeActionability } from "../../scoring/actionability.js";
import { computeTradePlan } from "../../risk/index.js";
import { DEFAULT_INSTRUMENTS, getInstrument } from "../../marketData/instruments.js";
import { computeAccountEquity } from "../../engine/accounting.js";
import { ensureDefaultAccount } from "../../engine/bootstrap.js";
import { getSystemState } from "../../execution/mode.js";
import type { Score, RiskLimit } from "@prisma/client";

// Every score row carries the hypothetical entry/ATR/structure-swing it was
// signaled at (see engine/loop.ts), so the exact stop/target/quantity plan
// can be recomputed on demand here -- via the same computeTradePlan the real
// execution path (risk/engine.ts) uses -- instead of needing to persist the
// plan as its own columns. This must stay in sync with the account's actual
// risk limits (fixed-dollar or percentage) so what's displayed always
// matches what would actually be traded.
function buildTradePlan(score: Score, riskLimits: RiskLimit, equity: Decimal): { entryPrice: number; stopPrice: number; takeProfitPrice: number; quantity: number } {
  const instrument = getInstrument(score.symbol);
  const entryPrice = new Decimal(score.entryPriceAtSignal.toString());
  const atrValue = new Decimal(score.atrAtSignal.toString());
  const structureSwingPrice = score.structureSwingPriceAtSignal ? new Decimal(score.structureSwingPriceAtSignal.toString()) : null;

  const riskAmount = riskLimits.perTradeRiskDollars
    ? new Decimal(riskLimits.perTradeRiskDollars.toString())
    : equity.times(riskLimits.perTradeRiskPct.toString()).dividedBy(100);
  const profitDollars = riskLimits.perTradeProfitDollars ? new Decimal(riskLimits.perTradeProfitDollars.toString()) : null;

  const plan = computeTradePlan({
    side: score.side as "long" | "short",
    entryPrice,
    atrValue,
    structureSwingPrice,
    tickSize: instrument.tickSize,
    pointValue: instrument.pointValue,
    riskAmount,
    profitDollars,
    maxPositionSize: riskLimits.maxPositionSize,
  });

  return { entryPrice: entryPrice.toNumber(), stopPrice: plan.stopPrice.toNumber(), takeProfitPrice: plan.takeProfitPrice.toNumber(), quantity: plan.quantity };
}

async function loadRiskContext(): Promise<{ riskLimits: RiskLimit; equity: Decimal }> {
  const account = await ensureDefaultAccount();
  const riskLimits = await prisma.riskLimit.findUniqueOrThrow({ where: { accountId: account.id } });

  const lastPrices = new Map<string, Decimal>();
  for (const spec of DEFAULT_INSTRUMENTS) {
    const lastBar = await prisma.bar.findFirst({ where: { symbol: spec.symbol }, orderBy: { time: "desc" } });
    if (lastBar) lastPrices.set(spec.symbol, new Decimal(lastBar.close.toString()));
  }
  const equity = await computeAccountEquity(account, lastPrices);

  return { riskLimits, equity };
}

export async function scoresRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireApiKey);

  app.get<{ Querystring: { limit?: string } }>("/api/recommendations", async (request) => {
    const limit = Math.min(Number(request.query.limit ?? 100), 500);
    const rows = await prisma.score.findMany({ orderBy: { time: "desc" }, take: limit });
    const { riskLimits, equity } = await loadRiskContext();
    return rows.map((s) => ({
      id: s.id,
      time: s.time,
      symbol: s.symbol,
      strategyId: s.strategyId,
      side: s.side,
      probability: s.probability,
      decision: s.decision,
      explanation: s.explanation,
      tradeId: s.tradeId,
      strategyVersion: s.strategyVersion,
      ...buildTradePlan(s, riskLimits, equity),
    }));
  });

  // Setups that cleared the score threshold, aren't yet acted on, and are
  // recent enough to still matter -- one per symbol (the most recent),
  // skipped if there's already an open position in that symbol. This is
  // meant to be read as "you should place this trade," distinct from the
  // full /api/recommendations history table which includes everything
  // taken *and* skipped. Restricted to the ACTIVE strategy version only --
  // the shadow (inactive) version's "taken" setups never actually execute,
  // so surfacing them here would suggest a manual trade the real active
  // strategy wouldn't have taken.
  app.get("/api/recommendations/actionable", async () => {
    const now = new Date();
    const systemState = await getSystemState();
    const openSymbols = new Set((await prisma.trade.findMany({ where: { status: "open" }, select: { symbol: true } })).map((t) => t.symbol));

    const candidates = await prisma.score.findMany({
      where: { decision: "taken", acknowledged: false, strategyVersion: systemState.activeStrategyVersion },
      orderBy: { time: "desc" },
    });

    const bestPerSymbol = new Map<string, (typeof candidates)[number]>();
    for (const score of candidates) {
      if (openSymbols.has(score.symbol)) continue;
      if (bestPerSymbol.has(score.symbol)) continue; // already have the more recent one (sorted desc)
      const actionability = computeActionability(score.time, now);
      if (actionability === "expired") continue;
      bestPerSymbol.set(score.symbol, score);
    }

    const { riskLimits, equity } = await loadRiskContext();
    return [...bestPerSymbol.values()].map((s) => ({
      id: s.id,
      time: s.time,
      symbol: s.symbol,
      strategyId: s.strategyId,
      side: s.side,
      probability: s.probability,
      explanation: s.explanation,
      actionability: computeActionability(s.time, now),
      strategyVersion: s.strategyVersion,
      ...buildTradePlan(s, riskLimits, equity),
    }));
  });

  app.post<{ Params: { id: string } }>("/api/recommendations/:id/acknowledge", async (request, reply) => {
    const id = Number(request.params.id);
    const existing = await prisma.score.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "Recommendation not found" });
    await prisma.score.update({ where: { id }, data: { acknowledged: true, acknowledgedAt: new Date() } });
    return { status: "acknowledged" };
  });
}
