/**
 * Reads live order-flow (best bid/ask size, trade-aggressor volume, and
 * TopstepX's own crowd long/short "Tilt" bias) directly off the SignalR
 * WebSocket traffic already flowing to the attached TopstepX tab -- not by
 * scraping the rendered DOM ladder widget, which was found to go stale
 * (stops tracking live price once its visible window isn't recentered, so
 * its bid/ask-size cells read blank for anything off-screen).
 *
 * This attaches a raw CDP session (Network domain) to the tab found by
 * cdpClient.findPage and listens to `Network.webSocketFrameReceived` --
 * unlike Playwright's page-level `page.on("websocket", ...)`, this also
 * sees frames on a socket that was already open before we attached, which
 * matters here since the tab is opened once and left running.
 *
 * Read-only: this only listens to traffic the browser already receives. It
 * never sends anything over the socket and never interacts with the page.
 */
import type { Browser, CDPSession, Page } from "playwright-core";
import { childLogger } from "../core/logger.js";
import { DEFAULT_INSTRUMENTS } from "../marketData/instruments.js";
import { connectToChrome, findPage } from "./cdpClient.js";

const logger = childLogger("orderFlowListener");

// SignalR's JSON hub protocol separates concatenated messages within one
// text frame with this control character.
const RECORD_SEPARATOR = "\x1e";

// Maps the "F.US.<ROOT>" (or "CON.F.US.<ROOT>.<MMYY>") contract identifiers
// used by RealTimeDom/RealTimeContractQuote/RealTimeTradeLogWithSpeed/
// RealTimeContractBar to our canonical symbol.
//
// 2026-09-21: this silently covered NOTHING the account actually trades.
// "F.US.EP"/"F.US.ENQ" are the FULL-SIZE E-mini roots, confirmed from live
// traffic back when those were the tracked instruments; the account moved to
// the micro contracts on 2026-07-06 (see docs/BUILD_HISTORY.md, "Switched
// tracked instruments to the actual micro contracts") and this map was never
// updated with them. Every RealTimeDom and RealTimeTradeLogWithSpeed frame
// for MES/MNQ therefore resolved to null and was dropped, so
// getLatestOrderFlowSnapshot returned nothing on every signal and v3's
// order-flow adjustment plus v5 have been scoring without a factor they are
// built around -- for over two months, with no symptom beyond a single
// unmapped_contract_root warning per root per process. It took writing logs
// to a file (core/logger.ts, same day) for that warning to be readable at
// all.
//
// The micro half is now DERIVED from the instrument registry rather than
// hand-listed, because hand-listing is precisely what failed: every
// instrument already declares the broker contract code it trades under
// (brokerContractPrefix -- MES/MNQ/MCL/MGC), and TopstepX's root for a micro
// is that same code. Adding or re-activating an instrument now carries its
// order-flow mapping with it automatically. Built from DEFAULT_INSTRUMENTS
// rather than ACTIVE_INSTRUMENTS on purpose: mapping a root we receive but
// don't currently trade costs nothing, while missing one costs this.
//
// The full-size roots stay hand-written -- "EP" and "ENQ" are CME clearing
// codes with no relationship to anything in the registry, so they cannot be
// derived. They are kept rather than deleted because the account can be
// switched back to full-size contracts, and traffic for both shapes is
// harmless.
const CONTRACT_ROOT_TO_SYMBOL: Record<string, string> = {
  "F.US.EP": "ES",
  "F.US.ENQ": "NQ",
  ...Object.fromEntries(DEFAULT_INSTRUMENTS.map((i) => [`F.US.${i.brokerContractPrefix}`, i.symbol])),
};

// TopstepX's "Tilt" feed instead uses bare Globex-style codes (e.g. "ESU6",
// "NQU6") -- root symbol plus a single month-code letter plus a 1-2 digit
// year, no dots.
const GLOBEX_CODE_PATTERN = /^([A-Z]{2,3})[FGHJKMNQUVXZ]\d{1,2}$/;

function contractRootToSymbol(idOrRoot: string): string | null {
  const trimmed = idOrRoot.startsWith("CON.") ? idOrRoot.slice(4) : idOrRoot;
  const mapped = CONTRACT_ROOT_TO_SYMBOL[trimmed];
  if (mapped) return mapped;
  // Full contract IDs carry a trailing month/year segment (F.US.ENQ.U26) --
  // strip it and retry against the 3-segment form.
  const parts = trimmed.split(".");
  if (parts.length === 4) {
    const short = parts.slice(0, 3).join(".");
    return CONTRACT_ROOT_TO_SYMBOL[short] ?? null;
  }
  return null;
}

