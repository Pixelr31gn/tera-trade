import "./env.js"; // must be first: populates process.env before config.ts reads it

import { Decimal } from "decimal.js";
import { isInTradingWeek } from "./analytics/tradingWeek.js";
import { buildServer } from "./api/server.js";
import { ensureDebugChromeRunning } from "./browserWatch/chromeLauncher.js";
import { manager } from "./api/wsManager.js";
import { computeVolumeDelta } from "./browserWatch/extract.js";
import { OrderFlowListener } from "./browserWatch/orderFlowListener.js";
import { BrowserWatcher } from "./browserWatch/watcher.js";
import { getBroker } from "./brokers/index.js";
import { SimulatedBroker } from "./brokers/simulatedBroker.js";
import type { BrokerClient } from "./brokers/types.js";
import { AccountSource, BrokerKind, getSettings, PriceSource } from "./core/config.js";
import { DEFAULT_LICENSE_SIGNING_SECRET, verifyLicenseKey } from "./core/license.js";
import { logger } from "./core/logger.js";
import { prisma } from "./db/client.js";
import { setLiveBrokerConnected } from "./execution/mode.js";
import { setLatestBrowserAccountSnapshot } from "./engine/liveAccountOverride.js";
import { setLatestOrderFlowSnapshot } from "./engine/liveOrderFlowCache.js";
import { TradingEngine } from "./engine/loop.js";
import { evaluatePendingOutcomes } from "./engine/outcomeEvaluator.js";
import { ensureInstrumentsSeeded } from "./marketData/backfill.js";
import { ACTIVE_INSTRUMENTS } from "./marketData/instruments.js";
import { LiveBarPoller } from "./marketData/live.js";
import { MinuteBarAggregator } from "./marketData/minuteBarAggregator.js";
import { refreshAllRollups } from "./marketData/rollup.js";

// Defense in depth: a crashed backend means zero risk oversight (no kill
// switch enforcement, no position monitoring, nothing) until someone notices
// and manually restarts it -- strictly worse than surviving a narrow,
// non-critical error. This isn't hypothetical: an unhandled Playwright
// dialog-handling race (thrown from deep inside its own internal CDP event
// listener, entirely outside any try/catch a caller could write) once
// crashed the whole process this way. Node's default behavior for an
// uncaught exception is to exit; for this specific app, staying up and
// logging loudly is the safer failure mode, since nothing here touches core
// state (DB connections, the HTTP server, the trading engine's own loop) --
// it's almost always a narrowly-scoped browser-automation hiccup.
process.on("uncaughtException", (err) => {
  logger.error({ err: String(err), stack: err.stack }, "uncaught_exception_survived");
});
process.on("unhandledRejection", (reason) => {
  logger.error({ err: String(reason) }, "unhandled_rejection_survived");
});

// The very first thing the app does, before touching the database or
// anything else -- see core/license.ts for what this mechanism actually
// provides (and its honest limits) and ../../LICENSE.md for the agreement
// itself. Refuses to start rather than running in some degraded mode:
// a license gate that can be silently bypassed by just not having a key
// isn't a gate at all.
function checkLicense(): void {
  const settings = getSettings();
  // The env var, if set, overrides the constant baked into license.ts (see
  // that file's comment) -- most installs, including every recipient's
  // unmodified copy, just use the baked-in constant.
  const secret = settings.licenseSigningSecret || DEFAULT_LICENSE_SIGNING_SECRET;

  if (!settings.licenseKey || !settings.licensedTo) {
    logger.error(
      "license_missing -- set LICENSE_KEY and LICENSED_TO in backend/.env. See LICENSE.md, or run `npx tsx scripts/generateLicenseKey.ts` if you are the licensor."
    );
    process.exit(1);
  }

  const result = verifyLicenseKey(settings.licenseKey, settings.licensedTo, secret);
  if (!result.valid) {
    logger.error({ reason: result.reason }, "license_invalid");
    process.exit(1);
  }

  logger.info({ licensedTo: result.payload.licensedTo, expiresAt: result.payload.expiresAt }, "license_valid");
}

