import { BrokerKind, getSettings } from "../core/config.js";
import { SimulatedBroker } from "./simulatedBroker.js";
import type { BrokerClient } from "./types.js";

export * from "./types.js";
export { SimulatedBroker } from "./simulatedBroker.js";
export { ProjectXGatewayBroker } from "./projectXGatewayBroker.js";
export { BrowserControlBroker } from "./browserControlBroker.js";
export { TradeseaBrowserControlBroker } from "./tradeseaBrowserControlBroker.js";

// Tradesea's own authenticated-dashboard content marker (see
// browserWatch/cdpClient.ts's findPage) -- its HUD never renders TopstepX's
// "bal:" string. "UP&L" (unrealized P&L, confirmed live 2026-08-26) is
// specific enough to the real trading dashboard that a login/redirect page
// won't contain it. Not operator-configurable via env, same posture as
// cdpClient.ts's own AUTHENTICATED_PAGE_CONTENT_MARKER default.
// Exported (not just module-local) so index.ts's Tradesea BrowserWatcher
// construction uses the exact same marker this broker connects with --
// found live, 2026-08-28, that these silently drifting apart is a real
// failure mode: the watcher kept polling and failing "no matching tab"
// indefinitely, on its own separate timer, even while this broker's own
// connect() succeeded fine, since findPage defaults to TopstepX's "bal:"
// marker when no contentMarker is passed.
export const TRADESEA_AUTHENTICATED_PAGE_MARKER = "UP&L";

export async function getBroker(kind: BrokerKind): Promise<BrokerClient> {
  if (kind === BrokerKind.SIMULATED) return new SimulatedBroker();
  if (kind === BrokerKind.PROJECTX) {
    const { ProjectXGatewayBroker } = await import("./projectXGatewayBroker.js");
    return new ProjectXGatewayBroker();
  }
  if (kind === BrokerKind.BROWSER_CONTROL) {
    const { BrowserControlBroker } = await import("./browserControlBroker.js");
    return new BrowserControlBroker();
  }
  if (kind === BrokerKind.TRADESEA_BROWSER_CONTROL) {
    const { TradeseaBrowserControlBroker } = await import("./tradeseaBrowserControlBroker.js");
    const settings = getSettings();
    return new TradeseaBrowserControlBroker({
      cdpUrl: settings.tradeseaBrowserCdpUrl,
      urlMatch: settings.tradeseaBrowserUrlMatch,
      dryRunOrders: settings.tradeseaDryRunOrders,
      contentMarker: TRADESEA_AUTHENTICATED_PAGE_MARKER,
    });
  }
  throw new Error(`Unknown broker kind: ${kind}`);
}
