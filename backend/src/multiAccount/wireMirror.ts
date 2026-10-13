/**
 * The single wiring point that turns multi-account fan-out on.
 *
 * Wraps the live browser-control broker with a FanOutBroker when, and only
 * when, MIRROR_EXECUTORS lists at least one remote account. With no targets
 * (the default) the original broker is returned UNCHANGED -- so this is inert
 * until explicitly configured and adds no new live-order path by itself
 * (CLAUDE.md invariant 3: it does not touch TRADING_MODE / BROKER_KIND /
 * LIVE_TRADING_CONFIRMED / KILL_SWITCH -- a live order still requires all of
 * those exactly as before; this only decides whether an order that is ALREADY
 * being placed is also mirrored to other accounts).
 *
 * Only BROWSER_CONTROL is mirrored, since the remote executors are
 * browser-control services; any other broker kind is returned untouched.
 */
import type { BrokerClient } from "../brokers/types.js";
import { BrokerKind } from "../core/config.js";
import { childLogger } from "../core/logger.js";
import { loadMirrorClientConfig } from "./executorConfig.js";
import { FanOutBroker } from "./fanOutBroker.js";
import { RemoteExecutorClient } from "./remoteExecutorClient.js";

const logger = childLogger("wireMirror");

export function maybeWrapWithFanOut(broker: BrokerClient, kind: BrokerKind): BrokerClient {
  if (kind !== BrokerKind.BROWSER_CONTROL) return broker;

  const cfg = loadMirrorClientConfig();
  if (cfg.targets.length === 0) return broker; // default: fan-out off

  if (!cfg.secret) {
    throw new Error("MIRROR_EXECUTORS is set but MIRROR_SECRET is empty -- refusing to fan out orders without a shared secret");
  }

  const clients = cfg.targets.map((t) => new RemoteExecutorClient({ name: t.name, baseUrl: t.url, secret: cfg.secret }));
  logger.warn(
    { accounts: clients.map((c) => c.name) },
    "multi_account_fanout_ENABLED -- every live order on this account will also be sent to these remote accounts",
  );
  return new FanOutBroker(broker, clients);
}
