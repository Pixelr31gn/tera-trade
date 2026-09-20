/**
 * Holds the most recent browser-scraped account snapshot (see
 * src/browserWatch), read by engine/accounting.ts when
 * ACCOUNT_SOURCE=browser. In-memory only -- reset on restart, same caveat as
 * the MAE/MFE excursion tracking in engine/loop.ts.
 *
 * Keyed by BrokerKind (not a single slot) since a second concurrent live
 * broker (Tradesea) has its own independently-scraped account panel -- a
 * single shared slot would have one venue's watcher silently clobber the
 * other's balance/P&L. Every existing call site defaults to
 * BrokerKind.BROWSER_CONTROL (TopstepX, the only browser-scraped venue before
 * this), so this is behavior-preserving for anything that doesn't pass a kind.
 */
import { BrokerKind } from "../core/config.js";
import type { BrowserAccountSnapshot } from "../browserWatch/extract.js";

const latestByKind = new Map<BrokerKind, BrowserAccountSnapshot>();

export function setLatestBrowserAccountSnapshot(kind: BrokerKind, snapshot: BrowserAccountSnapshot): void {
  latestByKind.set(kind, snapshot);
}

export function getLatestBrowserAccountSnapshot(kind: BrokerKind = BrokerKind.BROWSER_CONTROL): BrowserAccountSnapshot | null {
  return latestByKind.get(kind) ?? null;
}
