import "./env.js"; // must be first: populates process.env before config.ts reads it

import { Decimal } from "decimal.js";
import { isInTradingWeek } from "./analytics/tradingWeek.js";
import { buildServer } from "./api/server.js";
import { ensureDebugChromeRunning } from "./browserWatch/chromeLauncher.js";
import { manager } from "./api/wsManager.js";
import { computeVolumeDelta } from "./browserWatch/extract.js";
import { OrderFlowListener } from "./browserWatch/orderFlowListener.js";
import { BrowserWatcher } from "./browserWatch/watcher.js";
import { getBroker, TRADESEA_AUTHENTICATED_PAGE_MARKER } from "./brokers/index.js";
import { SimulatedBroker } from "./brokers/simulatedBroker.js";
import type { BrokerClient } from "./brokers/types.js";
import { AccountSource, BrokerKind, getSettings, PriceSource } from "./core/config.js";
import { logger } from "./core/logger.js";
import { prisma } from "./db/client.js";
import { setLiveBrokerConnected, setTradeseaLiveBrokerConnected } from "./execution/mode.js";
import { setLatestBrowserAccountSnapshot } from "./engine/liveAccountOverride.js";
import { appendOrderFlowHistory, setLatestOrderFlowSnapshot } from "./engine/liveOrderFlowCache.js";
import { getDealerLevels, getDealerLevelsBucketed } from "./engine/dealerGexCache.js";
import { loadRecentBars } from "./engine/bootstrap.js";
import { TradingEngine } from "./engine/loop.js";
import { evaluatePendingOutcomes } from "./engine/outcomeEvaluator.js";
import { evaluateDealerLevelOutcomes } from "./engine/dealerLevelOutcomeEvaluator.js";
import { startDailyPlanScheduler } from "./assistant/dailyPlanScheduler.js";
import { refreshMacroIndicators } from "./marketData/macroIndicators.js";
import { backfillDaily, ensureInstrumentsSeeded } from "./marketData/backfill.js";
import { ACTIVE_INSTRUMENTS } from "./marketData/instruments.js";
import { LiveBarPoller } from "./marketData/live.js";
import { MinuteBarAggregator } from "./marketData/minuteBarAggregator.js";

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

// License gate REMOVED (2026-09-20, operator decision: the repo is public and
// the goal is that anyone can clone it and set Tera Trade up locally). This
// used to be the first thing main() did -- checkLicense() verified
// LICENSE_KEY/LICENSED_TO against a signing secret baked into
// core/license.ts and process.exit(1)'d on a missing or invalid key. That
// file is deliberately gitignored (it holds the signing secret, and CLAUDE.md
// forbids committing it), so a fresh clone couldn't even compile, let alone
// start. LICENSE.md remains the legal terms; nothing is enforced in code any
// more. core/license.ts, scripts/generateLicenseKey.ts and
// tests/license.test.ts still exist on the operator's own machine
// (gitignored) but nothing here imports them. The LICENSE_KEY / LICENSED_TO /
// LICENSE_SIGNING_SECRET settings in core/config.ts are left in place and are
// now simply unused.

