import "./env.js"; // must be first: populates process.env before config.ts reads it

import { buildServer } from "./api/server.js";
import { manager } from "./api/wsManager.js";
import { getBroker } from "./brokers/index.js";
import { getSettings } from "./core/config.js";
import { logger } from "./core/logger.js";
import { TradingEngine } from "./engine/loop.js";
import { ensureInstrumentsSeeded } from "./marketData/backfill.js";
import { DEFAULT_INSTRUMENTS } from "./marketData/instruments.js";
import { LiveBarPoller } from "./marketData/live.js";

async function main(): Promise<void> {
  const settings = getSettings();

  await ensureInstrumentsSeeded();

  const broker = await getBroker(settings.brokerKind);
  await broker.connect();

  const engine = new TradingEngine(broker, (event) => manager.broadcast(event));
  const poller = new LiveBarPoller(
    (symbol, time, o, h, l, c, v) => engine.onNewBar(symbol, time, o, h, l, c, v),
    settings.enginePollSeconds,
    DEFAULT_INSTRUMENTS
  );
  const pollerPromise = poller.run();

  const app = await buildServer();
  await app.listen({ port: settings.port, host: "0.0.0.0" });
  logger.info({ mode: settings.tradingMode, broker: settings.brokerKind, port: settings.port }, "terra_trade_started");

  const shutdown = async () => {
    logger.info("terra_trade_stopping");
    poller.stop();
    await pollerPromise;
    await broker.disconnect();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.error({ err: String(err) }, "fatal_startup_error");
  process.exit(1);
});
