/** Auto-Provisioner's own timer -- checks for newly-written, not-yet-scaffolded blueprints every AUTO_PROVISIONER_TICK_HOURS. Same "poll short, act on a real condition" shape as Scout/Taylor's own schedulers. */
import { getSettings } from "../core/config.js";
import { childLogger } from "../core/logger.js";
import { runAutoProvisionerTurn } from "./agentLoop.js";

const logger = childLogger("autoProvisionerScheduler");

const POLL_INTERVAL_MS = 60_000;

let tickInFlight = false;
let lastTickAt = 0;

async function runTickIfDue(now: Date): Promise<void> {
  const settings = getSettings();
  if (now.getTime() - lastTickAt < settings.autoProvisionerTickHours * 60 * 60_000) return;
  if (tickInFlight) return;
  tickInFlight = true;
  lastTickAt = now.getTime();
  try {
    const result = await runAutoProvisionerTurn();
    logger.info({ toolCallCount: result.toolCallCount, reply: result.reply.slice(0, 300) }, "auto_provisioner_tick_completed");
  } catch (err) {
    logger.error({ err: String(err) }, "auto_provisioner_tick_failed");
  } finally {
    tickInFlight = false;
  }
}

function tick(): void {
  runTickIfDue(new Date()).catch((err) => logger.error({ err: String(err) }, "auto_provisioner_tick_wrapper_failed"));
}

/** Starts the timer, polling every POLL_INTERVAL_MS but only actually running every AUTO_PROVISIONER_TICK_HOURS. Call once at process boot. Returns the interval handle for shutdown. */
export function startAutoProvisionerScheduler(): NodeJS.Timeout {
  tick();
  return setInterval(tick, POLL_INTERVAL_MS);
}
