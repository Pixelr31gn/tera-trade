import "./env.js"; // must be first: populates process.env before config.ts reads it

import { Decimal } from "decimal.js";
import { buildServer } from "./api/server.js";
import { manager } from "./api/wsManager.js";
import { BrowserWatcher } from "./browserWatch/watcher.js";
import { getBroker } from "./brokers/index.js";
import { AccountSource, getSettings, PriceSource } from "./core/config.js";
import { logger } from "./core/logger.js";
import { prisma } from "./db/client.js";
import { setLatestBrowserAccountSnapshot } from "./engine/liveAccountOverride.js";
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

  let stopDataSource: () => void;
  let dataSourcePromise: Promise<void>;

  if (settings.priceSource === PriceSource.BROWSER || settings.accountSource === AccountSource.BROWSER) {
    // Read-only DOM watch of a broker web platform tab already open in the
    // user's own Chrome (started with --remote-debugging-port). See
    // docs/BROWSER_WATCH.md. Never clicks/types/submits anything.
    const watcher = new BrowserWatcher(
      {
        cdpUrl: settings.browserCdpUrl,
        urlMatch: settings.browserUrlMatch,
        pollSeconds: settings.browserPollSeconds,
        symbols: DEFAULT_INSTRUMENTS.map((i) => i.symbol),
        selectorsPath: settings.browserSelectorsPath,
      },
      async (snapshot) => setLatestBrowserAccountSnapshot(snapshot),
      async (symbol, price) => {
        if (settings.priceSource !== PriceSource.BROWSER) return;
        const p = new Decimal(price);
        const time = new Date();
        // Mirrors LiveBarPoller: the engine loop reads bar history from the
        // DB (loadRecentBars), so a price tick has to actually land in
        // bars_1m before onNewBar can see it -- this was missing entirely,
        // which is why regime/scoring silently never saw browser-sourced
        // prices even though extraction itself was working.
        await prisma.bar.create({
          data: { time, symbol, open: p.toString(), high: p.toString(), low: p.toString(), close: p.toString(), volume: "0" },
        });
        await engine.onNewBar(symbol, time, p, p, p, p, new Decimal(0));
      }
    );
    stopDataSource = () => watcher.stop();
    dataSourcePromise = watcher.run();
    logger.info({ cdpUrl: settings.browserCdpUrl }, "browser_watch_enabled");
  } else {
    const poller = new LiveBarPoller(
      (symbol, time, o, h, l, c, v) => engine.onNewBar(symbol, time, o, h, l, c, v),
      settings.enginePollSeconds,
      DEFAULT_INSTRUMENTS
    );
    stopDataSource = () => poller.stop();
    dataSourcePromise = poller.run();
  }

  const app = await buildServer();
  await app.listen({ port: settings.port, host: "0.0.0.0" });
  logger.info(
    { mode: settings.tradingMode, broker: settings.brokerKind, priceSource: settings.priceSource, accountSource: settings.accountSource, port: settings.port },
    "terra_trade_started"
  );

  const shutdown = async () => {
    logger.info("terra_trade_stopping");
    stopDataSource();
    await dataSourcePromise;
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
