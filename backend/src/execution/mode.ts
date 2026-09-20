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

// Tradesea's own connection-state flag, mirroring liveBrokerConnected above
// but tracked independently -- TopstepX and Tradesea connect/disconnect on
// their own separate CDP sessions, so one going down must never be confused
// with the other's state.
let tradeseaLiveBrokerConnected = false;
export function setTradeseaLiveBrokerConnected(connected: boolean): void {
  tradeseaLiveBrokerConnected = connected;
}
export function isTradeseaLiveBrokerConnected(): boolean {
  return tradeseaLiveBrokerConnected;
}

export async function getSystemState(): Promise<SystemState> {
  let state = await prisma.systemState.findUnique({ where: { id: 1 } });
  if (!state) {
    const settings = getSettings();
    state = await prisma.systemState.create({
      data: { id: 1, mode: settings.tradingMode, killSwitch: false },
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

// Tradesea's own live-enable switch -- deliberately NOT tied to `mode`
// above, which stays TopstepX's own gate. This lets Tradesea go live against
// its own account while TopstepX stays in whatever mode it's already in
// (e.g. testing Tradesea against its sandbox account while TopstepX keeps
// trading paper), and vice versa -- see CLAUDE.md invariant 3 ("never widen
// a live-trading gate"): this is a second, fully independent gate, not a
// widening of the first one.
export async function setTradeseaLiveEnabled(enabled: boolean): Promise<SystemState> {
  const settings = getSettings();
  if (enabled) {
    if (!settings.tradeseaEnabled) {
      throw new ModeChangeError("Cannot enable Tradesea live trading: TRADESEA_ENABLED must be set to true");
    }
    if (!tradeseaLiveBrokerConnected) {
      throw new ModeChangeError("Cannot enable Tradesea live trading: the Tradesea broker is not currently connected");
    }
    if (!settings.tradeseaLiveTradingConfirmed) {
      throw new ModeChangeError(
        "Cannot enable Tradesea live trading: TRADESEA_LIVE_TRADING_CONFIRMED must be explicitly set to true, separately from TRADESEA_ENABLED"
      );
    }
  }

  await getSystemState();
  return prisma.systemState.update({ where: { id: 1 }, data: { tradeseaLiveEnabled: enabled } });
}

// The AI assistant's own independent kill-switch for its autonomous (no
// human confirmation) execution capability -- deliberately NOT tied to
// `mode`/`tradeseaLiveEnabled` above. Flipping this off disables ONLY the
// assistant's write-tools; it never touches TopstepX's or Tradesea's own
// trading gates at all. Same "second, fully independent gate, not a
// widening of the first one" reasoning as setTradeseaLiveEnabled's own
// comment -- see CLAUDE.md invariant 3.
export async function setAssistantActionsEnabled(enabled: boolean): Promise<SystemState> {
  const settings = getSettings();
  if (enabled) {
    if (!settings.assistantEnabled) {
      throw new ModeChangeError("Cannot enable assistant actions: ASSISTANT_ENABLED must be set to true");
    }
    if (!settings.geminiApiKey) {
      throw new ModeChangeError("Cannot enable assistant actions: GEMINI_API_KEY is not configured");
    }
    if (!settings.assistantActionsConfirmed) {
      throw new ModeChangeError(
        "Cannot enable assistant actions: ASSISTANT_ACTIONS_CONFIRMED must be explicitly set to true, separately from ASSISTANT_ENABLED"
      );
    }
  }

  await getSystemState();
  return prisma.systemState.update({ where: { id: 1 }, data: { assistantActionsEnabled: enabled } });
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

// Exactly 3 tiers, strictly ascending by threshold -- matches
// risk/sizing.ts's computeConfidenceTierQuantity, which walks them
// highest-first to find the first one the consensus average clears.
// Pure/exported separately from setConfidenceTiers below (2026-08-11,
// operator report: "make sure this confidence tier pricing works
// properly") so it's directly unit-testable without a DB connection --
// execution/ is DB-coupled per CLAUDE.md's module map, but there's no
// reason the validation itself needs to be.
export function validateConfidenceTierInputs(tiers: [ConfidenceTierInput, ConfidenceTierInput, ConfidenceTierInput]): ConfidenceTierInput[] {
  const sorted = [...tiers].sort((a, b) => a.threshold - b.threshold);
  for (const t of sorted) {
    if (!(t.threshold > 0 && t.threshold < 1)) throw new ModeChangeError("each tier threshold must be between 0 and 1");
    if (!Number.isInteger(t.quantity) || t.quantity < 1) throw new ModeChangeError("each tier quantity must be a positive integer");
  }
  // Genuinely missing until now -- the frontend has always told the
  // operator "thresholds must be strictly ascending," but nothing here
  // actually enforced it. Two equal thresholds would silently collapse to
  // 2 effective tiers instead of 3 (risk/sizing.ts's
  // computeConfidenceTierQuantity would still return a valid quantity for
  // either, since it just finds the first descending-sorted match, so this
  // wasn't a crash risk -- but it violated the one constraint the UI
  // promised was being checked).
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.threshold <= sorted[i - 1]!.threshold) {
      throw new ModeChangeError("tier thresholds must be strictly ascending -- two tiers cannot share or reverse a threshold");
    }
  }
  return sorted;
}

export async function setConfidenceTiers(tiers: [ConfidenceTierInput, ConfidenceTierInput, ConfidenceTierInput]): Promise<SystemState> {
  const sorted = validateConfidenceTierInputs(tiers);
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
