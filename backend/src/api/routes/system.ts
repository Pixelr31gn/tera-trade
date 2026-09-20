import type { FastifyInstance } from "fastify";
import { getSettings, TradingMode } from "../../core/config.js";
import { requireApiKey } from "../../core/security.js";
import {
  clearKillSwitch,
  type ConfidenceTierInput,
  getSystemState,
  isLiveBrokerConnected,
  isTradeseaLiveBrokerConnected,
  ModeChangeError,
  setActiveStrategyVersion,
  setAssistantActionsEnabled,
  setConfidenceTiers,
  setMode,
  setTakeProfitRMultiple,
  setTradeseaLiveEnabled,
} from "../../execution/mode.js";
import type { StrategyVersion } from "../../scoring/ruleScorer.js";
import { ACTIVE_INSTRUMENTS } from "../../marketData/instruments.js";
import { disableSymbol, enableSymbol, getDisabledSymbols } from "../../engine/symbolEnablementCache.js";

/** Shared by GET /api/system/state and the assistant's get_system_state tool. */
export async function getSystemStateSnapshot() {
    const state = await getSystemState();
    const settings = getSettings();
    const disabledSymbols = await getDisabledSymbols();
    return {
      // Per-instrument executable toggle (2026-09-03, operator request: "add
      // a toggle so i can turn off which markets are executable") -- every
      // symbol currently in ACTIVE_INSTRUMENTS, with whether it's currently
      // allowed to open new trades. Disabling a symbol doesn't touch an
      // already-open position on it -- see engine/loop.ts's manageOpenTrades,
      // which is unconditional on this toggle.
      tradableSymbols: ACTIVE_INSTRUMENTS.map((i) => ({ symbol: i.symbol, enabled: !disabledSymbols.has(i.symbol) })),
      mode: state.mode,
      killSwitch: state.killSwitch,
      killSwitchReason: state.killSwitchReason,
      brokerKind: settings.brokerKind,
      // Whether the live broker is actually connected right now -- distinct
      // from brokerKind (which just reflects static env config): paper is
      // always available regardless of either, live needs this to be true
      // (see execution/mode.ts's setMode). Lets the UI accurately
      // enable/disable the LIVE toggle instead of assuming config = reality.
      liveBrokerConnected: isLiveBrokerConnected(),
      // Tradesea's own independent status block -- see execution/mode.ts's
      // setTradeseaLiveEnabled. `enabled` reflects static env config
      // (TRADESEA_ENABLED); `liveEnabled` reflects the runtime DB switch;
      // `liveBrokerConnected` reflects whether the Tradesea CDP session is
      // actually up right now -- same three-part shape as the TopstepX
      // fields above, just namespaced separately since neither gate widens
      // the other.
      tradesea: {
        enabled: settings.tradeseaEnabled,
        liveEnabled: state.tradeseaLiveEnabled,
        liveBrokerConnected: isTradeseaLiveBrokerConnected(),
      },
      // The AI assistant's own independent status block -- see
      // execution/mode.ts's setAssistantActionsEnabled. `enabled` reflects
      // static env config (ASSISTANT_ENABLED); `actionsEnabled` reflects the
      // runtime DB switch that gates its real-money write-tools -- this is
      // the "one flip" that disables only the assistant's autonomous
      // execution, independent of every other gate in this response.
      assistant: {
        enabled: settings.assistantEnabled,
        actionsEnabled: state.assistantActionsEnabled,
      },
      minScoreThreshold: settings.minScoreThreshold,
      activeStrategyVersion: state.activeStrategyVersion,
      takeProfitRMultiple: state.takeProfitRMultiple,
      confidenceTiers: [
        { threshold: state.confidenceTier1Threshold, quantity: state.confidenceTier1Quantity },
        { threshold: state.confidenceTier2Threshold, quantity: state.confidenceTier2Quantity },
        { threshold: state.confidenceTier3Threshold, quantity: state.confidenceTier3Quantity },
      ],
      updatedAt: state.updatedAt,
    };
}

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireApiKey);

  app.get("/api/system/state", async () => getSystemStateSnapshot());

  app.post<{ Body: { mode: TradingMode } }>("/api/system/mode", async (request, reply) => {
    try {
      const state = await setMode(request.body.mode);
      return { mode: state.mode };
    } catch (err) {
      if (err instanceof ModeChangeError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post<{ Body: { enabled: boolean } }>("/api/system/tradesea/live-enabled", async (request, reply) => {
    try {
      const state = await setTradeseaLiveEnabled(request.body.enabled);
      return { tradeseaLiveEnabled: state.tradeseaLiveEnabled };
    } catch (err) {
      if (err instanceof ModeChangeError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post<{ Body: { enabled: boolean } }>("/api/system/assistant/actions-enabled", async (request, reply) => {
    try {
      const state = await setAssistantActionsEnabled(request.body.enabled);
      return { assistantActionsEnabled: state.assistantActionsEnabled };
    } catch (err) {
      if (err instanceof ModeChangeError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post("/api/system/kill-switch/clear", async () => {
    const state = await clearKillSwitch();
    return { killSwitch: state.killSwitch };
  });

  // Per-instrument executable toggle (2026-09-03, operator request) -- does
  // NOT touch an already-open position on the symbol, only whether NEW
  // trades can open (see engine/loop.ts's evaluateNewSignals/
  // scanSymbolContinuously, and replay/decisionCore.ts's decideOnBar).
  app.post<{ Params: { symbol: string }; Body: { enabled: boolean; reason?: string } }>(
    "/api/system/symbols/:symbol/executable",
    async (request, reply) => {
      const symbol = request.params.symbol.toUpperCase();
      if (!ACTIVE_INSTRUMENTS.some((i) => i.symbol === symbol)) {
        return reply.code(404).send({ error: `"${symbol}" is not an active instrument` });
      }
      if (request.body.enabled) {
        await enableSymbol(symbol);
      } else {
        await disableSymbol(symbol, request.body.reason?.trim() || "disabled from the dashboard toggle");
      }
      return { symbol, enabled: request.body.enabled };
    }
  );

  // Vestigial as of 2026-07-14: neither paper nor live execution reads
  // activeStrategyVersion anymore -- both now use the v1/v2/v3 consensus
  // rule (see engine/loop.ts's determineConsensus). Left in place (rather
  // than removed) since it's still informational/harmless, but changing it
  // no longer changes what actually trades.
  app.post<{ Body: { version: StrategyVersion } }>("/api/system/strategy-version", async (request, reply) => {
    // v7 was missing here since its introduction (2026-08-07) -- an
    // oversight, not intentional; this list was never updated to track
    // scoring/ruleScorer.ts's own StrategyVersion type, which has included
    // "v7" the whole time. Confirmed live (2026-08-11): selecting v7 in the
    // Strategy page failed with this exact 400 before the fix.
    const valid: StrategyVersion[] = ["v1", "v2", "v3", "v4", "v5", "v6", "v7"];
    if (!valid.includes(request.body.version)) {
      return reply.code(400).send({ error: `version must be one of ${valid.join(", ")}` });
    }
    const state = await setActiveStrategyVersion(request.body.version);
    return { activeStrategyVersion: state.activeStrategyVersion };
  });

  // Shared by every strategy/scoring version -- see risk/stops.ts's
  // computeInitialStop and SystemState.takeProfitRMultiple's schema comment.
  app.post<{ Body: { value: number } }>("/api/system/take-profit-r-multiple", async (request, reply) => {
    try {
      const state = await setTakeProfitRMultiple(request.body.value);
      return { takeProfitRMultiple: state.takeProfitRMultiple };
    } catch (err) {
      if (err instanceof ModeChangeError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  // Exactly 3 tiers -- see risk/sizing.ts's computeConfidenceTierQuantity.
  app.post<{ Body: { tiers: ConfidenceTierInput[] } }>("/api/system/confidence-tiers", async (request, reply) => {
    if (!Array.isArray(request.body.tiers) || request.body.tiers.length !== 3) {
      return reply.code(400).send({ error: "tiers must be an array of exactly 3 { threshold, quantity } entries" });
    }
    try {
      const [a, b, c] = request.body.tiers as [ConfidenceTierInput, ConfidenceTierInput, ConfidenceTierInput];
      const state = await setConfidenceTiers([a, b, c]);
      return {
        confidenceTiers: [
          { threshold: state.confidenceTier1Threshold, quantity: state.confidenceTier1Quantity },
          { threshold: state.confidenceTier2Threshold, quantity: state.confidenceTier2Quantity },
          { threshold: state.confidenceTier3Threshold, quantity: state.confidenceTier3Quantity },
        ],
      };
    } catch (err) {
      if (err instanceof ModeChangeError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });
}
