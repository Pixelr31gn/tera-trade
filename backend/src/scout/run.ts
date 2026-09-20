import "../env.js"; // must be first: populates process.env before config.ts reads it

/**
 * Scout's standalone entry point (`npm run scout`, from backend/) -- deliberately its own process,
 * separate from the main Tera Trade backend (`npm run dev`). Scout watches dev activity on this
 * repo and reads the trading system's own data; it never needs the trading engine, brokers, or
 * price feed running to do its job, and running separately means a Scout crash/restart can never
 * affect live trading, and vice versa. Both processes share the same Postgres database (same
 * DATABASE_URL, same Prisma schema) -- that's how Scout's runtime-signal queries see real data
 * and how the operator's dashboard could read ScoutPitch/ScoutDigest later if it ever wants to.
 *
 * `npm run scout:once` (this file with --once) runs a single reasoning tick and exits -- useful
 * for testing without waiting for SCOUT_TICK_MINUTES. `--once --prompt "..."` runs one turn with a
 * custom directive instead of the routine scan prompt -- e.g. pointing Scout at one data source
 * specifically ("go through the trading assistant's recent actions...").
 */
import { getSettings } from "../core/config.js";
import { logger } from "../core/logger.js";
import { prisma } from "../db/client.js";
import { startFileWatchers } from "./buildActivity.js";
import { runScoutTurn } from "./agentLoop.js";
import { startScoutScheduler } from "./scheduler.js";

const TICK_PROMPT_FOR_ONCE = `Routine scan. Call query_recent_trades_and_sessions and scan_recent_activity, then write_pitch for
any genuine frequency+friction overlap you find (new or reinforcing an existing pitch). If nothing
rises to that bar, say so briefly and stop -- do not force a pitch. Do not call compile_digest.`;

async function main(): Promise<void> {
  const settings = getSettings();
  if (!settings.scoutEnabled) {
    logger.error("scout_disabled -- set SCOUT_ENABLED=true in backend/.env to run Scout");
    process.exit(1);
  }

  const once = process.argv.includes("--once");
  const promptFlagIndex = process.argv.indexOf("--prompt");
  const customPrompt = promptFlagIndex >= 0 ? process.argv[promptFlagIndex + 1] : undefined;

  if (once) {
    logger.info({ model: settings.scoutOllamaModel, baseUrl: settings.scoutOllamaBaseUrl, custom: Boolean(customPrompt) }, "scout_running_once");
    const result = await runScoutTurn(customPrompt ?? TICK_PROMPT_FOR_ONCE);
    logger.info({ toolCallCount: result.toolCallCount, reply: result.reply }, "scout_once_completed");
    await prisma.$disconnect();
    // No explicit process.exit() here -- pino's pino-pretty transport runs on a worker thread in
    // development (core/logger.ts), and forcing exit immediately after logging raced that
    // thread's own close and crashed the process with a native libuv assertion (confirmed live).
    // With no open handles left after $disconnect(), Node exits on its own once the event loop
    // drains, which lets the transport close cleanly first.
    return;
  }

  logger.info({ model: settings.scoutOllamaModel, baseUrl: settings.scoutOllamaBaseUrl, tickMinutes: settings.scoutTickMinutes, digestHour: settings.scoutDigestHour }, "scout_starting");

  const stopWatchers = startFileWatchers();
  const schedulerTimer = startScoutScheduler();

  const shutdown = async () => {
    logger.info("scout_stopping");
    clearInterval(schedulerTimer);
    stopWatchers();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

process.on("uncaughtException", (err) => {
  // Same posture as the main backend's index.ts -- Scout should survive a narrow error (a bad
  // session-log line, a transient Ollama hiccup) rather than take the whole watcher down.
  logger.error({ err: String(err), stack: err.stack }, "scout_uncaught_exception_survived");
});
process.on("unhandledRejection", (reason) => {
  logger.error({ err: String(reason) }, "scout_unhandled_rejection_survived");
});

main().catch((err) => {
  logger.error({ err: String(err) }, "scout_fatal_startup_error");
  process.exit(1);
});
