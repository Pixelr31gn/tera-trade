import type { FastifyInstance } from "fastify";
import { getSettings, TradingMode } from "../../core/config.js";
import { requireApiKey } from "../../core/security.js";
import {
  clearKillSwitch,
  type ConfidenceTierInput,
  getSystemState,
  isLiveBrokerConnected,
  ModeChangeError,
  setActiveStrategyVersion,
  setConfidenceTiers,
  setExecutionDecisionEngineEnabled,
  setMode,
  setTakeProfitRMultiple,
} from "../../execution/mode.js";
import type { StrategyVersion } from "../../scoring/ruleScorer.js";

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireApiKey);

  app.get("/api/system/state", async () => {
    const state = await getSystemState();
    const settings = getSettings();
    return {
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
      minScoreThreshold: settings.minScoreThreshold,
      activeStrategyVersion: state.activeStrategyVersion,
      executionDecisionEngineEnabled: state.executionDecisionEngineEnabled,
      takeProfitRMultiple: state.takeProfitRMultiple,
      confidenceTiers: [
        { threshold: state.confidenceTier1Threshold, quantity: state.confidenceTier1Quantity },
        { threshold: state.confidenceTier2Threshold, quantity: state.confidenceTier2Quantity },
        { threshold: state.confidenceTier3Threshold, quantity: state.confidenceTier3Quantity },
      ],
      updatedAt: state.updatedAt,
    };
  });

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

  app.post("/api/system/kill-switch/clear", async () => {
    const state = await clearKillSwitch();
    return { killSwitch: state.killSwitch };
  });

  // Vestigial as of 2026-07-14: neither paper nor live execution reads
  // activeStrategyVersion anymore -- both now use the v1/v2/v3 consensus
  // rule (see engine/loop.ts's determineConsensus). Left in place (rather
  // than removed) since it's still informational/harmless, but changing it
  // no longer changes what actually trades.
  app.post<{ Body: { version: StrategyVersion } }>("/api/system/strategy-version", async (request, reply) => {
    const valid: StrategyVersion[] = ["v1", "v2", "v3", "v4", "v5", "v6"];
    if (!valid.includes(request.body.version)) {
      return reply.code(400).send({ error: `version must be one of ${valid.join(", ")}` });
    }
    const state = await setActiveStrategyVersion(request.body.version);
    return { activeStrategyVersion: state.activeStrategyVersion };
  });

  // Only takes effect once BROKER_KIND resolves to browser_control (see
  // engine/loop.ts's attemptExecution) -- toggleable regardless of that, same
  // as the mode/strategy-version toggles above, since it's harmless to leave
  // on while paper/analysis-only is active.
  app.post<{ Body: { enabled: boolean } }>("/api/system/execution-decision-engine", async (request) => {
    const state = await setExecutionDecisionEngineEnabled(request.body.enabled);
    return { executionDecisionEngineEnabled: state.executionDecisionEngineEnabled };
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
