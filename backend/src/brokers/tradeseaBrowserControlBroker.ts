/**
 * BrokerClient implementation that places real orders by driving Tradesea's
 * web UI directly (mouse/keyboard automation over a dedicated CDP
 * connection -- see browserWatch, read-only) -- the second concurrent live
 * broker alongside TopstepX's BrowserControlBroker (see
 * docs/BUILD_HISTORY.md's Tradesea entry). Structurally mirrors
 * BrowserControlBroker (same fill-confirmation retry/delay pattern, same
 * "no broker-side bracket -- engine/loop.ts's manageLiveOpenTrade is the
 * real protection" posture, same dry-run highlight-instead-of-click
 * convention) but takes its CDP config as constructor params instead of
 * reading getSettings() ad hoc at every call site, so a second concurrent
 * instance never fights the primary broker's connection.
 *
 * Real clicks require the SAME layered opt-in shape as TopstepX, but
 * entirely independent gates -- see core/config.ts's TRADESEA_* settings and
 * execution/mode.ts's setTradeseaLiveEnabled:
 *   1. TRADESEA_ENABLED=true
 *   2. TRADESEA_LIVE_TRADING_CONFIRMED=true
 *   3. the runtime tradeseaLiveEnabled switch (POST /api/system/tradesea/live-enabled)
 *   4. TRADESEA_DRY_RUN_ORDERS=false                (checked here, in placeOrder)
 * None of TopstepX's own four gates (TRADING_MODE/BROKER_KIND/
 * LIVE_TRADING_CONFIRMED/DRY_RUN_ORDERS) are read or affected by this class.
 *
 * Scope (2026-08-26/27) -- every interaction below was verified live against
 * the real account's DOM before being written, per this repo's
 * browser-automation-dev skill, but this is still deliberately narrower than
 * BrowserControlBroker:
 *   - placeOrder supports market and limit entries with optional stop-loss/
 *     take-profit prices (Tradesea's "Order" tab ticket exposes all of these
 *     directly as absolute prices -- no dollar-bracket or tick-offset
 *     translation needed, unlike TopstepX's Position Brackets panel).
 *   - flattenPosition (closing via an opposite-side order through the
 *     Order-tab ticket) and requestClosePosition (a dedicated one-click
 *     "Close Position" button, only present on the "Scalp"/"DOM" order-pad
 *     modes -- a separate action bar from the Order-tab ticket, see
 *     browserControl/tradesea/orderTicket.ts's DomActionWidget) and
 *     cancelRestingOrder (that same action bar's "Cancel All") are all
 *     implemented.
 *   - placeTrailingStop is deliberately NOT implemented -- confirmed live,
 *     2026-08-28, via a real (non-dry-run) 1-lot test on the sandbox
 *     account: Trail is an ENTRY-time modifier (bundled with Stop Loss/
 *     Take Profit on a new Buy/Sell, same as TopstepX's own bracket
 *     concept), not a standalone action attachable to an already-open
 *     position. It does genuinely work as a real trailing stop (the test
 *     entry was auto-closed by it ~15s later at a different price, with
 *     real realized P&L to show for it) -- but there is no Tradesea UI
 *     path matching placeTrailingStop's actual contract ("protect an
 *     EXISTING position, no new trade"), so implementing it would mean
 *     silently placing an extra, unwanted entry order every time it's
 *     called. manageLiveOpenTrade doesn't depend on it (it force-closes at
 *     the internal stop/target price directly), so this gap costs an
 *     enhancement, not a safety mechanism. (Separately, OrderRequest
 *     already carries an optional trailTicks field that placeOrder here
 *     doesn't yet read -- wiring Trail in as an entry-time stop-loss
 *     alternative, alongside setStopLossPrice, would be a natural, mostly-
 *     already-verified follow-up, distinct from placeTrailingStop.)
 *   - The order pad can be minimized to a compact "Scalp Pad" view with no
 *     mode tabs at all (confirmed live, 2026-08-27) -- every entry point
 *     below (ensureOrderTab, ensureDomTab) restores it first, so this
 *     doesn't silently break order placement until a human notices.
 */
import { Decimal } from "decimal.js";
import type { Browser, Page } from "playwright-core";
import { connectToChrome, findPage } from "../browserWatch/cdpClient.js";
import {
  findDomActionWidget,
  findOrderWidget,
  selectSide,
  setLimitPrice,
  setOrderType,
  setQuantity,
  setStopLossPrice,
  setTakeProfitPrice,
  submitCancelAll,
  submitClosePosition,
  submitConfirm,
} from "../browserControl/tradesea/orderTicket.js";
import { isPositionFlatViaPanel, readOpenPositionFillPrice } from "../browserControl/tradesea/positionsPanel.js";
import { BrokerKind } from "../core/config.js";
import { childLogger } from "../core/logger.js";
import { getLatestBrowserAccountSnapshot } from "../engine/liveAccountOverride.js";
import { getInstrument } from "../marketData/instruments.js";
import type { BrokerAccount, BrokerClient, BrokerOrder, BrokerPosition, HistoricalBar, OrderRequest, OrderResult } from "./types.js";
import { OrderSide, OrderType } from "./types.js";

