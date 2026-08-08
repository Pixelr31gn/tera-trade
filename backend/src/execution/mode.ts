/**
 * Trading-mode gate.
 *
 * `system_state` is a singleton row (id=1). The engine boots in
 * ANALYSIS_ONLY and stays there until an operator explicitly changes it.
 * Reaching LIVE additionally requires `settings.liveTradingConfirmed=true` --
 * a second, separate flag from `tradingMode` -- so nothing can
 * auto-escalate from paper to live by itself.
 */
import { prisma } from "../db/client.js";
import { getSettings, TradingMode } from "../core/config.js";
import type { StrategyVersion } from "../scoring/ruleScorer.js";
import type { SystemState } from "@prisma/client";

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
