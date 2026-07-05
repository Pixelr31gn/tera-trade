/**
 * Polls the attached broker-platform tab on an interval, extracting account
 * balance/equity/P&L and last prices for the configured instruments, and
 * hands the results to callbacks (bridged into the engine/accounting layer
 * by src/index.ts). Read-only: never clicks, types, or submits anything on
 * the page.
 */
import { existsSync, readFileSync } from "node:fs";
import type { Browser, Page } from "playwright-core";
import { childLogger } from "../core/logger.js";
import { connectToChrome, findPage, readPageText } from "./cdpClient.js";
import {
  extractAccountSnapshot,
  extractPriceForSymbol,
  extractVolumeForSymbol,
  parseMoney,
  type BrowserAccountSnapshot,
  type CalibratedSelectors,
} from "./extract.js";

const logger = childLogger("browserWatcher");

export type AccountSnapshotHandler = (snapshot: BrowserAccountSnapshot) => Promise<void>;
export type PriceTickHandler = (symbol: string, price: number, volume: number) => Promise<void>;

export interface BrowserWatcherOptions {
  cdpUrl: string;
  urlMatch: string;
  pollSeconds: number;
  symbols: string[];
  symbolAliases?: Record<string, string[]>;
  selectorsPath?: string;
}

function loadSelectors(path: string | undefined): CalibratedSelectors | null {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as CalibratedSelectors;
  } catch (err) {
    logger.warn({ path, err: String(err) }, "failed_to_load_selectors");
    return null;
  }
}

async function readViaSelector(page: Page, selector: string): Promise<string | null> {
  try {
    return await page.textContent(selector);
  } catch {
    return null;
  }
}

export class BrowserWatcher {
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private browser: Browser | undefined;
  private selectors: CalibratedSelectors | null;

  constructor(
    private options: BrowserWatcherOptions,
    private onAccountSnapshot: AccountSnapshotHandler,
    private onPriceTick: PriceTickHandler
  ) {
    this.selectors = loadSelectors(options.selectorsPath);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  async run(): Promise<void> {
    logger.info({ cdpUrl: this.options.cdpUrl, urlMatch: this.options.urlMatch }, "start");
    while (!this.stopped) {
      try {
        await this.pollOnce();
      } catch (err) {
        logger.warn({ err: String(err) }, "poll_failed_will_retry");
        this.browser = undefined; // force a fresh connection attempt next tick
      }
      await this.sleep(this.options.pollSeconds * 1000);
    }
    await this.browser?.close().catch(() => {});
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.timer = setTimeout(resolve, ms);
    });
  }

  private async getPage(): Promise<Page> {
    if (!this.browser) {
      this.browser = await connectToChrome(this.options.cdpUrl);
    }
    const page = await findPage(this.browser, this.options.urlMatch);
    if (!page) {
      throw new Error(
        `No open Chrome tab matching "${this.options.urlMatch}" -- is Chrome running with --remote-debugging-port and TopstepX open?`
      );
    }
    return page;
  }

  private async pollOnce(): Promise<void> {
    const page = await this.getPage();

    if (this.selectors?.balanceSelector || this.selectors?.equitySelector || this.selectors?.pnlSelector) {
      const balanceText = this.selectors.balanceSelector ? await readViaSelector(page, this.selectors.balanceSelector) : null;
      const equityText = this.selectors.equitySelector ? await readViaSelector(page, this.selectors.equitySelector) : null;
      const pnlText = this.selectors.pnlSelector ? await readViaSelector(page, this.selectors.pnlSelector) : null;
      await this.onAccountSnapshot({
        balance: balanceText ? parseMoney(balanceText) : null,
        equity: equityText ? parseMoney(equityText) : null,
        pnl: pnlText ? parseMoney(pnlText) : null,
      });
    } else {
      const pageText = await readPageText(page);
      await this.onAccountSnapshot(extractAccountSnapshot(pageText));
    }

    for (const symbol of this.options.symbols) {
      const calibratedSelector = this.selectors?.priceSelectors?.[symbol];
      let price: number | null = null;
      let volume = 0;
      if (calibratedSelector) {
        const text = await readViaSelector(page, calibratedSelector);
        if (text) price = parseMoney(text);
        // Calibrated selectors are price-only for now; volume still comes
        // from the page-text heuristic below if available.
        const pageText = await readPageText(page);
        volume = extractVolumeForSymbol(pageText, symbol, this.options.symbolAliases?.[symbol] ?? []) ?? 0;
      } else {
        const pageText = await readPageText(page);
        price = extractPriceForSymbol(pageText, symbol, this.options.symbolAliases?.[symbol] ?? []);
        volume = extractVolumeForSymbol(pageText, symbol, this.options.symbolAliases?.[symbol] ?? []) ?? 0;
      }
      if (price !== null) await this.onPriceTick(symbol, price, volume);
    }
  }
}
