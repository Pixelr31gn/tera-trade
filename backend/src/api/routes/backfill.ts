import type { FastifyInstance } from "fastify";
import { requireApiKey } from "../../core/security.js";
import { childLogger } from "../../core/logger.js";
import { getSettings } from "../../core/config.js";
import { runFullBackfill } from "../../marketData/backfill.js";
import { refreshCalendar } from "../../news/calendar.js";

const logger = childLogger("backfillRoute");

export async function backfillRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireApiKey);

  app.post("/api/backfill/run", async () => {
    const settings = getSettings();
    // Fire-and-forget: the caller gets an immediate ack, matching the
    // original FastAPI BackgroundTasks behavior.
    void (async () => {
      try {
        await runFullBackfill(settings.historicalBackfillDays);
        await refreshCalendar();
        logger.info("backfill_job_complete");
      } catch (err) {
        logger.error({ err: String(err) }, "backfill_job_failed");
      }
    })();
    return { status: "started" };
  });
}