async function main(): Promise<void> {
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
        dashboardUrl: settings.dashboardUrl,
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
    // Bounded retry around the initial connect (2026-09-20, operator request,
    // after two consecutive clean restarts both lost the same race):
    // BrowserControlBroker.connect() resolves its page through
    // cdpClient.findPage, and at startup that call lands ~200ms after
    // debug_chrome_ready -- before Playwright has finished enumerating pages
    // over the freshly-opened CDP connection. findPage then reads empty body
    // text and rejects a genuinely authenticated, fully-rendered tab as
    // matched_tab_not_authenticated. Confirmed concretely: the identical page
    // (innerText byte-identical, "bal:" marker present) was accepted by
    // BrowserWatcher's own findPage call on its 5s poll seconds later, and a
    // read-only CDP dump found the marker both before and after the failure.
    // One-shot meant every restart was a coin flip against a ~200ms window.
    // Same bounded-retry shape readBodyTextWithRetry already uses in
    // cdpClient.ts for this exact class of CDP flakiness. Deliberately still
    // non-fatal on total failure -- see the comment above.
    const CONNECT_ATTEMPTS = 5;
    const CONNECT_RETRY_DELAY_MS = 3_000;
    for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt += 1) {
      try {
        liveBroker = await getBroker(liveBrokerKind);
        await liveBroker.connect();
        setLiveBrokerConnected(true);
        logger.info({ brokerKind: liveBrokerKind, attempt }, "live_broker_connected");
        break;
      } catch (err) {
        liveBroker = null;
        if (attempt === CONNECT_ATTEMPTS) {
          logger.error({ brokerKind: liveBrokerKind, attempts: attempt, err: String(err) }, "live_broker_connect_failed -- LIVE mode unavailable until this is resolved (e.g. restart), but PAPER/ANALYSIS_ONLY are unaffected");
        } else {
          logger.warn({ brokerKind: liveBrokerKind, attempt, err: String(err) }, "live_broker_connect_failed_retrying");
          await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_DELAY_MS));
        }
      }
    }
  }

  // Tradesea: a second, fully independent live broker connection (see
  // docs/BUILD_HISTORY.md's Tradesea entry) -- never selected by
  // BROKER_KIND/liveBrokerKind above, gated entirely by its own TRADESEA_*
  // settings. A connection failure here is handled the same way the primary
  // liveBroker's is: it just leaves Tradesea unavailable, never fatal to the
  // rest of the process.
  let secondaryBroker: BrokerClient | null = null;
  // Disabled 2026-08-30 (operator request: "turn off anything to do with
  // tradesea for now... when tradesea is ready with real data we can use
  // what we built for tradesea") -- commented out, not deleted, so this is a
  // one-block uncomment (plus the matching watcher block below) once
  // Tradesea has real data to trade on. secondaryBroker stays null through
  // this whole file with this block off, which is the single source of
  // truth every Tradesea check in engine/loop.ts already gates on
  // (`this.secondaryBroker && ...`) -- nothing else needed to change.
  /*
  if (settings.tradeseaEnabled) {
    try {
      secondaryBroker = await getBroker(BrokerKind.TRADESEA_BROWSER_CONTROL);
      await secondaryBroker.connect();
      setTradeseaLiveBrokerConnected(true);
      logger.info({ cdpUrl: settings.tradeseaBrowserCdpUrl }, "tradesea_broker_connected");
    } catch (err) {
      logger.error({ err: String(err) }, "tradesea_broker_connect_failed -- Tradesea unavailable until this is resolved (e.g. restart), but TopstepX/paper/analysis are unaffected");
      secondaryBroker = null;
    }
  }
  */

  const engine = new TradingEngine(
    simulatedBroker, liveBroker, liveBrokerKind, (event) => manager.broadcast(event),
    secondaryBroker, secondaryBroker ? BrokerKind.TRADESEA_BROWSER_CONTROL : null
  );

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
      async (snapshot) => setLatestBrowserAccountSnapshot(BrokerKind.BROWSER_CONTROL, snapshot),
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

  // Tradesea's own account-snapshot watcher -- separate CDP connection/tab
  // from the primary watcher above, independent of TopstepX's own
  // PRICE_SOURCE/ACCOUNT_SOURCE settings (Tradesea's account data has no
  // other source). CRITICAL: the price-tick handler is a no-op. A second
  // BrowserWatcher that fed engine.onPriceTick/onNewBar the way the primary
  // one does would race a second MinuteBarAggregator against the first,
  // double-firing decideOnBar per real bar -- a direct violation of "decideOnBar
  // runs exactly once per bar" (see .claude/rules/replay-harness.md) and
  // duplicate Score rows. Both venues trade off the single, already-existing
  // TopstepX-observed price series; only account equity is genuinely
  // per-venue for Tradesea.
  let stopTradeseaWatcher: (() => void) | undefined;
  let tradeseaWatcherPromise: Promise<void> | undefined;
  // Disabled 2026-08-30, same operator request as secondaryBroker above --
  // commented out, not deleted. stopTradeseaWatcher/tradeseaWatcherPromise
  // stay undefined with this block off, which the shutdown handler below
  // already treats as a no-op (`stopTradeseaWatcher?.()`).
  /*
  if (settings.tradeseaEnabled) {
    const tradeseaWatcher = new BrowserWatcher(
      {
        cdpUrl: settings.tradeseaBrowserCdpUrl,
        urlMatch: settings.tradeseaBrowserUrlMatch,
        pollSeconds: settings.browserPollSeconds,
        // Empty, not ACTIVE_INSTRUMENTS -- this watcher's price-tick handler
        // is a no-op (see above), so there's nothing to extract prices for;
        // leaving this non-empty just produced pointless per-cycle
        // "price_extraction_returned_null" log noise (confirmed live,
        // 2026-08-28 -- Tradesea's DOM ladder doesn't render bare "ES"/"NQ"
        // rows the way TopstepX's Quotes panel does, so every cycle logged a
        // warning for work that was always going to be thrown away anyway).
        symbols: [],
        contentMarker: TRADESEA_AUTHENTICATED_PAGE_MARKER,
      },
      async (snapshot) => {
        setLatestBrowserAccountSnapshot(BrokerKind.TRADESEA_BROWSER_CONTROL, snapshot);
        // Independent of TopstepX's own price ticks -- see
        // TradingEngine.recordTradeseaEquitySnapshot's own comment for why
        // this is the fix, not onPriceTick alone.
        await engine.recordTradeseaEquitySnapshot();
      },
      async () => {} // no-op -- see this block's header comment
    );
    stopTradeseaWatcher = () => tradeseaWatcher.stop();
    tradeseaWatcherPromise = tradeseaWatcher.run();
    logger.info({ cdpUrl: settings.tradeseaBrowserCdpUrl }, "tradesea_watch_enabled");
  }
  */

  let stopOrderFlow: (() => void) | undefined;
  let orderFlowPromise: Promise<void> | undefined;
  if (settings.priceSource === PriceSource.BROWSER && settings.orderFlowEnabled) {
    // Same attached tab as the browser watcher above, but listens to raw
    // WebSocket traffic (order book / trade-aggressor flow / TopstepX's own
    // crowd-positioning "Tilt" feed) instead of scraping rendered text --
    // see browserWatch/orderFlowListener.ts for why the DOM ladder widget
    // itself isn't a reliable source. Kept in-memory only (bounded ring
    // buffer, see liveOrderFlowCache.ts) rather than persisted to Postgres
    // -- the 2026-07-20 DB audit confirmed nothing in scoring ever read the
    // old persisted table back, only the in-memory latest snapshot.
    const orderFlowListener = new OrderFlowListener(
      { cdpUrl: settings.browserCdpUrl, urlMatch: settings.browserUrlMatch, flushSeconds: settings.orderFlowFlushSeconds },
      async (snapshot) => {
        setLatestOrderFlowSnapshot(snapshot);
        appendOrderFlowHistory(snapshot, new Date());
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

  // Same pattern, for dealer-GEX level outcomes (2026-08-11, operator
  // request) -- see engine/dealerLevelOutcomeEvaluator.ts. Same 5-minute
  // cadence as the score evaluator above; most passes will find nothing to
  // do (a snapshot's own session has to have actually ended first).
  let dealerLevelOutcomeEvaluationRunning = false;
  const runDealerLevelOutcomeEvaluation = (): void => {
    if (dealerLevelOutcomeEvaluationRunning) return;
    dealerLevelOutcomeEvaluationRunning = true;
    evaluateDealerLevelOutcomes()
      .catch((err) => logger.error({ err: String(err) }, "dealer_level_outcome_evaluation_failed"))
      .finally(() => {
        dealerLevelOutcomeEvaluationRunning = false;
      });
  };
  runDealerLevelOutcomeEvaluation();
  const dealerLevelOutcomeEvaluationTimer = setInterval(runDealerLevelOutcomeEvaluation, OUTCOME_EVALUATION_INTERVAL_MS);

  // 10Y yield / VIX (2026-08-11, operator request) -- same 5-minute cadence
  // as the outcome evaluators above; both are daily-granularity Yahoo
  // readings that still update intraday as the current day's bar forms, so
  // this is frequent enough to feel current without hammering Yahoo's free
  // endpoint. See marketData/macroIndicators.ts.
  let macroIndicatorRefreshRunning = false;
  const runMacroIndicatorRefresh = (): void => {
    if (macroIndicatorRefreshRunning) return;
    macroIndicatorRefreshRunning = true;
    refreshMacroIndicators()
      .catch((err) => logger.error({ err: String(err) }, "macro_indicator_refresh_failed"))
      .finally(() => {
        macroIndicatorRefreshRunning = false;
      });
  };
  runMacroIndicatorRefresh();
  const macroIndicatorRefreshTimer = setInterval(runMacroIndicatorRefresh, OUTCOME_EVALUATION_INTERVAL_MS);

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

  // Dealer GEX levels (2026-08-11, operator request: "gex should compute
  // live like any other gex chart") -- runs on its OWN wall-clock timer,
  // independent of bar completion/continuous-scan's dedup logic. Originally
  // this only got recomputed as a side effect of scanSymbolContinuously/
  // decideOnBar running, both of which skip their own work entirely when
  // the underlying futures price feed hasn't produced a genuinely new bar
  // yet -- confirmed live this produced multi-minute gaps between
  // computations whenever price data was slow/stale, which isn't what a
  // "live" GEX chart means. Dealer positioning doesn't need a fresh futures
  // tick to be worth re-polling; it just needs its own clock. Same
  // 60s cadence as engine/dealerGexCache.ts's own CACHE_TTL_MS -- kept in
  // sync deliberately, since a faster timer here would just re-hit a warm
  // cache for nothing.
  const DEALER_GEX_REFRESH_INTERVAL_MS = 60_000;
  let dealerGexRefreshRunning = false;
  const runDealerGexRefresh = (): void => {
    if (dealerGexRefreshRunning) return;
    dealerGexRefreshRunning = true;
    (async () => {
      const now = new Date();
      for (const spec of ACTIVE_INSTRUMENTS) {
        const bars = await loadRecentBars(spec.symbol, 300);
        if (bars.length === 0) continue;
        await getDealerLevels(spec.symbol, bars, now);
        // Report-only 0DTE/structural split (2026-08-11, operator request) --
        // same cadence, own cache, never read by the live gate above. See
        // engine/dealerGexCache.ts's getDealerLevelsBucketed.
        await getDealerLevelsBucketed(spec.symbol, bars, now);
      }
    })()
      .catch((err) => logger.error({ err: String(err) }, "dealer_gex_refresh_failed"))
      .finally(() => {
        dealerGexRefreshRunning = false;
      });
  };
  runDealerGexRefresh();
  const dealerGexRefreshTimer = setInterval(runDealerGexRefresh, DEALER_GEX_REFRESH_INTERVAL_MS);

  // bars_daily (dailyTrendCache.ts's v1/v2 daily-trend factor, and
  // dailyEmaTrendCache.ts's v3 daily-EMA20 factor) was found 11 days stale
  // (2026-07-20 DB audit) -- nothing had ever kept it current after the
  // initial one-off runFullBackfill. backfillDaily's own createMany uses
  // skipDuplicates, so calling this repeatedly is safe/idempotent; running
  // it a few times a day (rather than exactly once) is cheap insurance
  // against a missed cycle mattering for a whole extra day.
  const DAILY_BAR_REFRESH_INTERVAL_MS = 6 * 60 * 60_000;
  let dailyBarRefreshRunning = false;
  const runDailyBarRefresh = (): void => {
    if (dailyBarRefreshRunning) {
      logger.warn("daily_bar_refresh_still_running_skipping_tick");
      return;
    }
    dailyBarRefreshRunning = true;
    (async () => {
      for (const spec of ACTIVE_INSTRUMENTS) {
        await backfillDaily(spec, 30);
      }
    })()
      .catch((err) => logger.error({ err: String(err) }, "daily_bar_refresh_failed"))
      .finally(() => {
        dailyBarRefreshRunning = false;
      });
  };
  runDailyBarRefresh();
  const dailyBarRefreshTimer = setInterval(runDailyBarRefresh, DAILY_BAR_REFRESH_INTERVAL_MS);

  // Automatically asks the AI assistant to build/set fresh daily-plan zones
  // at each session boundary -- see assistant/dailyPlanScheduler.ts's own
  // header comment. Purely opportunistic (no-op when ASSISTANT_ENABLED or
  // the runtime actions gate is off), so safe to always start.
  const dailyPlanSchedulerTimer = startDailyPlanScheduler();

  const shutdown = async () => {
    logger.info("terra_trade_stopping");
    clearInterval(outcomeEvaluationTimer);
    clearInterval(dealerLevelOutcomeEvaluationTimer);
    clearInterval(macroIndicatorRefreshTimer);
    clearInterval(continuousScanTimer);
    clearInterval(dealerGexRefreshTimer);
    clearInterval(dailyBarRefreshTimer);
    clearInterval(dailyPlanSchedulerTimer);
    stopDataSource();
    await dataSourcePromise;
    stopTradeseaWatcher?.();
    await tradeseaWatcherPromise;
    stopOrderFlow?.();
    await orderFlowPromise;
    await simulatedBroker.disconnect();
    await liveBroker?.disconnect();
    // `as BrokerClient | null` -- with the Tradesea connect block above
    // commented out, secondaryBroker's only reachable assignment is its
    // `null` initializer, so TS narrows it to the literal `null` here and
    // flags `.disconnect` on the resulting `never`. Widens back to the
    // variable's real declared type; drop this cast once that block is
    // uncommented again.
    await (secondaryBroker as BrokerClient | null)?.disconnect();
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
