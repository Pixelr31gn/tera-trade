import type { FastifyInstance } from "fastify";
import { Decimal } from "decimal.js";
import { prisma } from "../../db/client.js";
import { requireApiKey } from "../../core/security.js";
import { ACTIONABLE_STALE_MINUTES, computeActionability } from "../../scoring/actionability.js";
import { computeTradePlan, RiskEngine, type RiskLimitsConfig } from "../../risk/index.js";
import { DEFAULT_INSTRUMENTS, getInstrument } from "../../marketData/instruments.js";
import { computeAccountEquity, computeAccountRiskState } from "../../engine/accounting.js";
import { ensureDefaultAccount } from "../../engine/bootstrap.js";
import { CONTINUOUS_SCAN_STRATEGY_IDS, determineConsensus } from "../../engine/loop.js";
import { getExecutionSettings } from "../../execution/mode.js";
import type { GatedScore } from "../../scoring/gate.js";
import type { StrategyVersion } from "../../scoring/ruleScorer.js";
import type { OhlcBar } from "../../regime/indicators.js";
import type { ExecutionSettings } from "../../replay/types.js";
import type { Score, RiskLimit } from "@prisma/client";

const NO_NEWS = { inRiskWindow: false, nearestEventName: null, nearestEventTime: null, minutesToEvent: null, impact: null };

function toRiskLimitsConfig(row: RiskLimit): RiskLimitsConfig {
  return {
    perTradeRiskPct: new Decimal(row.perTradeRiskPct.toString()),
    maxDailyLossPct: new Decimal(row.maxDailyLossPct.toString()),
    maxTrailingDrawdownPct: new Decimal(row.maxTrailingDrawdownPct.toString()),
    maxConsecutiveLosses: row.maxConsecutiveLosses,
    maxDailyTrades: row.maxDailyTrades,
    maxPositionSize: row.maxPositionSize,
    perTradeRiskDollars: row.perTradeRiskDollars ? new Decimal(row.perTradeRiskDollars.toString()) : null,
    perTradeProfitDollars: row.perTradeProfitDollars ? new Decimal(row.perTradeProfitDollars.toString()) : null,
    maxDailyLossDollars: row.maxDailyLossDollars ? new Decimal(row.maxDailyLossDollars.toString()) : null,
  };
}

// Replays the exact risk-engine check a real signal went through at the time
// it fired (same bars, same S/R levels an entry would've been judged
// against), against the account's *current* risk state (equity/drawdown/
// consecutive-losses circuit breakers reflect right now, not signal time --
// those are about the account, not the setup). Consensus alone isn't
// enough to say "paper will take this": a setup can reach consensus and
// still get blocked by the S/R gate or sizing, exactly like a real trade
// would.
const engine = new RiskEngine();
async function wouldPassRiskEngine(score: Score, riskLimitsRow: RiskLimit, executionSettings: ExecutionSettings): Promise<boolean> {
  if (score.signalKind !== "breakout" && score.signalKind !== "reversal") return true; // no recorded signal kind (older row) -- can't replay, don't block on it
  const bars = await prisma.bar.findMany({ where: { symbol: score.symbol, time: { lte: score.time } }, orderBy: { time: "desc" }, take: 300 });
  if (bars.length === 0) return false;
  const ohlc: OhlcBar[] = bars
    .reverse()
    .map((b) => ({ time: b.time, open: Number(b.open), high: Number(b.high), low: Number(b.low), close: Number(b.close), volume: Number(b.volume) }));

  const account = await ensureDefaultAccount();
  const equity = await computeAccountEquity(account, new Map([[score.symbol, new Decimal(score.entryPriceAtSignal.toString())]]));
  const accountState = await computeAccountRiskState(account, equity);
  const instrument = getInstrument(score.symbol);

  const assessment = engine.assessNewTrade({
    side: score.side as "long" | "short",
    entryPrice: new Decimal(score.entryPriceAtSignal.toString()),
    atrValue: new Decimal(score.atrAtSignal.toString()),
    structureSwingPrice: score.structureSwingPriceAtSignal ? new Decimal(score.structureSwingPriceAtSignal.toString()) : null,
    signalKind: score.signalKind,
    breakoutLevelPrice: score.breakoutLevelPrice ? new Decimal(score.breakoutLevelPrice.toString()) : null,
    accountState,
    limits: toRiskLimitsConfig(riskLimitsRow),
    pointValue: instrument.pointValue,
    tickSize: instrument.tickSize,
    newsStatus: NO_NEWS,
    bars: ohlc,
    // Approval here only depends on the S/R gate and circuit breakers, not
    // quantity/sizing, so this row's own single-version probability (not a
    // true cross-version average, unavailable in this per-row context) is
    // a safe stand-in -- it can't change whether the trade is approved.
    averageProbability: score.probability.toNumber(),
    takeProfitRMultiple: executionSettings.takeProfitRMultiple,
    confidenceTiers: executionSettings.confidenceTiers,
  });
  return assessment.approved;
}

