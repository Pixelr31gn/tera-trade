/**
 * Holds the most recent browser-scraped account snapshot (see
 * src/browserWatch), read by engine/accounting.ts when
 * ACCOUNT_SOURCE=browser. In-memory only -- reset on restart, same caveat as
 * the MAE/MFE excursion tracking in engine/loop.ts.
 */
import type { BrowserAccountSnapshot } from "../browserWatch/extract.js";

let latest: BrowserAccountSnapshot | null = null;

export function setLatestBrowserAccountSnapshot(snapshot: BrowserAccountSnapshot): void {
  latest = snapshot;
}

export function getLatestBrowserAccountSnapshot(): BrowserAccountSnapshot | null {
  return latest;
}