async function main(): Promise<void> {
  checkLicense();
  const settings = getSettings();

  await ensureInstrumentsSeeded();

  // Chrome must be auto-launched (or already running) BEFORE anything tries
  // to connect to it -- broker.connect() below needs a live CDP endpoint.
  // This was previously ordered the other way (broker.connect() first, Chrome
  // launch second), which only ever worked by accident because Chrome
  // happened to already be running from a previous session on every restart
  // this session -- the first genuine cold start (Chrome fully closed)
  // exposed it: broker.connect() failed immediately with ECONNREFUSED before
  // ensureDebugChromeRunning ever got a chance to launch anything.
  if (settings.priceSource === PriceSource.BROWSER || settings.accountSource === AccountSource.BROWSER) {
    if (settings.chromeAutoLaunch) {
      await ensureDebugChromeRunning({
        cdpUrl: settings.browserCdpUrl,
        executablePath: settings.chromeExecutablePath,
        userDataDir: settings.chromeDebugUserDataDir,
        startUrl: settings.chromeDebugStartUrl,
      });
    }
  }

  // Both a simulated and (if configured) a real broker are held
  // simultaneously now, not just whichever one BROKER_KIND happened to be at
  // startup -- so PAPER is always available and switching between PAPER and
  // LIVE is instant and self-service from the UI/API, no restart needed
  // (2026-07-15 operator request). A live-broker connection failure is no
  // longer fatal to the whole process either: previously, a stuck Chrome/CDP
  // handle took down paper trading and analysis too, which happened
  // repeatedly this same day -- now it just leaves LIVE mode unavailable
  // until reconnected, while everything else keeps running.
  const simulatedBroker = new SimulatedBroker();
  await simulatedBroker.connect();

  let liveBroker: BrokerClient | null = null;
  const liveBrokerKind = settings.brokerKind === BrokerKind.PROJECTX || settings.brokerKind === BrokerKind.BROWSER_CONTROL ? settings.brokerKind : null;
  if (liveBrokerKind) {
    try {
      liveBroker = await getBroker(liveBrokerKind);
      await liveBroker.connect();
      setLiveBrokerConnected(true);
      logger.info({ brokerKind: liveBrokerKind }, "live_broker_connected");
    } catch (err) {
      logger.error({ brokerKind: liveBrokerKind, err: String(err) }, "live_broker_connect_failed -- LIVE mode unavailable until this is resolved (e.g. restart), but PAPER/ANALYSIS_ONLY are unaffected");
      liveBroker = null;
    }
  }

  const engine = new TradingEngine(simulatedBroker, liveBroker, liveBrokerKind, (event) => manager.broadcast(event));

  let stopDataSource: () => void;
  let dataSourcePromise: Promise<void>;

  if (settings.priceSource === PriceSource.BROWSER || settings.accountSource === AccountSource.BROWSER) {
    // Read-only DOM watch of a broker web platform tab already open in the
    // user's own Chrome (started with --remote-debugging-port). See
    // docs/BROWSER_WATCH.md. Never clicks/types/submits anything.
    const lastCumulativeVolume = new Map<string, number>();
    // Aggregates raw ~5-10s price ticks into real 1-minute OHLCV bars -- see
    // marketData/minuteBarAggregator.ts for why this exists (the previous
    // one-row-per-tick approach was directly responsible for a 19% real win
    // rate: strategies were unknowingly trading 20-*tick* breakouts, not
    // 20-*minute* ones).
    const minuteBars = new MinuteBarAggregator();
    const watcher = new BrowserWatcher(
      {
        cdpUrl: settings.browserCdpUrl,
        urlMatch: settings.browserUrlMatch,
        pollSeconds: settings.browserPollSeconds,
        symbols: ACTIVE_INSTRUMENTS.map((i) => i.symbol),
        selectorsPath: settings.browserSelectorsPath,
      },
      async (snapshot) => setLatestBrowserAccountSnapshot(snapshot),
      async (symbol, price, cumulativeVolume) => {
        if (settings.priceSource !== PriceSource.BROWSER) return;
        // Outside the real CME Globex week (Sun 6pm ET - Fri 5pm ET), any
        // tick is a stale/frozen page artifact, not a real price move -- see
        // analytics/tradingWeek.ts. Skipping entirely (not just skipping the
        // bar write) also means a stop/target never fires off a frozen
        // weekend price.
        if (!isInTradingWeek(new Date())) return;
        const p = new Decimal(price);
        // TopstepX's quote table shows cumulative session volume, not a
        // per-tick figure -- convert to a delta so it behaves like a normal
        // bar's volume (see computeVolumeDelta's docstring).
        const delta = computeVolumeDelta(lastCumulativeVolume.get(symbol) ?? null, cumulativeVolume);
        lastCumulativeVolume.set(symbol, cumulativeVolume);
        const v = new Decimal(delta);
        const time = new Date();

        // Fast path on every tick: stop/target monitoring + live equity.
        // Deliberately does not evaluate new strategy signals -- see
        // TradingEngine.onPriceTick's comment.
        await engine.onPriceTick(symbol, time, p);

        // Only once a full minute has genuinely elapsed: persist the real
        // OHLCV bar and let strategies see it as a new bar.
        const completed = minuteBars.addTick(symbol, p, v, time);
        if (completed) {
          await prisma.bar.upsert({
            where: { time_symbol: { time: completed.time, symbol } },
            create: {
              time: completed.time, symbol,
              open: completed.open.toString(), high: completed.high.toString(), low: completed.low.toString(), close: completed.close.toString(),
              volume: completed.volume.toString(),
            },
            update: {
              high: completed.high.toString(), low: completed.low.toString(), close: completed.close.toString(), volume: completed.volume.toString(),
            },
          });
          await engine.onNewBar(symbol, completed.time, completed.open, completed.high, completed.low, completed.close, completed.volume);
        }
      }
    );
    stopDataSource = () => watcher.stop();
    dataSourcePromise = watcher.run();
    logger.info({ cdpUrl: settings.browserCdpUrl }, "browser_watch_enabled");
  } else {
    const poller = new LiveBarPoller(
      async (symbol, time, o, h, l, c, v) => {
        // Each poll already is one complete bar for this path (not a raw
        // sub-minute tick like the browser-watch path), so both the
        // fast-monitoring and signal-evaluation paths fire together.
        await engine.onPriceTick(symbol, time, c);
        await engine.onNewBar(symbol, time, o, h, l, c, v);
      },
      settings.enginePollSeconds,
      ACTIVE_INSTRUMENTS
    );
    stopDataSource = () => poller.stop();
    dataSourcePromise = poller.run();
  }

  let stopOrderFlow: (() => void) | undefined;
  let orderFlowPromise: Promise<void> | undefined;
  if (settings.priceSource === PriceSource.BROWSER && settings.orderFlowEnabled) {
    // Same attached tab as the browser watcher above, but listens to raw
    // WebSocket traffic (order book / trade-aggressor flow / TopstepX's own
    // crowd-positioning "Tilt" feed) instead of scraping rendered text --
    // see browserWatch/orderFlowListener.ts for why the DOM ladder widget
    // itself isn't a reliable source. Purely observational for now: results
    // are persisted and exposed via /api/market/order-flow but nothing in
    // scoring reads them yet, pending validation that the feed is accurate.
    const orderFlowListener = new OrderFlowListener(
      { cdpUrl: settings.browserCdpUrl, urlMatch: settings.browserUrlMatch, flushSeconds: settings.orderFlowFlushSeconds },
      async (snapshot) => {
        setLatestOrderFlowSnapshot(snapshot);
        await prisma.orderFlowSnapshot.create({
          data: {
            time: new Date(),
            symbol: snapshot.symbol,
            bestBidSize: snapshot.bestBidSize?.toString(),
            bestAskSize: snapshot.bestAskSize?.toString(),
            buyVolume: snapshot.buyVolume.toString(),
            sellVolume: snapshot.sellVolume.toString(),
            tradeCount: snapshot.tradeCount,
            tiltLongBias: snapshot.tiltLongBias?.toString(),
            tiltShortBias: snapshot.tiltShortBias?.toString(),
          },
        });
      }
    );
    stopOrderFlow = () => orderFlowListener.stop();
    orderFlowPromise = orderFlowListener.run();
    logger.info({ cdpUrl: settings.browserCdpUrl, flushSeconds: settings.orderFlowFlushSeconds }, "order_flow_listener_enabled");
  }

  const app = await buildServer();
  await app.listen({ port: settings.port, host: "0.0.0.0" });
  logger.info(
    { mode: settings.tradingMode, broker: settings.brokerKind, priceSource: settings.priceSource, accountSource: settings.accountSource, port: settings.port },
    "terra_trade_started"
  );

  // Retrospectively labels every scored setup (taken and skipped alike) with
  // win/loss/no_resolution once enough bars have accumulated -- see
  // engine/outcomeEvaluator.ts. Runs on a timer rather than per-bar since it
  // scans across all pending scores, not just the symbol that just ticked.
  const OUTCOME_EVALUATION_INTERVAL_MS = 5 * 60_000;
  // Guarded against overlap the same way runContinuousScan is below -- a pass
  // that runs long (large pending backlog, slow DB) must not let the next
  // 5-minute tick start a second concurrent pass on top of it; unbounded
  // overlap compounding every tick was the leading suspect behind the
  // ~45-minute OOM crash (see docs/BUILD_HISTORY.md).
  let outcomeEvaluationRunning = false;
  const runOutcomeEvaluation = (): void => {
    if (outcomeEvaluationRunning) {
      logger.warn("outcome_evaluation_still_running_skipping_tick");
      return;
    }
    outcomeEvaluationRunning = true;
    evaluatePendingOutcomes()
      .catch((err) => logger.error({ err: String(err) }, "outcome_evaluation_failed"))
      .finally(() => {
        outcomeEvaluationRunning = false;
      });
  };
  runOutcomeEvaluation();
  const outcomeEvaluationTimer = setInterval(runOutcomeEvaluation, OUTCOME_EVALUATION_INTERVAL_MS);

  // Keeps bars_rollup fresh for the 30m/1h/4h (and 5m/15m) legs of the
  // multi-timeframe trend read (see engine/timeframeTrendCache.ts) -- doesn't
  // need continuousScanTimer's 15s cadence: a rollup only needs to be as
  // fresh as its own bucket size, and the fastest resolution rolled up here
  // is 5 minutes. Same overlap-guard shape as outcomeEvaluationTimer above.
  const ROLLUP_REFRESH_INTERVAL_MS = 5 * 60_000;
  let rollupRefreshRunning = false;
  const runRollupRefresh = (): void => {
    if (rollupRefreshRunning) {
      logger.warn("rollup_refresh_still_running_skipping_tick");
      return;
    }
    rollupRefreshRunning = true;
    refreshAllRollups()
      .catch((err) => logger.error({ err: String(err) }, "rollup_refresh_failed"))
      .finally(() => {
        rollupRefreshRunning = false;
      });
  };
  runRollupRefresh();
  const rollupRefreshTimer = setInterval(runRollupRefresh, ROLLUP_REFRESH_INTERVAL_MS);

  // A running v3 confidence read per instrument, independent of whether any
  // strategy actually fired a signal -- see TradingEngine.runContinuousScan's
  // comment for why this is observational only and never executes. Guarded
  // against overlap: a cold-cache run (nothing cached yet for
  // getOpeningRangeStats/getFixedTargetEdge) can take ~90s the first time,
  // which is longer than the 30s tick -- without this guard, setInterval
  // would pile up concurrent scans on every restart instead of settling
  // down once the caches warm up.
  // All 4 instrument scans already run concurrently (Promise.allSettled in
  // runContinuousScan, Promise.all for long/short within each) rather than
  // one after another, so a warm-cache cycle finishes in a small fraction of
  // the old 30s window -- confirmed live via consecutive Score row
  // timestamps landing exactly on the tick with no drift. 15s still leaves
  // headroom before the continuousScanRunning overlap guard would matter.
  const CONTINUOUS_SCAN_INTERVAL_MS = 15_000;
  let continuousScanRunning = false;
  const runContinuousScan = (): void => {
    if (!isInTradingWeek(new Date())) return; // nothing new to score outside the real trading week
    if (continuousScanRunning) {
      logger.warn("continuous_scan_still_running_skipping_tick");
      return;
    }
    continuousScanRunning = true;
    engine
      .runContinuousScan()
      .catch((err) => logger.error({ err: String(err) }, "continuous_scan_failed"))
      .finally(() => {
        continuousScanRunning = false;
      });
  };
  runContinuousScan();
  const continuousScanTimer = setInterval(runContinuousScan, CONTINUOUS_SCAN_INTERVAL_MS);

  const shutdown = async () => {
    logger.info("terra_trade_stopping");
    clearInterval(outcomeEvaluationTimer);
    clearInterval(rollupRefreshTimer);
    clearInterval(continuousScanTimer);
    stopDataSource();
    await dataSourcePromise;
    stopOrderFlow?.();
    await orderFlowPromise;
    await simulatedBroker.disconnect();
    await liveBroker?.disconnect();
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