// Every score row carries the hypothetical entry/ATR/structure-swing it was
// signaled at (see engine/loop.ts), so the exact stop/target/quantity plan
// can be recomputed on demand here -- via the same computeTradePlan the real
// execution path (risk/engine.ts) uses -- instead of needing to persist the
// plan as its own columns. This must stay in sync with the account's actual
// risk limits (fixed-dollar or percentage) so what's displayed always
// matches what would actually be traded.
function buildTradePlan(
  score: Score,
  riskLimits: RiskLimit,
  equity: Decimal,
  executionSettings: ExecutionSettings,
  averageProbability: number = score.probability.toNumber()
): { entryPrice: number; stopPrice: number; takeProfitPrice: number; quantity: number } {
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
    averageProbability,
    // Must match risk/engine.ts's assessNewTrade exactly -- both now read
    // the same operator-adjustable SystemState settings (2026-08-02).
    takeProfitRMultiple: executionSettings.takeProfitRMultiple,
    confidenceTiers: executionSettings.confidenceTiers,
  });

  return { entryPrice: entryPrice.toNumber(), stopPrice: plan.stopPrice.toNumber(), takeProfitPrice: plan.takeProfitPrice.toNumber(), quantity: plan.quantity };
}

async function loadRiskContext(): Promise<{ riskLimits: RiskLimit; equity: Decimal; executionSettings: ExecutionSettings }> {
  const account = await ensureDefaultAccount();
  const riskLimits = await prisma.riskLimit.findUniqueOrThrow({ where: { accountId: account.id } });
  const executionSettings = await getExecutionSettings();

  const lastBars = await Promise.all(
    DEFAULT_INSTRUMENTS.map((spec) => prisma.bar.findFirst({ where: { symbol: spec.symbol }, orderBy: { time: "desc" } }))
  );
  const lastPrices = new Map<string, Decimal>();
  for (const lastBar of lastBars) {
    if (lastBar) lastPrices.set(lastBar.symbol, new Decimal(lastBar.close.toString()));
  }
  const equity = await computeAccountEquity(account, lastPrices);

  return { riskLimits, equity, executionSettings };
}

