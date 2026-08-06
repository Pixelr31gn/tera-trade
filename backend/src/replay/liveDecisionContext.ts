/**
 * DecisionContext backed by the real, running system: the existing TTL
 * caches (dailyTrendCache, dailyEmaTrendCache, openingRangeCache,
 * fixedTargetEdgeCache, liveOrderFlowCache), prisma, and news/risk.ts.
 *
 * Every method ignores its `at` parameter and answers from "now," same as
 * before this interface existed -- `at` only matters to
 * ReplayDecisionContext. This is what "live should be byte-identical" (see
 * .claude/rules/replay-harness.md) actually means in code: this class does
 * not change what evaluateNewSignals used to compute inline, it just moves
 * the same calls behind an interface so decideOnBar can't tell which
 * implementation it's talking to.
 *
 * accountState/riskLimits/accountId are resolved ONCE by the caller (see
 * engine/loop.ts's onNewBar) and injected here rather than fetched inside
 * this class -- DecisionContext.accountState/riskLimits are synchronous by
 * design (ReplayDecisionContext answers from an in-memory synthetic account
 * with no DB round-trip), and live's real computeAccountEquity/
 * computeAccountRiskState/riskLimit lookup are genuinely async. Resolving
 * them once per bar, before decideOnBar's strategy loop runs, matches live's
 * actual behavior anyway: account state doesn't change mid-loop within a
 * single bar's decision (no trade closes between one strategy's attempt and
 * the next), so computing it once per bar rather than once per strategy
 * attempted is a no-op change to results, not an approximation.
 */
import { prisma } from "../db/client.js";
import { getDailyTrend } from "../engine/dailyTrendCache.js";
import { getDailyEma20Trend } from "../engine/dailyEmaTrendCache.js";
import { getFixedTargetEdge } from "../engine/fixedTargetEdgeCache.js";
import { getLatestOrderFlowSnapshot } from "../engine/liveOrderFlowCache.js";
import { getOpeningRangeStats } from "../engine/openingRangeCache.js";
import { getNewsRiskStatus } from "../news/risk.js";
import { loadRecentBars } from "../engine/bootstrap.js";
import type { AccountRiskState, RiskLimitsConfig } from "../risk/index.js";
import type { DecisionContext, ExecutionSettings } from "./types.js";

export class LiveDecisionContext implements DecisionContext {
  constructor(
    private deps: {
      accountId: number;
      accountState: AccountRiskState;
      riskLimits: RiskLimitsConfig;
      executionSettings: ExecutionSettings;
    },
  ) {}

  async recentBars(symbol: string, count: number) {
    return loadRecentBars(symbol, count);
  }

  async dailyTrend(symbol: string) {
    return getDailyTrend(symbol);
  }

  async dailyEmaTrend(symbol: string) {
    return getDailyEma20Trend(symbol);
  }

  async newsRisk(at: Date) {
    // The one cache that was already time-parameterized before this
    // interface existed -- `at` is real here, not ignored.
    return getNewsRiskStatus(at);
  }

  async openingRange(symbol: string) {
    return getOpeningRangeStats(symbol);
  }

  async fixedTargetEdge(symbol: string, session: Parameters<typeof getFixedTargetEdge>[1], side: "long" | "short", at: Date) {
    return getFixedTargetEdge(symbol, session, side, at);
  }

  orderFlow(symbol: string) {
    return getLatestOrderFlowSnapshot(symbol);
  }

  accountState(): AccountRiskState {
    return this.deps.accountState;
  }

  riskLimits(): RiskLimitsConfig {
    return this.deps.riskLimits;
  }

  executionSettings(): ExecutionSettings {
    return this.deps.executionSettings;
  }

  contextDegradations(): string[] {
    return [];
  }

  async hasOpenPosition(symbol: string): Promise<boolean> {
    const open = await prisma.trade.findFirst({
      where: { accountId: this.deps.accountId, symbol, status: "open" },
      select: { id: true },
    });
    return open !== null;
  }
}