const logger = childLogger("tradeseaBrowserControlBroker");

// Same cadence as BrowserControlBroker's own constants -- hand-set, not
// measured against a real Tradesea fill-latency distribution yet.
const FILL_CONFIRMATION_RETRIES = 4;
const FILL_CONFIRMATION_DELAY_MS = 750;

export interface TradeseaBrowserControlBrokerConfig {
  cdpUrl: string;
  urlMatch: string;
  dryRunOrders: boolean;
  /** Passed through to findPage's contentMarker -- Tradesea's HUD never renders TopstepX's "bal:" string. */
  contentMarker: string;
}

export class TradeseaBrowserControlBroker implements BrokerClient {
  private browser: Browser | undefined;

  constructor(private config: TradeseaBrowserControlBrokerConfig) {}

  async connect(): Promise<void> {
    this.browser = await connectToChrome(this.config.cdpUrl);
    const page = await findPage(this.browser, this.config.urlMatch, this.config.contentMarker);
    if (!page) {
      throw new Error(`No open Chrome tab matching "${this.config.urlMatch}" -- is Chrome running with --remote-debugging-port and Tradesea open?`);
    }
    if (this.config.dryRunOrders) {
      logger.warn("TRADESEA_DRY_RUN_ORDERS is enabled -- orders will be prepared (qty/SL/TP set) but never actually submitted");
    } else {
      logger.warn("TRADESEA_DRY_RUN_ORDERS is disabled -- this broker will click real Buy/Sell/Confirm buttons on your real Tradesea account");
    }
  }

  async disconnect(): Promise<void> {
    // Deliberately not calling browser.close() -- see BrowserControlBroker's
    // own comment: this is a connection borrowed from the user's real,
    // already-running Chrome via connectOverCDP.
    this.browser = undefined;
  }

  private async getPage(): Promise<Page> {
    if (!this.browser) this.browser = await connectToChrome(this.config.cdpUrl);
    const page = await findPage(this.browser, this.config.urlMatch, this.config.contentMarker);
    if (!page) throw new Error(`No open Chrome tab matching "${this.config.urlMatch}"`);
    return page;
  }

  async getAccounts(): Promise<BrokerAccount[]> {
    const snapshot = getLatestBrowserAccountSnapshot(BrokerKind.TRADESEA_BROWSER_CONTROL);
    return [
      {
        accountId: "tradesea",
        name: "Tradesea (browser-controlled)",
        balance: new Decimal(snapshot?.balance ?? 0),
        equity: new Decimal(snapshot?.equity ?? snapshot?.balance ?? 0),
      },
    ];
  }

  async placeOrder(request: OrderRequest): Promise<OrderResult> {
    if (request.quantity <= 0) {
      return { brokerOrderId: "", status: "rejected", error: "refusing to place an order with non-positive quantity" };
    }
    if (!request.referencePrice) {
      return { brokerOrderId: "", status: "rejected", error: "refusing to place an order with no reference price" };
    }
    const isLimit = request.orderType === OrderType.LIMIT;
    if (isLimit && !request.limitPrice) {
      return { brokerOrderId: "", status: "rejected", error: "refusing to place a limit order with no limitPrice" };
    }

    try {
      const page = await this.getPage();
      const instrument = getInstrument(request.symbol);
      const widget = await findOrderWidget(page, instrument.brokerContractPrefix);
      if (!widget) {
        return {
          brokerOrderId: "",
          status: "rejected",
          error: `Tradesea's Order-tab ticket is not currently showing contract prefix "${instrument.brokerContractPrefix}"`,
        };
      }

      await setOrderType(widget, isLimit ? "limit" : "market");
      if (isLimit) {
        await setLimitPrice(widget, request.limitPrice!, instrument.tickSize);
      }
      await setQuantity(widget, request.quantity);
      if (request.stopLossPrice) {
        await setStopLossPrice(widget, request.stopLossPrice, instrument.tickSize);
      }
      if (request.takeProfitPrice) {
        await setTakeProfitPrice(widget, request.takeProfitPrice, instrument.tickSize);
      }
      await selectSide(widget, request.side === OrderSide.BUY ? "buy" : "sell");

      const result = await submitConfirm(widget, this.config.dryRunOrders);

      if (result.dryRun) {
        logger.info(
          { symbol: request.symbol, side: request.side, quantity: request.quantity, orderType: request.orderType, limitPrice: request.limitPrice?.toString() },
          "tradesea_dry_run_order_not_submitted"
        );
        return {
          brokerOrderId: "",
          status: "rejected",
          error: `TRADESEA_DRY_RUN_ORDERS is enabled -- would have clicked "${result.buttonText}". Set TRADESEA_DRY_RUN_ORDERS=false to place real orders.`,
        };
      }

      logger.info({ symbol: request.symbol, side: request.side, quantity: request.quantity, orderType: request.orderType }, "tradesea_order_confirmed");
      if (isLimit) {
        return { brokerOrderId: `tradesea-${Date.now()}`, status: "pending" };
      }

      // Same "don't trust a click alone" posture as BrowserControlBroker --
      // a successful Confirm click only means Playwright didn't throw, not
      // that Tradesea actually accepted the order server-side.
      const confirmed = await this.confirmPositionOpened(request.symbol);
      if (!confirmed) {
        logger.error({ symbol: request.symbol }, "tradesea_order_confirmed_but_no_position_seen");
        return {
          brokerOrderId: "",
          status: "rejected",
          error: "order confirmed but no real position appeared on the Tradesea account afterward -- broker likely rejected it silently",
        };
      }
      const filledPrice = await this.readRealFillPrice(request.symbol, request.referencePrice);
      return { brokerOrderId: `tradesea-${Date.now()}`, status: "filled", filledPrice, filledAt: new Date() };
    } catch (err) {
      logger.error({ symbol: request.symbol, err: String(err) }, "tradesea_order_placement_failed");
      return { brokerOrderId: "", status: "rejected", error: String(err) };
    }
  }

