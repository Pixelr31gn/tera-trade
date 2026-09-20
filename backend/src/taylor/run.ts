import "../env.js"; // must be first: populates process.env before config.ts reads it

/**
 * Taylor's standalone entry point (`npm run taylor`, from backend/) -- its own process, same
 * reasoning as Scout's run.ts (backend/src/scout/run.ts): never needs the trading engine running,
 * runs independently so a crash/restart can't affect live trading or Scout, shares the same
 * Postgres database (reads ScoutPitch, writes TailorBlueprint).
 *
 * `npm run taylor:once` (this file with --once) runs a single check-and-blueprint turn and exits.
 */
import { getSettings } from "../core/config.js";
import { logger } from "../core/logger.js";
import { prisma } from "../db/client.js";
import { runTaylorTurn } from "./agentLoop.js";
import { startTaylorScheduler } from "./scheduler.js";

async function main(): Promise<void> {
  const settings = getSettings();
  if (!settings.taylorEnabled) {
    logger.error("taylor_disabled -- set TAYLOR_ENABLED=true in backend/.env to run Taylor");
    process.exit(1);
  }

  const once = process.argv.includes("--once");

  if (once) {
    logger.info({ model: settings.taylorOllamaModel, baseUrl: settings.taylorOllamaBaseUrl }, "taylor_running_once");
    const result = await runTaylorTurn();
    logger.info({ toolCallCount: result.toolCallCount, reply: result.reply }, "taylor_once_completed");
    await prisma.$disconnect();
    // No explicit process.exit() -- see scout/run.ts's own comment: forcing exit right after
    // logging can race pino-pretty's worker-thread transport and crash with a native assertion.
    return;
  }

  logger.info({ model: settings.taylorOllamaModel, baseUrl: settings.taylorOllamaBaseUrl, tickMinutes: settings.taylorTickMinutes, minRating: settings.taylorApprovalMinRating }, "taylor_starting");

  const schedulerTimer = startTaylorScheduler();

  const shutdown = async () => {
    logger.info("taylor_stopping");
    clearInterval(schedulerTimer);
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

process.on("uncaughtException", (err) => {
  logger.error({ err: String(err), stack: err.stack }, "taylor_uncaught_exception_survived");
});
process.on("unhandledRejection", (reason) => {
  logger.error({ err: String(reason) }, "taylor_unhandled_rejection_survived");
});

main().catch((err) => {
  logger.error({ err: String(err) }, "taylor_fatal_startup_error");
  process.exit(1);
});
