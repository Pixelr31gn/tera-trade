/**
 * Trading-mode gate.
 *
 * `system_state` is a singleton row (id=1). The engine boots in
 * ANALYSIS_ONLY and stays there until an operator explicitly changes it.
 * Reaching LIVE additionally requires `settings.liveTradingConfirmed=true` --
 * a second, separate flag from `tradingMode` -- so nothing can
 * auto-escalate from paper to live by itself.
 */
import { Decimal } from "decimal.js";
import { prisma } from "../db/client.js";
import { getSettings, TradingMode } from "../core/config.js";
import type { StrategyVersion } from "../scoring/ruleScorer.js";
import type { SystemState } from "@prisma/client";
import type { ExecutionSettings } from "../replay/types.js";

export class ModeChangeError extends Error {}

// Set by index.ts once the live broker (ProjectX/browser-control, if
// configured) has actually connected -- reflects real runtime state, not a
// static env var. The engine (see engine/loop.ts's TradingEngine) now holds
// BOTH a simulated and a live broker simultaneously, so PAPER is always
// reachable regardless of BROKER_KIND (it always resolves to the simulated
// broker) and LIVE is reachable exactly when the live broker is actually up
// -- switching between them from the UI/API no longer requires a restart
// (2026-07-15 operator request: "I shouldn't have to come into this
// console and code it").
let liveBrokerConnected = false;
export function setLiveBrokerConnected(connected: boolean): void {
  liveBrokerConnected = connected;
}
export function isLiveBrokerConnected(): boolean {
  return liveBrokerConnected;
}

export async function getSystemState(): Promise<SystemState> {
  let state = await prisma.systemState.findUnique({ where: { id: 1 } });
  if (!state) {
    const settings = getSettings();
    state = await prisma.systemState.create({
      data: { id: 1, mode: settings.tradingMode, killSwitch: false, executionDecisionEngineEnabled: settings.executionDecisionEngineEnabled },
    });
  }
  return state;
}

/**
 * Builds the ExecutionSettings bag (replay/types.ts) risk/ layer functions
 * take as a plain parameter -- risk/ stays DB-free per CLAUDE.md's purity
 * rule, so every caller (LiveDecisionContext, the recommendation-preview
 * endpoint) resolves this here rather than reading prisma.systemState
 * directly themselves.
 */
export async function getExecutionSettings(): Promise<ExecutionSettings> {
  const state = await getSystemState();
  const tiers: [number, number][] = [
    [Number(state.confidenceTier1Threshold.toString()), state.confidenceTier1Quantity],
    [Number(state.confidenceTier2Threshold.toString()), state.confidenceTier2Quantity],
    [Number(state.confidenceTier3Threshold.toString()), state.confidenceTier3Quantity],
  ];
  return { takeProfitRMultiple: new Decimal(state.takeProfitRMultiple.toString()), confidenceTiers: tiers };
}

export async function setMode(mode: TradingMode): Promise<SystemState> {
  const settings = getSettings();

  // PAPER is always reachable -- TradingEngine.brokerForMode hard-codes
  // PAPER (and ANALYSIS_ONLY) to always resolve to the simulated broker
  // object itself, regardless of what BROKER_KIND happens to be configured
  // to. That's a stronger guarantee than gating on env config here ever
  // was: it can't drift out of sync with what the engine actually does.
  if (mode === TradingMode.LIVE) {
    if (!liveBrokerConnected) {
      throw new ModeChangeError("Cannot switch to LIVE mode: no live broker (ProjectX/browser-control) is currently connected");
    }
    if (!settings.liveTradingConfirmed) {
      throw new ModeChangeError(
        "Cannot switch to LIVE mode: LIVE_TRADING_CONFIRMED must be explicitly set to true, separately from TRADING_MODE"
      );
    }
  }

  await getSystemState();
  return prisma.systemState.update({ where: { id: 1 }, data: { mode } });
}

export async function clearKillSwitch(): Promise<SystemState> {
  await getSystemState();
  return prisma.systemState.update({ where: { id: 1 }, data: { killSwitch: false, killSwitchReason: null } });
}

export async function tripKillSwitch(reason: string): Promise<SystemState> {
  await getSystemState();
  return prisma.systemState.update({ where: { id: 1 }, data: { killSwitch: true, killSwitchReason: reason } });
}

// Both strategy versions are always shadow-scored on every signal (see
// engine/loop.ts) -- this only controls which version's decisions are
// allowed to actually reach execution, so switching is instant and never
// loses data: the version you switch away from just keeps quietly
// accumulating comparison data in the background.
export async function setActiveStrategyVersion(version: StrategyVersion): Promise<SystemState> {
  await getSystemState();
  return prisma.systemState.update({ where: { id: 1 }, data: { activeStrategyVersion: version } });
}

// Dashboard-toggleable, live -- no restart needed (see engine/loop.ts's
// attemptExecution, which reads this fresh from the DB every time instead of
// the once-cached EXECUTION_DECISION_ENGINE_ENABLED env value it seeds from).
export async function setExecutionDecisionEngineEnabled(enabled: boolean): Promise<SystemState> {
  await getSystemState();
  return prisma.systemState.update({ where: { id: 1 }, data: { executionDecisionEngineEnabled: enabled } });
}

// Shared by every strategy/scoring version (risk/stops.ts's
// computeInitialStop has no per-strategy or per-version branch) -- see
// schema.prisma's SystemState.takeProfitRMultiple comment.
export async function setTakeProfitRMultiple(multiple: number): Promise<SystemState> {
  if (!(multiple > 0)) throw new ModeChangeError("takeProfitRMultiple must be a positive number");
  await getSystemState();
  return prisma.systemState.update({ where: { id: 1 }, data: { takeProfitRMultiple: multiple } });
}

export interface ConfidenceTierInput {
  threshold: number;
  quantity: number;
}

// Exactly 3 tiers, ascending by threshold -- matches risk/sizing.ts's
// computeConfidenceTierQuantity, which walks them highest-first to find the
// first one the consensus average clears.
export async function setConfidenceTiers(tiers: [ConfidenceTierInput, ConfidenceTierInput, ConfidenceTierInput]): Promise<SystemState> {
  const sorted = [...tiers].sort((a, b) => a.threshold - b.threshold);
  for (const t of sorted) {
    if (!(t.threshold > 0 && t.threshold < 1)) throw new ModeChangeError("each tier threshold must be between 0 and 1");
    if (!Number.isInteger(t.quantity) || t.quantity < 1) throw new ModeChangeError("each tier quantity must be a positive integer");
  }
  await getSystemState();
  return prisma.systemState.update({
    where: { id: 1 },
    data: {
      confidenceTier1Threshold: sorted[0]!.threshold, confidenceTier1Quantity: sorted[0]!.quantity,
      confidenceTier2Threshold: sorted[1]!.threshold, confidenceTier2Quantity: sorted[1]!.quantity,
      confidenceTier3Threshold: sorted[2]!.threshold, confidenceTier3Quantity: sorted[2]!.quantity,
    },
  });
}