// Same fault as CONTRACT_ROOT_TO_SYMBOL had, in the Tilt path: this was a
// hardcoded set of the FULL-SIZE symbols, so a micro code ("MESU6" -> root
// "MES") matched the pattern above and was then dropped for not being a known
// root. Now derived from the registry both ways -- a full-size root maps to
// itself, a broker contract prefix maps back to its canonical symbol -- so
// both contract shapes resolve and adding an instrument covers itself.
//
// Tilt is captured but deliberately not scored (see docs/BUILD_HISTORY.md:
// whether to follow or fade crowd positioning isn't established for this
// account), so this half was costing data collection rather than live
// decisions -- fixed together anyway, since leaving one shape of the same bug
// in place is how the first one survived two months.
const GLOBEX_ROOT_TO_SYMBOL: Record<string, string> = {
  ...Object.fromEntries(DEFAULT_INSTRUMENTS.map((i) => [i.symbol, i.symbol])),
  ...Object.fromEntries(DEFAULT_INSTRUMENTS.map((i) => [i.brokerContractPrefix, i.symbol])),
};

function globexCodeToSymbol(code: string): string | null {
  const match = code.match(GLOBEX_CODE_PATTERN);
  if (!match) return null;
  return GLOBEX_ROOT_TO_SYMBOL[match[1]!] ?? null;
}

interface SymbolState {
  bestBidPrice: number | null;
  bestBidSize: number | null;
  bestAskPrice: number | null;
  bestAskSize: number | null;
  buyVolume: number;
  sellVolume: number;
  tradeCount: number;
  tiltLongBias: number | null;
  tiltShortBias: number | null;
}

export interface OrderFlowSnapshot {
  symbol: string;
  bestBidPrice: number | null;
  bestBidSize: number | null;
  bestAskPrice: number | null;
  bestAskSize: number | null;
  buyVolume: number;
  sellVolume: number;
  tradeCount: number;
  tiltLongBias: number | null;
  tiltShortBias: number | null;
}

function emptyState(): SymbolState {
  return {
    bestBidPrice: null,
    bestBidSize: null,
    bestAskPrice: null,
    bestAskSize: null,
    buyVolume: 0,
    sellVolume: 0,
    tradeCount: 0,
    tiltLongBias: null,
    tiltShortBias: null,
  };
}

export type OrderFlowFlushHandler = (snapshot: OrderFlowSnapshot) => Promise<void>;

export interface OrderFlowListenerOptions {
  cdpUrl: string;
  urlMatch: string;
  flushSeconds: number;
}

// RealTimeDom's per-level "type" field -- confirmed from live traffic by
// cross-referencing against simultaneous RealTimeContractQuote/trade-log
// prices, not from any public doc (TopstepX doesn't publish this format).
// Only the two we act on are named; anything else is ignored rather than
// guessed at.
const DOM_TYPE_BEST_ASK = 3;
const DOM_TYPE_BEST_BID = 4;

export class OrderFlowListener {
  private stopped = false;
  private browser: Browser | undefined;
  private cdp: CDPSession | undefined;
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private state = new Map<string, SymbolState>();
  private warnedUnmappedRoots = new Set<string>();

  constructor(
    private options: OrderFlowListenerOptions,
    private onFlush: OrderFlowFlushHandler
  ) {}

  stop(): void {
    this.stopped = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.cdp?.detach().catch(() => {});
    this.browser?.close().catch(() => {});
  }

  async run(): Promise<void> {
    logger.info({ cdpUrl: this.options.cdpUrl, urlMatch: this.options.urlMatch }, "start");
    while (!this.stopped) {
      try {
        await this.attachAndListenUntilDisconnected();
      } catch (err) {
        logger.warn({ err: String(err) }, "attach_failed_will_retry");
      }
      if (this.stopped) break;
      await this.sleep(5000);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getState(symbol: string): SymbolState {
    let s = this.state.get(symbol);
    if (!s) {
      s = emptyState();
      this.state.set(symbol, s);
    }
    return s;
  }

  private async attachAndListenUntilDisconnected(): Promise<void> {
    this.browser = await connectToChrome(this.options.cdpUrl);
    const page: Page | null = await findPage(this.browser, this.options.urlMatch);
    if (!page) {
      throw new Error(`No open Chrome tab matching "${this.options.urlMatch}" -- is TopstepX open?`);
    }

    const cdp = await page.context().newCDPSession(page);
    this.cdp = cdp;
    await cdp.send("Network.enable");

    const socketUrls = new Map<string, string>();
    cdp.on("Network.webSocketCreated", (evt: { requestId: string; url: string }) => {
      socketUrls.set(evt.requestId, evt.url);
    });
    cdp.on("Network.webSocketFrameReceived", (evt: { requestId: string; response: { payloadData: string } }) => {
      try {
        this.handleFrame(evt.response.payloadData);
      } catch (err) {
        logger.warn({ err: String(err) }, "frame_parse_failed");
      }
    });

    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => logger.warn({ err: String(err) }, "flush_failed"));
    }, this.options.flushSeconds * 1000);

    logger.info("attached");

