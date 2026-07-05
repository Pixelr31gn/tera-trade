import type { FastifyInstance } from "fastify";
import { getSettings, TradingMode } from "../../core/config.js";
import { requireApiKey } from "../../core/security.js";
import { clearKillSwitch, getSystemState, ModeChangeError, setMode } from "../../execution/mode.js";

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
      minScoreThreshold: settings.minScoreThreshold,
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
}
