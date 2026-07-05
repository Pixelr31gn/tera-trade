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
  if (mode === TradingMode.LIVE) {
    if (settings.brokerKind !== BrokerKind.PROJECTX) {
      throw new ModeChangeError("Cannot switch to LIVE mode: BROKER_KIND is not set to 'projectx'");
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
