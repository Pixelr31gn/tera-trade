/**
 * Process-wide pino logger.
 *
 * 2026-09-21 (operator permission): this now also writes newline-delimited
 * JSON to a file (LOG_FILE, default backend-dev.log) alongside the pretty
 * stdout stream it always had. Until today the only sink was stdout through
 * pino-pretty, which meant nothing was readable after the fact -- `.gitignore`
 * has listed `backend/backend-dev.log` for months and
 * `.claude/skills/daily-plan-fallback` instructs the reader to
 * `grep ... backend/backend-dev.log`, but no code ever created it. A full
 * debugging session on 2026-09-21 had to reconstruct three separate live
 * defects (fill-price misanchoring, a 1.75pt stop, brackets rotting at
 * reconciliation) from database arithmetic alone, because the warnings that
 * would have named each one directly went to a terminal scrollback nobody
 * could query.
 *
 * Two targets, not one, on purpose: the pretty stream is what a human watches
 * while the engine runs, and JSON is what survives to be grepped and parsed.
 * Writing pretty output to a file instead would keep the ANSI colour codes and
 * lose the structured fields that make a log line worth having.
 *
 * Deliberately NOT rotated. pino/file appends without bound, and adding
 * rotation would mean either a new dependency (pino-roll) or a cron-shaped
 * side process, neither of which was asked for. At `info` this file grows on
 * the order of a few MB a day; truncate it when it gets inconvenient, or set
 * LOG_FILE= empty to turn it off. Worth revisiting if this ever runs
 * unattended for weeks.
 */
import pino from "pino";
import { getSettings } from "./config.js";

const settings = getSettings();
const isDevelopment = settings.environment === "development";

const prettyTarget = {
  target: "pino-pretty",
  options: { colorize: true, translateTime: "SYS:standard" },
  level: settings.logLevel,
};

// `destination` is the file path; `mkdir` so a LOG_FILE pointing somewhere
// nested doesn't fail at startup, and `append` so a restart adds to the
// existing log rather than discarding what the previous process recorded --
// which matters precisely when a crash or a hot-reload is the thing being
// investigated.
const fileTarget = {
  target: "pino/file",
  options: { destination: settings.logFile, mkdir: true, append: true },
  level: settings.logLevel,
};

// Never write the shared log file from a test run. Caught immediately after
// adding the file target: `vitest` imports this module like any other, so the
// suite's own fixtures started appending to the same file the live engine
// writes to -- including deliberately-thrown strings like "simulated
// transient CDP contention", which read exactly like a real CDP failure when
// grepping after the fact. A diagnosis log that mixes in synthetic failures
// is worse than no log, because it is actively misleading.
const isTestRun = process.env.VITEST !== undefined || process.env.NODE_ENV === "test";

const targets = [
  ...(isDevelopment ? [prettyTarget] : []),
  ...(settings.logFile && !isTestRun ? [fileTarget] : []),
];

export const logger = pino({
  level: settings.logLevel,
  // No targets at all (production with LOG_FILE disabled) keeps pino's default
  // behaviour of writing JSON straight to stdout, which is what a container or
  // service manager expects to collect.
  transport: targets.length > 0 ? { targets } : undefined,
});

export function childLogger(name: string) {
  return logger.child({ module: name });
}
