/** Artifice's own timer -- checks for untriaged blueprints every ARTIFICE_TICK_MINUTES, same "poll short, act on a real condition" shape as Taylor's scheduler.ts. */
import { getSettings } from "../core/config.js";
import { childLogger } from "../core/logger.js";
import { runArtificeTurn } from "./agentLoop.js";

const logger = childLogger("artificeScheduler");

const POLL_INTERVAL_MS = 60_000;

let tickInFlight = false;
let lastTickAt = 0;

async function runTickIfDue(now: Date): Promise<void> {
  const settings = getSettings();
  if (now.getTime() - lastTickAt < settings.artificeTickMinutes * 60_000) return;
  if (tickInFlight) return;
  tickInFlight = true;
  lastTickAt = now.getTime();
  try {
    const result = await runArtificeTurn();
    logger.info({ toolCallCount: result.toolCallCount, reply: result.reply.slice(0, 300) }, "artifice_tick_completed");
  } catch (err) {
    logger.error({ err: String(err) }, "artifice_tick_failed");
  } finally {
    tickInFlight = false;
  }
}

function tick(): void {
  runTickIfDue(new Date()).catch((err) => logger.error({ err: String(err) }, "artifice_tick_wrapper_failed"));
}

/** Starts the timer, polling every POLL_INTERVAL_MS but only actually running every ARTIFICE_TICK_MINUTES. Call once at Artifice process boot. Returns the interval handle for shutdown. */
export function startArtificeScheduler(): NodeJS.Timeout {
  tick();
  return setInterval(tick, POLL_INTERVAL_MS);
}
