import type { FastifyInstance } from "fastify";
import { getSettings, TradingMode } from "../../core/config.js";
import { requireApiKey } from "../../core/security.js";
import {
  clearKillSwitch,
  getSystemState,
  isLiveBrokerConnected,
  ModeChangeError,
  setActiveStrategyVersion,
  setExecutionDecisionEngineEnabled,
  setMode,
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
    if (request.body.version !== "v1" && request.body.version !== "v2" && request.body.version !== "v3" && request.body.version !== "v4" && request.body.version !== "v5") {
      return reply.code(400).send({ error: "version must be 'v1', 'v2', 'v3', 'v4', or 'v5'" });
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
}
