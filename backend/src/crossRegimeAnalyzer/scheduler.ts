/**
 * Single timer: runs one scan every CROSS_REGIME_TICK_HOURS. No reasoning/digest split like Scout's
 * scheduler -- there's only one thing this agent ever does (scan and flag), and it's deterministic,
 * so there's nothing to gate on "is it due for a *different* reason" the way Scout's daily digest is.
 */
import { getSettings } from "../core/config.js";
import { childLogger } from "../core/logger.js";
import { runScan } from "./scan.js";

const logger = childLogger("crossRegimeScheduler");

const POLL_INTERVAL_MS = 60_000;

let scanInFlight = false;
let lastScanAt = 0;

async function runScanIfDue(now: number): Promise<void> {
  const settings = getSettings();
  if (now - lastScanAt < settings.crossRegimeTickHours * 60 * 60_000) return;
  if (scanInFlight) return;
  scanInFlight = true;
  lastScanAt = now;
  try {
    const result = await runScan();
    logger.info({ flaggedCount: result.flagged.length }, "cross_regime_scan_completed");
  } catch (err) {
    logger.error({ err: String(err) }, "cross_regime_scan_failed");
  } finally {
    scanInFlight = false;
  }
}

function tick(): void {
  runScanIfDue(Date.now()).catch((err) => logger.error({ err: String(err) }, "cross_regime_tick_failed"));
}

/** Starts the timer, running one scan immediately then every CROSS_REGIME_TICK_HOURS. Call once at process boot. Returns the interval handle for shutdown. */
export function startCrossRegimeScheduler(): NodeJS.Timeout {
  tick();
  return setInterval(tick, POLL_INTERVAL_MS);
}
