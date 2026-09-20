import "../env.js"; // must be first: populates process.env before config.ts reads it

/**
 * Artifice's standalone entry point (`npm run artifice`, from backend/) -- own process, same
 * reasoning as Scout/Taylor's run.ts: never needs the trading engine running, runs independently so
 * a crash/restart can't affect live trading, Scout, Taylor, or the Auto-Provisioner, shares the
 * same Postgres database (reads TailorBlueprint, writes ArtificeVerdict).
 *
 * `npm run artifice:once` (this file with --once) runs a single check-and-triage turn and exits.
 */
import { getSettings } from "../core/config.js";
import { logger } from "../core/logger.js";
import { prisma } from "../db/client.js";
import { runArtificeTurn } from "./agentLoop.js";
import { startArtificeScheduler } from "./scheduler.js";

async function main(): Promise<void> {
  const settings = getSettings();
  if (!settings.artificeEnabled) {
    logger.error("artifice_disabled -- set ARTIFICE_ENABLED=true in backend/.env to run Artifice");
    process.exit(1);
  }

  const once = process.argv.includes("--once");

  if (once) {
    logger.info({ model: settings.artificeOllamaModel, baseUrl: settings.artificeOllamaBaseUrl }, "artifice_running_once");
    const result = await runArtificeTurn();
    logger.info({ toolCallCount: result.toolCallCount, reply: result.reply }, "artifice_once_completed");
    await prisma.$disconnect();
    // No explicit process.exit() -- see scout/run.ts's own comment: forcing exit right after
    // logging can race pino-pretty's worker-thread transport and crash with a native assertion.
    return;
  }

  logger.info({ model: settings.artificeOllamaModel, baseUrl: settings.artificeOllamaBaseUrl, tickMinutes: settings.artificeTickMinutes }, "artifice_starting");

  const schedulerTimer = startArtificeScheduler();

  const shutdown = async () => {
    logger.info("artifice_stopping");
    clearInterval(schedulerTimer);
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

process.on("uncaughtException", (err) => {
  logger.error({ err: String(err), stack: err.stack }, "artifice_uncaught_exception_survived");
});
process.on("unhandledRejection", (reason) => {
  logger.error({ err: String(reason) }, "artifice_unhandled_rejection_survived");
});

main().catch((err) => {
  logger.error({ err: String(err) }, "artifice_fatal_startup_error");
  process.exit(1);
});
