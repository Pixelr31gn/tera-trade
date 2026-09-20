/**
 * Scout's two timers -- same "poll on a short interval, act only when the real condition is met"
 * shape as the trading assistant's dailyPlanScheduler.ts:
 *
 * 1. A reasoning tick every SCOUT_TICK_MINUTES: prompts Scout to scan activity/runtime data and
 *    write_pitch anything it finds. This is the "signal store is continuously updated" behavior.
 * 2. A once-a-day digest compile, at SCOUT_DIGEST_HOUR local time: prompts Scout to call
 *    compile_digest. "Surfaced once a day, not real-time," per the operator's own requirement --
 *    kept as a scheduled trigger (not something the reasoning tick decides on its own) so it's
 *    guaranteed to happen exactly once regardless of what the model would otherwise choose.
 */
import { getSettings } from "../core/config.js";
import { childLogger } from "../core/logger.js";
import { runScoutTurn } from "./agentLoop.js";
import { compileDigest } from "./digest.js";

const logger = childLogger("scoutScheduler");

const POLL_INTERVAL_MS = 60_000;

const TICK_PROMPT = `Routine scan. Call query_recent_trades_and_sessions and scan_recent_activity, then write_pitch for
any genuine frequency+friction overlap you find (new or reinforcing an existing pitch). If nothing
rises to that bar, say so briefly and stop -- do not force a pitch. Do not call compile_digest.`;

const DIGEST_PROMPT = `End of day. Call compile_digest now to render and save today's digest from the current pitch
ranking. Do not call any other tool first -- the ranking already reflects everything written so
far today.`;

let reasoningTickInFlight = false;
let digestInFlight = false;
let lastDigestDateKey: string | null = null;
let lastReasoningTickAt = 0;

function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function runReasoningTickIfDue(now: Date): Promise<void> {
  const settings = getSettings();
  if (now.getTime() - lastReasoningTickAt < settings.scoutTickMinutes * 60_000) return;
  if (reasoningTickInFlight) return;
  reasoningTickInFlight = true;
  lastReasoningTickAt = now.getTime();
  try {
    const result = await runScoutTurn(TICK_PROMPT);
    logger.info({ toolCallCount: result.toolCallCount, reply: result.reply.slice(0, 300) }, "scout_reasoning_tick_completed");
  } catch (err) {
    logger.error({ err: String(err) }, "scout_reasoning_tick_failed");
  } finally {
    reasoningTickInFlight = false;
  }
}

async function runDigestIfDue(now: Date): Promise<void> {
  const settings = getSettings();
  const dateKey = localDateKey(now);
  if (dateKey === lastDigestDateKey) return;
  if (now.getHours() < settings.scoutDigestHour) return;
  if (digestInFlight) return;

  digestInFlight = true;
  try {
    // Prefer letting Scout call compile_digest itself (native tool calling, per the operator's own
    // architecture) -- but fall back to calling it directly if the model turn fails outright, so a
    // transient Ollama issue doesn't silently skip the one thing the operator actually reviews.
    try {
      await runScoutTurn(DIGEST_PROMPT);
    } catch (err) {
      logger.warn({ err: String(err) }, "scout_digest_turn_failed_falling_back_to_direct_compile");
      await compileDigest(now);
    }
    lastDigestDateKey = dateKey;
    logger.info({ dateKey }, "scout_digest_completed");
  } catch (err) {
    logger.error({ err: String(err) }, "scout_digest_failed");
  } finally {
    digestInFlight = false;
  }
}

function tick(): void {
  const now = new Date();
  runReasoningTickIfDue(now).catch((err) => logger.error({ err: String(err) }, "scout_tick_failed"));
  runDigestIfDue(now).catch((err) => logger.error({ err: String(err) }, "scout_digest_tick_failed"));
}

/** Starts both timers, polling every POLL_INTERVAL_MS but only actually running the reasoning tick every SCOUT_TICK_MINUTES and the digest once/day at SCOUT_DIGEST_HOUR (see runReasoningTickIfDue/runDigestIfDue) -- same "poll short, act on a real condition" shape as dailyPlanScheduler.ts. Call once at Scout process boot. Returns the interval handle for shutdown. */
export function startScoutScheduler(): NodeJS.Timeout {
  tick();
  return setInterval(tick, POLL_INTERVAL_MS);
}
