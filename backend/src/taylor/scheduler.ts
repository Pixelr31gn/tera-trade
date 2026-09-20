/** Taylor's own timer -- checks for newly-approved pitches every TAYLOR_TICK_MINUTES, same "poll short, act on a real condition" shape as Scout's scheduler.ts. Simpler than Scout's: just the one job, no daily digest concept. */
import { getSettings } from "../core/config.js";
import { childLogger } from "../core/logger.js";
import { runTaylorTurn } from "./agentLoop.js";

const logger = childLogger("taylorScheduler");

const POLL_INTERVAL_MS = 60_000;

let tickInFlight = false;
let lastTickAt = 0;

async function runTickIfDue(now: Date): Promise<void> {
  const settings = getSettings();
  if (now.getTime() - lastTickAt < settings.taylorTickMinutes * 60_000) return;
  if (tickInFlight) return;
  tickInFlight = true;
  lastTickAt = now.getTime();
  try {
    const result = await runTaylorTurn();
    logger.info({ toolCallCount: result.toolCallCount, reply: result.reply.slice(0, 300) }, "taylor_tick_completed");
  } catch (err) {
    logger.error({ err: String(err) }, "taylor_tick_failed");
  } finally {
    tickInFlight = false;
  }
}

function tick(): void {
  runTickIfDue(new Date()).catch((err) => logger.error({ err: String(err) }, "taylor_tick_wrapper_failed"));
}

/** Starts the timer, polling every POLL_INTERVAL_MS but only actually running every TAYLOR_TICK_MINUTES. Call once at Taylor process boot. Returns the interval handle for shutdown. */
export function startTaylorScheduler(): NodeJS.Timeout {
  tick();
  return setInterval(tick, POLL_INTERVAL_MS);
}