  private async confirmPositionOpened(symbol: string): Promise<boolean> {
    const instrument = getInstrument(symbol);
    for (let attempt = 0; attempt < FILL_CONFIRMATION_RETRIES; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, FILL_CONFIRMATION_DELAY_MS));
      const isFlat = await this.checkPositionFlat(instrument.brokerContractPrefix).catch(() => null);
      if (isFlat === false) return true;
    }
    return false;
  }

  // Absolute per-instrument tolerance rather than a percentage, for exactly
  // the reasons BrowserControlBroker.readRealFillPrice's own comment gives --
  // the 5% relative guard this replaces was inert on a five-figure index and
  // let DOM misreads 22-64 points off the real fill become the anchor for a
  // live stop and target. Kept in step with that method deliberately: both
  // scrape the same positions-panel cell through the same helper, so a guard
  // that only held on one of them would just relocate the bug.
  private async readRealFillPrice(symbol: string, theoreticalPrice: Decimal): Promise<Decimal> {
    const instrument = getInstrument(symbol);
    let lastDeviationPoints: string | null = null;
    for (let attempt = 0; attempt < FILL_CONFIRMATION_RETRIES; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, FILL_CONFIRMATION_DELAY_MS));
      const page = await this.getPage().catch(() => null);
      if (!page) continue;
      const raw = await readOpenPositionFillPrice(page, instrument.brokerContractPrefix).catch(() => null);
      if (raw === null) continue;
      const real = new Decimal(raw);
      const deviationPoints = real.minus(theoreticalPrice).abs();
      if (deviationPoints.lte(instrument.maxFillDeviationPoints)) {
        logger.info(
          { symbol, theoreticalPrice: theoreticalPrice.toString(), realPrice: real.toString(), deviationPoints: deviationPoints.toString() },
          "tradesea_real_fill_price_used"
        );
        return real;
      }
      lastDeviationPoints = deviationPoints.toString();
      logger.warn(
        {
          symbol,
          theoreticalPrice: theoreticalPrice.toString(),
          rejectedPrice: real.toString(),
          deviationPoints: deviationPoints.toString(),
          maxFillDeviationPoints: instrument.maxFillDeviationPoints.toString(),
          attempt: attempt + 1,
        },
        "tradesea_real_fill_price_rejected_too_far_from_theoretical"
      );
    }
    logger.warn(
      { symbol, theoreticalPrice: theoreticalPrice.toString(), lastDeviationPoints, maxFillDeviationPoints: instrument.maxFillDeviationPoints.toString() },
      "tradesea_real_fill_price_unavailable_using_theoretical"
    );
    return theoreticalPrice;
  }

  private async checkPositionFlat(contractPrefix: string): Promise<boolean | null> {
    const page = await this.getPage();
    return isPositionFlatViaPanel(page, contractPrefix);
  }

  async flattenPosition(symbol: string, side: "long" | "short", quantity: number): Promise<OrderResult> {
    if (quantity <= 0) {
      return { brokerOrderId: "", status: "rejected", error: "refusing to flatten with non-positive quantity" };
    }
    try {
      const page = await this.getPage();
      const instrument = getInstrument(symbol);
      const widget = await findOrderWidget(page, instrument.brokerContractPrefix);
      if (!widget) {
        return { brokerOrderId: "", status: "rejected", error: `Tradesea's Order-tab ticket is not currently showing contract prefix "${instrument.brokerContractPrefix}"` };
      }

      await setOrderType(widget, "market");
      await setQuantity(widget, quantity);
      // Flattening a long means selling, flattening a short means buying --
      // no stop/target set, this is a closing trade.
      await selectSide(widget, side === "long" ? "sell" : "buy");

      const result = await submitConfirm(widget, this.config.dryRunOrders);
      if (result.dryRun) {
        return {
          brokerOrderId: "",
          status: "rejected",
          error: `TRADESEA_DRY_RUN_ORDERS is enabled -- would have clicked "${result.buttonText}" to flatten. Set TRADESEA_DRY_RUN_ORDERS=false to place real orders.`,
        };
      }
      logger.info({ symbol, side, quantity }, "tradesea_flatten_order_confirmed");
      return { brokerOrderId: `tradesea-flatten-${Date.now()}`, status: "filled", filledAt: new Date() };
    } catch (err) {
      logger.error({ symbol, err: String(err) }, "tradesea_flatten_position_failed");
      return { brokerOrderId: "", status: "rejected", error: String(err) };
    }
  }

  async requestClosePosition(symbol: string): Promise<OrderResult> {
    try {
      const page = await this.getPage();
      const instrument = getInstrument(symbol);
      const widget = await findDomActionWidget(page, instrument.brokerContractPrefix);
      if (!widget) {
        return { brokerOrderId: "", status: "rejected", error: `Tradesea's DOM-tab action bar is not currently showing contract prefix "${instrument.brokerContractPrefix}"` };
      }

      const result = await submitClosePosition(widget, this.config.dryRunOrders);
      if (result.dryRun) {
        return { brokerOrderId: "", status: "rejected", error: `TRADESEA_DRY_RUN_ORDERS is enabled -- would have clicked "${result.buttonText}"` };
      }
      logger.info({ symbol }, "tradesea_close_position_confirmed");
      return { brokerOrderId: `tradesea-close-${Date.now()}`, status: "filled", filledAt: new Date() };
    } catch (err) {
      logger.error({ symbol, err: String(err) }, "tradesea_close_position_failed");
      return { brokerOrderId: "", status: "rejected", error: String(err) };
    }
  }

  async cancelRestingOrder(symbol: string): Promise<OrderResult> {
    try {
      const page = await this.getPage();
      const instrument = getInstrument(symbol);
      const widget = await findDomActionWidget(page, instrument.brokerContractPrefix);
      if (!widget) {
        return { brokerOrderId: "", status: "rejected", error: `Tradesea's DOM-tab action bar is not currently showing contract prefix "${instrument.brokerContractPrefix}"` };
      }

      const result = await submitCancelAll(widget, this.config.dryRunOrders);
      if (result.dryRun) {
        return { brokerOrderId: "", status: "rejected", error: `TRADESEA_DRY_RUN_ORDERS is enabled -- would have clicked "${result.buttonText}"` };
      }
      logger.info({ symbol }, "tradesea_cancel_all_confirmed");
      return { brokerOrderId: `tradesea-cancel-${Date.now()}`, status: "filled", filledAt: new Date() };
    } catch (err) {
      logger.error({ symbol, err: String(err) }, "tradesea_cancel_resting_order_failed");
      return { brokerOrderId: "", status: "rejected", error: String(err) };
    }
  }

  async isPositionFlat(symbol: string): Promise<boolean | null> {
    try {
      const instrument = getInstrument(symbol);
      return await this.checkPositionFlat(instrument.brokerContractPrefix);
    } catch (err) {
      logger.warn({ symbol, err: String(err) }, "tradesea_is_position_flat_check_failed");
      return null; // couldn't determine -- never guess
    }
  }

  async cancelOrder(): Promise<boolean> {
    throw new Error("TradeseaBrowserControlBroker does not support cancelOrder -- use flattenPosition instead");
  }
  async getPositions(): Promise<BrokerPosition[]> {
    throw new Error("TradeseaBrowserControlBroker does not support getPositions -- positions are tracked via the trades table");
  }
  async getOpenOrders(): Promise<BrokerOrder[]> {
    throw new Error("TradeseaBrowserControlBroker does not support getOpenOrders");
  }
  async getHistoricalBars(): Promise<HistoricalBar[]> {
    throw new Error("TradeseaBrowserControlBroker does not support getHistoricalBars -- price data comes from the shared TopstepX-sourced feed");
  }
}