export async function scoresRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireApiKey);

  app.get<{ Querystring: { limit?: string } }>("/api/recommendations", async (request) => {
    const limit = Math.min(Number(request.query.limit ?? 100), 500);
    const rows = await prisma.score.findMany({ orderBy: { time: "desc" }, take: limit });
    const { riskLimits, equity, executionSettings } = await loadRiskContext();
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
      ...buildTradePlan(s, riskLimits, equity, executionSettings),
    }));
  });

  // Setups that would actually be traded right now, aren't yet acted on, and
  // are recent enough to still matter -- one per symbol (the most recent),
  // skipped if there's already an open position in that symbol. This is
  // meant to be read as "you should place this trade," distinct from the
  // full /api/recommendations history table which includes everything
  // taken *and* skipped, by every version, regardless of whether it would
  // actually execute.
  //
  // "Would actually be traded" is mode-dependent, mirroring engine/loop.ts's
  // own execution decision exactly (not just "the active version scored it
  // taken"): in paper mode that means cross-version consensus via
  // determinePaperConsensus (a single version -- even the active one --
  // liking a setup is not enough if the other two strongly disagree), and
  // in analysis_only/live it's the active version's own decision, same as
  // before. Getting this wrong previously surfaced a "PLACE LONG" setup
  // where v1/v2 scored it 34%/12% -- paper correctly declined to trade it,
  // but the banner told the operator to place it anyway.
  app.get("/api/recommendations/actionable", async () => {
    const now = new Date();
    const openSymbols = new Set((await prisma.trade.findMany({ where: { status: "open" }, select: { symbol: true } })).map((t) => t.symbol));

    // Bounded to a bit past the "expired" cutoff -- old enough that nothing
    // beyond it could ever be actionable, so no need to scan further back.
    const lookback = new Date(now.getTime() - (ACTIONABLE_STALE_MINUTES + 15) * 60_000);
    const recentScores = await prisma.score.findMany({
      where: {
        time: { gte: lookback },
        acknowledged: false,
        strategyId: { notIn: [...CONTINUOUS_SCAN_STRATEGY_IDS] },
      },
      orderBy: { time: "desc" },
    });

    // Group the three shadow-scored versions of each signal back together
    // (same time/symbol/side/strategyId) so the real execution decision --
    // not just one version's own decision -- can be evaluated per signal.
    const bySignal = new Map<string, Map<StrategyVersion, Score>>();
    for (const s of recentScores) {
      const key = `${s.time.getTime()}:${s.symbol}:${s.side}:${s.strategyId}`;
      const versions = bySignal.get(key) ?? new Map<StrategyVersion, Score>();
      versions.set(s.strategyVersion as StrategyVersion, s);
      bySignal.set(key, versions);
    }

    const account = await ensureDefaultAccount();
    const riskLimitsRow = await prisma.riskLimit.findUniqueOrThrow({ where: { accountId: account.id } });
    const executionSettings = await getExecutionSettings();

    // Carries the real cross-version averageProbability alongside its
    // representative row -- confidence-tier sizing (risk/sizing.ts) needs
    // the actual consensus average, not just the representative's own
    // single-version probability, for this preview to match what the real
    // execution path would actually size.
    const representativeCandidates: { score: Score; averageProbability: number }[] = [];
    for (const versions of bySignal.values()) {
      // determineConsensus assumes all five versions were scored (that's how
      // a real signal is always shadow-scored -- see engine/loop.ts's
      // scoreAllVersions, which always scores STRATEGY_VERSIONS +
      // SHADOW_ONLY_VERSIONS together) -- a signal with an incomplete
      // version set here means its rows landed on opposite sides of the
      // lookback window boundary, predate v6's introduction (2026-08-02), or
      // some other data gap. Skip rather than guess at the missing version's
      // decision (determineConsensus itself throws on a missing "v6" entry,
      // see its own gatedByVersion.get("v6")! call). Both paper and live use
      // the same consensus rule now (2026-07-14), so this no longer branches
      // on systemState.mode.
      if (!versions.has("v1") || !versions.has("v2") || !versions.has("v3") || !versions.has("v5") || !versions.has("v6")) continue;
      const gatedByVersion = new Map<StrategyVersion, GatedScore>(
        [...versions.entries()].map(([v, s]) => [
          v,
          { probability: s.probability.toNumber(), decision: s.decision as GatedScore["decision"] } as GatedScore,
        ])
      );
      const consensus = determineConsensus(gatedByVersion);
      if (!consensus.taken || !consensus.representativeVersion) continue;
      const representative = versions.get(consensus.representativeVersion);
      if (!representative) continue;
      representativeCandidates.push({ score: representative, averageProbability: consensus.averageProbability });
    }
    // Each check is its own DB round-trip chain (bar fetch + equity/risk-state
    // computation) -- these are independent per candidate, and the candidate
    // list here is already bounded to one row per distinct signal in the
    // lookback window (naturally small), so a plain Promise.all is fine
    // without a concurrency cap.
    const riskChecks = await Promise.all(representativeCandidates.map((c) => wouldPassRiskEngine(c.score, riskLimitsRow, executionSettings)));
    const candidates = representativeCandidates.filter((_, i) => riskChecks[i]);
    candidates.sort((a, b) => b.score.time.getTime() - a.score.time.getTime());

    const bestPerSymbol = new Map<string, (typeof candidates)[number]>();
    for (const candidate of candidates) {
      const score = candidate.score;
      if (openSymbols.has(score.symbol)) continue;
      if (bestPerSymbol.has(score.symbol)) continue; // already have the more recent one (sorted desc)
      const actionability = computeActionability(score.time, now);
      if (actionability === "expired") continue;
      bestPerSymbol.set(score.symbol, candidate);
    }

    const { riskLimits, equity } = await loadRiskContext();
    return [...bestPerSymbol.values()].map(({ score: s, averageProbability }) => ({
      id: s.id,
      time: s.time,
      symbol: s.symbol,
      strategyId: s.strategyId,
      side: s.side,
      probability: s.probability,
      explanation: s.explanation,
      actionability: computeActionability(s.time, now),
      strategyVersion: s.strategyVersion,
      ...buildTradePlan(s, riskLimits, equity, executionSettings, averageProbability),
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
