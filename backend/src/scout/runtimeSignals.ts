/**
 * query_recent_trades_and_sessions -- Scout's read-only window into Tera Trade's own runtime data.
 * Every field here comes from tables/functions that already exist for the trading system itself
 * (Score/Trade's own `explanation` columns -- see explain/engine.ts -- AssistantAction's audit
 * trail, DisabledStrategy/DisabledSymbol, and analytics.ts's existing session/version comparisons).
 * Nothing here writes to, or was added specifically for, the trading system -- see this repo's own
 * instruction to reuse what's already logged before adding anything new. Scout never imports from
 * risk/, execution/, or brokers/, and never calls a Prisma write against a trading table.
 */
import { prisma } from "../db/client.js";
import { cached, computeSessionPerformanceForAllSessions, computeStrategyComparison } from "../api/routes/analytics.js";

const DEFAULT_LOOKBACK_HOURS = 72;

function lookbackSince(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

interface RegimeBucketStat {
  strategyId: string;
  regimeTrendAtEntry: string | null;
  regimeVolAtEntry: string | null;
  count: number;
  wins: number;
  losses: number;
  avgPnl: number | null;
  sampleExplanations: string[];
}

/** Groups recent closed trades by (strategyId, regime) so a strategy losing repeatedly in the SAME regime stands out, not just an overall win rate. Uses Trade.regimeTrendAtEntry/regimeVolAtEntry/pnl/explanation -- all already persisted at trade-entry/exit time, no new columns. */
async function summarizeRegimePerformance(since: Date): Promise<RegimeBucketStat[]> {
  const trades = await prisma.trade.findMany({
    where: { entryTime: { gte: since }, status: "closed" },
    select: { strategyId: true, regimeTrendAtEntry: true, regimeVolAtEntry: true, pnl: true, explanation: true },
    orderBy: { entryTime: "desc" },
    take: 500,
  });

  const buckets = new Map<string, RegimeBucketStat>();
  for (const t of trades) {
    const key = `${t.strategyId}|${t.regimeTrendAtEntry ?? "unknown"}|${t.regimeVolAtEntry ?? "unknown"}`;
    const bucket = buckets.get(key) ?? {
      strategyId: t.strategyId,
      regimeTrendAtEntry: t.regimeTrendAtEntry,
      regimeVolAtEntry: t.regimeVolAtEntry,
      count: 0,
      wins: 0,
      losses: 0,
      avgPnl: null,
      sampleExplanations: [],
    };
    bucket.count++;
    const pnl = t.pnl !== null ? Number(t.pnl) : null;
    if (pnl !== null) {
      if (pnl >= 0) bucket.wins++;
      else bucket.losses++;
      bucket.avgPnl = ((bucket.avgPnl ?? 0) * (bucket.count - 1) + pnl) / bucket.count;
    }
    if (bucket.sampleExplanations.length < 2 && t.explanation) bucket.sampleExplanations.push(t.explanation);
    buckets.set(key, bucket);
  }

  return [...buckets.values()].sort((a, b) => b.count - a.count);
}

interface AssistantActivitySummary {
  toolName: string;
  count: number;
  successCount: number;
  errorCount: number;
  latestSummary: string;
  latestAt: string;
  sampleErrors: string[];
}

/**
 * AssistantAction is the trading assistant's own existing audit log (backend/src/assistant/
 * tools.ts's withAssistantAudit) -- every real action it has ever taken, write tool or scheduler-
 * triggered, success or failure, is already here. Previously this only surfaced a narrow allowlist
 * of "correction-shaped" tool names (set_confidence_tiers etc.) -- broadened to cover every
 * toolName in the window so Scout can actually "go through recent actions the assistant has been
 * performing" rather than a pre-filtered slice of them. A routine call (e.g.
 * set_daily_plan_zones, fired by dailyPlanScheduler.ts every session) is just as valid a
 * frequency+friction candidate as a manual correction is -- an LLM call repeated 3x/day for
 * something mechanical is exactly the kind of thing worth pitching a cheaper/simpler agent for.
 */
async function summarizeAssistantActivity(since: Date): Promise<AssistantActivitySummary[]> {
  const actions = await prisma.assistantAction.findMany({
    where: { createdAt: { gte: since } },
    select: { toolName: true, resultSummary: true, status: true, errorMessage: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });

  const byTool = new Map<string, AssistantActivitySummary>();
  for (const a of actions) {
    const existing = byTool.get(a.toolName) ?? { toolName: a.toolName, count: 0, successCount: 0, errorCount: 0, latestSummary: a.resultSummary, latestAt: a.createdAt.toISOString(), sampleErrors: [] };
    existing.count++;
    if (a.status === "error") {
      existing.errorCount++;
      if (existing.sampleErrors.length < 3 && a.errorMessage) existing.sampleErrors.push(a.errorMessage);
    } else {
      existing.successCount++;
    }
    byTool.set(a.toolName, existing);
  }
  return [...byTool.values()].sort((a, b) => b.count - a.count);
}

export interface RuntimeSignalSnapshot {
  windowHours: number;
  sessionPerformance: Awaited<ReturnType<typeof computeSessionPerformanceForAllSessions>>;
  strategyComparison: Awaited<ReturnType<typeof computeStrategyComparison>>;
  regimePerformance: RegimeBucketStat[];
  assistantActivity: AssistantActivitySummary[];
  disabledStrategies: { strategyId: string; reason: string; createdAt: string }[];
  disabledSymbols: { symbol: string; reason: string; createdAt: string }[];
  notes: string[];
}

export async function queryRecentTradesAndSessions(lookbackHours = DEFAULT_LOOKBACK_HOURS): Promise<RuntimeSignalSnapshot> {
  const since = lookbackSince(lookbackHours);

  const [sessionPerformance, strategyComparison, regimePerformance, assistantActivity, disabledStrategies, disabledSymbols] = await Promise.all([
    // Reused verbatim -- these already answer "which version/session is underperforming," cached
    // 24h the same way the dashboard/assistant read them (api/routes/analytics.ts).
    cached("session-performance", () => computeSessionPerformanceForAllSessions()),
    cached("strategy-comparison", () => computeStrategyComparison()),
    summarizeRegimePerformance(since),
    summarizeAssistantActivity(since),
    prisma.disabledStrategy.findMany({ select: { strategyId: true, reason: true, createdAt: true } }),
    prisma.disabledSymbol.findMany({ select: { symbol: true, reason: true, createdAt: true } }),
  ]);

  const notes: string[] = [];
  // Known gap, deliberately not closed here (scope: read-only, never touches execution/risk-
  // adjacent routes -- see this file's header comment): a parameter changed directly from the
  // dashboard (api/routes/system.ts) rather than through the assistant's chat tools leaves no
  // audit-trail row anywhere -- only SystemState.updatedAt (a single timestamp, no history).
  // assistantActivity above can only see assistant-initiated actions.
  notes.push("assistantActivity only reflects actions taken via the trading assistant's chat/scheduler tools (AssistantAction) -- direct dashboard edits to the same settings have no history log yet.");

  return {
    windowHours: lookbackHours,
    sessionPerformance,
    strategyComparison,
    regimePerformance: regimePerformance.slice(0, 20),
    assistantActivity,
    disabledStrategies: disabledStrategies.map((d) => ({ ...d, createdAt: d.createdAt.toISOString() })),
    disabledSymbols: disabledSymbols.map((d) => ({ ...d, createdAt: d.createdAt.toISOString() })),
    notes,
  };
}
