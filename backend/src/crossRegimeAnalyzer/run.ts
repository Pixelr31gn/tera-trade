import "../env.js"; // must be first: populates process.env before config.ts reads it

/**
 * Cross-Regime Analyzer's standalone entry point (`npm run cross-regime`, from backend/) -- own
 * process, same reasoning as Scout/Taylor's run.ts: never needs the trading engine running, runs
 * independently so a crash/restart can't affect live trading, Scout, or Taylor. No Ollama
 * dependency at all (see scan.ts) -- this one can't fail the way today's Ollama-hang incident hit
 * Scout/Taylor.
 *
 * `npm run cross-regime:once` (this file with --once) runs a single scan and exits.
 */
import { getSettings } from "../core/config.js";
import { logger } from "../core/logger.js";
import { prisma } from "../db/client.js";
import { runScan } from "./scan.js";
import { startCrossRegimeScheduler } from "./scheduler.js";

async function main(): Promise<void> {
  const settings = getSettings();
  if (!settings.crossRegimeEnabled) {
    logger.error("cross_regime_disabled -- set CROSS_REGIME_ENABLED=true in backend/.env to run the Cross-Regime Analyzer");
    process.exit(1);
  }

  const once = process.argv.includes("--once");

  if (once) {
    logger.info("cross_regime_running_once");
    const result = await runScan();
    logger.info({ flaggedCount: result.flagged.length, pitchIds: result.pitchIds }, "cross_regime_once_completed");
    await prisma.$disconnect();
    return;
  }

  logger.info({ tickHours: settings.crossRegimeTickHours, minSampleSize: settings.crossRegimeMinSampleSize, maxAvgR: settings.crossRegimeMaxAvgR }, "cross_regime_starting");

  const schedulerTimer = startCrossRegimeScheduler();

  const shutdown = async () => {
    logger.info("cross_regime_stopping");
    clearInterval(schedulerTimer);
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

process.on("uncaughtException", (err) => {
  logger.error({ err: String(err), stack: err.stack }, "cross_regime_uncaught_exception_survived");
});
process.on("unhandledRejection", (reason) => {
  logger.error({ err: String(reason) }, "cross_regime_unhandled_rejection_survived");
});

main().catch((err) => {
  logger.error({ err: String(err) }, "cross_regime_fatal_startup_error");
  process.exit(1);
});
