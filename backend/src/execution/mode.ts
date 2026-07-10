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
import { BrokerKind, getSettings, TradingMode } from "../core/config.js";
import type { StrategyVersion } from "../scoring/ruleScorer.js";
import type { SystemState } from "@prisma/client";

export class ModeChangeError extends Error {}

export async function getSystemState(): Promise<SystemState> {
  let state = await prisma.systemState.findUnique({ where: { id: 1 } });
  if (!state) {
    const settings = getSettings();
    state = await prisma.systemState.create({ data: { id: 1, mode: settings.tradingMode, killSwitch: false } });
  }
  return state;
}

export async function setMode(mode: TradingMode): Promise<SystemState> {
  const settings = getSettings();

  // PAPER must never place a real order -- executeIfApproved calls
  // broker.placeOrder() for any mode other than ANALYSIS_ONLY, so without this
  // check, "paper" was only a naming convention, not an enforced guarantee:
  // BROKER_KIND=projectx or browser_control + TRADING_MODE=paper would have
  // silently placed real orders under a label that implies zero real risk.
  if (mode === TradingMode.PAPER && settings.brokerKind !== BrokerKind.SIMULATED) {
    throw new ModeChangeError("Cannot switch to PAPER mode: BROKER_KIND must be 'simulated' -- paper mode guarantees no real orders are placed");
  }

  if (mode === TradingMode.LIVE) {
    if (settings.brokerKind !== BrokerKind.PROJECTX && settings.brokerKind !== BrokerKind.BROWSER_CONTROL) {
      throw new ModeChangeError("Cannot switch to LIVE mode: BROKER_KIND must be 'projectx' or 'browser_control'");
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
