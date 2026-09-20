import "../env.js"; // must be first: populates process.env before config.ts reads it

/**
 * Auto-Provisioner's standalone entry point (`npm run auto-provisioner`, from backend/) -- own
 * process, same reasoning as Scout/Taylor's run.ts: never needs the trading engine running, runs
 * independently, shares the same Postgres database (reads TailorBlueprint, writes staged files +
 * updates TailorBlueprint's provisioning columns).
 *
 * `npm run auto-provisioner:once` (this file with --once) runs a single check-and-scaffold turn
 * and exits.
 */
import { getSettings } from "../core/config.js";
import { logger } from "../core/logger.js";
import { prisma } from "../db/client.js";
import { runAutoProvisionerTurn } from "./agentLoop.js";
import { startAutoProvisionerScheduler } from "./scheduler.js";

async function main(): Promise<void> {
  const settings = getSettings();
  if (!settings.autoProvisionerEnabled) {
    logger.error("auto_provisioner_disabled -- set AUTO_PROVISIONER_ENABLED=true in backend/.env to run the Auto-Provisioner");
    process.exit(1);
  }

  const once = process.argv.includes("--once");

  if (once) {
    logger.info({ model: settings.autoProvisionerOllamaModel, baseUrl: settings.autoProvisionerOllamaBaseUrl }, "auto_provisioner_running_once");
    const result = await runAutoProvisionerTurn();
    logger.info({ toolCallCount: result.toolCallCount, reply: result.reply }, "auto_provisioner_once_completed");
    await prisma.$disconnect();
    return;
  }

  logger.info(
    { model: settings.autoProvisionerOllamaModel, baseUrl: settings.autoProvisionerOllamaBaseUrl, tickHours: settings.autoProvisionerTickHours },
    "auto_provisioner_starting"
  );

  const schedulerTimer = startAutoProvisionerScheduler();

  const shutdown = async () => {
    logger.info("auto_provisioner_stopping");
    clearInterval(schedulerTimer);
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

process.on("uncaughtException", (err) => {
  logger.error({ err: String(err), stack: err.stack }, "auto_provisioner_uncaught_exception_survived");
});
process.on("unhandledRejection", (reason) => {
  logger.error({ err: String(reason) }, "auto_provisioner_unhandled_rejection_survived");
});

main().catch((err) => {
  logger.error({ err: String(err) }, "auto_provisioner_fatal_startup_error");
  process.exit(1);
});