    // Stay attached until the CDP session itself closes (tab/browser
    // closed) -- resolves this promise so the outer run() loop reconnects.
    await new Promise<void>((resolve) => {
      cdp.on("close", () => {
        logger.warn("cdp_session_closed");
        if (this.flushTimer) clearInterval(this.flushTimer);
        resolve();
      });
    });
  }

  private handleFrame(payload: string): void {
    for (const raw of payload.split(RECORD_SEPARATOR)) {
      if (!raw) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(raw);
      } catch {
        continue; // partial/non-JSON control frames (keepalive pings etc.) -- ignore
      }
      if (!msg || typeof msg !== "object") continue; // e.g. a bare "null" handshake segment
      this.handleMessage(msg as { type?: number; target?: string; arguments?: unknown[] });
    }
  }

  private handleMessage(msg: { type?: number; target?: string; arguments?: unknown[] }): void {
    if (msg.type !== 1 || !msg.target || !msg.arguments) return; // only SignalR "Invocation" messages carry market data

    switch (msg.target) {
      case "RealTimeDom":
        this.handleDom(msg.arguments as [string, Array<{ price: number; volume: number; type: number }>]);
        break;
      case "RealTimeTradeLogWithSpeed":
        this.handleTradeLog(msg.arguments as [string, Array<{ price: number; volume: number }>]);
        break;
      case "RealTimeTilt":
        this.handleTilt(msg.arguments as [Array<{ contractName: string; longBias: number; shortBias: number }>]);
        break;
      default:
        break; // RealTimeContractBar/RealTimeContractQuote etc. -- not needed here, prices already come from browserWatch
    }
  }

  private resolveContractSymbol(idOrRoot: string): string | null {
    const symbol = contractRootToSymbol(idOrRoot);
    if (!symbol && !this.warnedUnmappedRoots.has(idOrRoot)) {
      this.warnedUnmappedRoots.add(idOrRoot);
      logger.warn({ root: idOrRoot }, "unmapped_contract_root");
    }
    return symbol;
  }

  private handleDom(args: [string, Array<{ price: number; volume: number; type: number }>]): void {
    const [contractRef, levels] = args;
    const symbol = this.resolveContractSymbol(contractRef);
    if (!symbol || !Array.isArray(levels)) return;

    const state = this.getState(symbol);
    for (const level of levels) {
      if (!level) continue;
      if (level.type === DOM_TYPE_BEST_BID) {
        state.bestBidPrice = level.price;
        state.bestBidSize = level.volume;
      } else if (level.type === DOM_TYPE_BEST_ASK) {
        state.bestAskPrice = level.price;
        state.bestAskSize = level.volume;
      }
    }
  }

  private handleTradeLog(args: [string, Array<{ price: number; volume: number }>]): void {
    const [contractRef, trades] = args;
    const symbol = this.resolveContractSymbol(contractRef);
    if (!symbol || !Array.isArray(trades)) return;

    const state = this.getState(symbol);
    for (const trade of trades) {
      if (!trade) continue;
      state.tradeCount += 1;
      // Tick-rule aggressor classification: a print at/above the resting
      // ask is buyer-initiated, at/below the resting bid is seller-initiated.
      // This is the standard Lee-Ready approach and doesn't depend on
      // guessing an undocumented "buy/sell" code from the feed itself.
      if (state.bestAskPrice !== null && trade.price >= state.bestAskPrice) {
        state.buyVolume += trade.volume;
      } else if (state.bestBidPrice !== null && trade.price <= state.bestBidPrice) {
        state.sellVolume += trade.volume;
      }
      // Prints strictly between a known bid/ask, or arriving before either
      // side is known yet, are left unclassified -- tradeCount still
      // reflects them, but they don't skew buyVolume/sellVolume.
    }
  }

  private handleTilt(args: [Array<{ contractName: string; longBias: number; shortBias: number }>]): void {
    const [rows] = args;
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (!row) continue;
      const symbol = globexCodeToSymbol(row.contractName);
      if (!symbol) continue;
      const state = this.getState(symbol);
      state.tiltLongBias = row.longBias;
      state.tiltShortBias = row.shortBias;
    }
  }

  private async flush(): Promise<void> {
    for (const [symbol, state] of this.state) {
      const snapshot: OrderFlowSnapshot = { symbol, ...state };
      await this.onFlush(snapshot);
      // Point-in-time fields (best bid/ask, tilt) carry forward unchanged;
      // only the accumulated-over-the-window trade counters reset.
      state.buyVolume = 0;
      state.sellVolume = 0;
      state.tradeCount = 0;
    }
  }
}

/**
 * Exported for tests only. The mapping is the part of this file with a real
 * failure history (see CONTRACT_ROOT_TO_SYMBOL's comment) and it is pure, so
 * it is worth asserting directly rather than only through a live SignalR
 * frame, which a test cannot produce.
 */
export const __orderFlowMappingInternals = { contractRootToSymbol, globexCodeToSymbol };
