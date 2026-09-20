/**
 * BrokerClient implementation that places real orders by driving TopstepX's
 * web UI directly (mouse/keyboard automation over the same CDP connection
 * browserWatch/watcher.ts uses read-only) -- built because the account has
 * no ProjectX Gateway API credentials.
 *
 * Real clicks require FOUR independent, explicit opt-ins:
 *   1. TRADING_MODE=live
 *   2. BROKER_KIND=browser_control
 *   3. LIVE_TRADING_CONFIRMED=true      (checked in execution/mode.ts)
 *   4. DRY_RUN_ORDERS=false             (checked here, in placeOrder)
 * With DRY_RUN_ORDERS on (the default), every step short of the final
 * Buy/Sell/Close click still runs for real -- quantity, order type, limit
 * price -- but the click itself is replaced with a highlight, so the
 * intended action can be verified visually before any money moves.
 *
 * placeOrder deliberately does NOT configure TopstepX's own Position
 * Brackets (2026-07-21 operator decision, after that DOM automation caused
 * two real unprotected positions in one night). Every open position's real
 * protection is engine/loop.ts's manageLiveOpenTrade: it polls every price
 * tick against the trade's own stopPrice/takeProfitPrice and actively closes
 * the position (requestClosePosition, falling back to flattenPosition) the
 * moment either is crossed, regardless of anything broker-side. Known
 * tradeoff: while the backend itself is down, an open position has no stop
 * at all, since nothing broker-side is watching it either.
 */
import { Decimal } from "decimal.js";
import type { Browser, Page } from "playwright-core";
import { connectToChrome, findPage } from "../browserWatch/cdpClient.js";
import {
  findBlockingModalText,
  findOrSwitchToOrderWidget,
  isPositionFlat as isPositionFlatCheck,
  setLimitPrice,
  setOrderType,
  setQuantity,
  setTrailDistanceTicks,
  submitBuy,
  submitCancelOrders,
  submitClosePosition,
  submitSell,
} from "../browserControl/orderTicket.js";
import { isPositionFlatViaPanel, readOpenPositionFillPrice } from "../browserControl/positionsPanel.js";
import { readClosedTradeHistoryForContract } from "../browserControl/tradeHistoryPanel.js";
import { getSettings } from "../core/config.js";
import { childLogger } from "../core/logger.js";
import { getLatestBrowserAccountSnapshot } from "../engine/liveAccountOverride.js";
import { getInstrument } from "../marketData/instruments.js";
import type { BrokerAccount, BrokerClient, BrokerOrder, BrokerPosition, ClosedTradeHistoryEntry, HistoricalBar, OrderRequest, OrderResult } from "./types.js";
import { OrderSide, OrderType } from "./types.js";

const logger = childLogger("browserControlBroker");

// How long to give TopstepX to actually process a market order before
// concluding the click didn't produce a real fill -- hand-set, not
// measured against a real distribution of fill latency yet. 4 attempts
// 750ms apart (~3s total) trades a small amount of added latency on every
// real entry for eliminating the phantom-trade failure mode entirely.
const FILL_CONFIRMATION_RETRIES = 4;
const FILL_CONFIRMATION_DELAY_MS = 750;

export class BrowserControlBroker implements BrokerClient {
  private browser: Browser | undefined;

  async connect(): Promise<void> {
    const settings = getSettings();
    this.browser = await connectToChrome(settings.browserCdpUrl);
    const page = await findPage(this.browser, settings.browserUrlMatch);
    if (!page) {
      throw new Error(`No open Chrome tab matching "${settings.browserUrlMatch}" -- is Chrome running with --remote-debugging-port and TopstepX open?`);
    }
    if (settings.dryRunOrders) {
      logger.warn("DRY_RUN_ORDERS is enabled -- orders will be prepared (qty/bracket set) but never actually submitted");
    } else {
      logger.warn("DRY_RUN_ORDERS is disabled -- this broker will click real Buy/Sell/Close buttons on your real account");
    }
  }

  async disconnect(): Promise<void> {
    // Deliberately not calling browser.close() -- this Browser object is a
    // connection borrowed from the user's real, already-running Chrome via
    // connectOverCDP, and closing it risks closing their actual window/session.
    this.browser = undefined;
  }

  // v1.5 (2026-08-31, operator report of a closed trade recording the wrong
  // entry/exit/pnl): reads TopstepX's own Trade History grid instead of
  // guessing -- see tradeHistoryPanel.ts's header comment for why neither
  // entry nor exit price this app records is guaranteed real without this.
  async readClosedTradeHistory(symbol: string): Promise<ClosedTradeHistoryEntry[] | null> {
    const instrument = getInstrument(symbol);
    const page = await this.getPage().catch(() => null);
    if (!page) return null;
    return readClosedTradeHistoryForContract(page, instrument.brokerContractPrefix);
  }

  private async getPage(): Promise<Page> {
    const settings = getSettings();
    if (!this.browser) this.browser = await connectToChrome(settings.browserCdpUrl);
    const page = await findPage(this.browser, settings.browserUrlMatch);
    if (!page) throw new Error(`No open Chrome tab matching "${settings.browserUrlMatch}"`);
    return page;
  }

  async getAccounts(): Promise<BrokerAccount[]> {
    const snapshot = getLatestBrowserAccountSnapshot();
    return [
      {
        accountId: "browser",
        name: "TopstepX (browser-controlled)",
        balance: new Decimal(snapshot?.balance ?? 0),
        equity: new Decimal(snapshot?.equity ?? snapshot?.balance ?? 0),
      },
    ];
  }

  async placeOrder(request: OrderRequest): Promise<OrderResult> {
    const settings = getSettings();
    if (request.quantity <= 0) {
      return { brokerOrderId: "", status: "rejected", error: "refusing to place an order with non-positive quantity" };
    }
    // Was `if (!request.stopLossPrice || !request.referencePrice)` -- the
    // stopLossPrice half of this refusal is gone (2026-08-18, operator
    // request: "remove stop loss constraints right now," explicitly
    // confirmed as no stop-loss at all, not merely a looser one). Every real
    // trade still carries a non-null stopLossPrice (risk/engine.ts's
    // hardTakeProfitDollars path sends a sentinel far-away price instead of
    // ever passing undefined -- see NO_STOP_LOSS_SENTINEL_POINTS), so this
    // still guards against a genuinely malformed request; it's just no
    // longer this class's job to decide whether that price is a real risk
    // control.
    if (!request.referencePrice) {
      return { brokerOrderId: "", status: "rejected", error: "refusing to place an order with no reference price" };
    }
    const isLimit = request.orderType === OrderType.LIMIT;
    if (isLimit && !request.limitPrice) {
      return { brokerOrderId: "", status: "rejected", error: "refusing to place a limit order with no limitPrice" };
    }

    try {
      const page = await this.getPage();

      const blockingModal = await findBlockingModalText(page);
      if (blockingModal) {
        return { brokerOrderId: "", status: "rejected", error: `TopstepX is showing a blocking modal: "${blockingModal}"` };
      }

      const instrument = getInstrument(request.symbol);
      const widget = await findOrSwitchToOrderWidget(page, instrument.brokerContractPrefix);
      if (!widget) {
        return {
          brokerOrderId: "",
          status: "rejected",
          error: `no order-entry widget found on TopstepX for contract prefix "${instrument.brokerContractPrefix}" -- add one to your layout`,
        };
      }

      // The ticket's order type persists across calls (it's real UI state,
      // not reset per-request) -- always set it explicitly rather than
      // assuming it's still on whatever the last order used.
      await setOrderType(widget, isLimit ? "limit" : "market");
      if (isLimit) {
        await setLimitPrice(widget, request.limitPrice!, instrument.tickSize);
      }
      await setQuantity(widget, request.quantity);

      // Deliberately NOT configuring TopstepX's own Position Brackets here
      // (2026-07-21 operator decision) -- that DOM automation (checkbox +
      // risk/profit popover + Save Changes) caused two real unprotected
      // positions in one night before the Save Changes fix, and even fixed,
      // it's still more fragile surface than this needs. Protection instead
      // comes entirely from engine/loop.ts's manageLiveOpenTrade, which polls
      // every price tick against this trade's own stopPrice/takeProfitPrice
      // and force-closes it the moment either is crossed -- already proven
      // live tonight (closed trade #163 exactly at its stop). The tradeoff,
      // made knowingly: if the backend itself is down, this position has no
      // stop at all until it's back up, since nothing broker-side is
      // watching it either.
      const result =
        request.side === OrderSide.BUY ? await submitBuy(widget, settings.dryRunOrders) : await submitSell(widget, settings.dryRunOrders);

      if (result.dryRun) {
        logger.info(
          { symbol: request.symbol, side: request.side, quantity: request.quantity, orderType: request.orderType, limitPrice: request.limitPrice?.toString(), buttonText: result.buttonText },
          "dry_run_order_not_submitted"
        );
        return {
          brokerOrderId: "",
          status: "rejected",
          error: `DRY_RUN_ORDERS is enabled -- would have clicked "${result.buttonText}". Set DRY_RUN_ORDERS=false to place real orders.`,
        };
      }

      logger.info({ symbol: request.symbol, side: request.side, quantity: request.quantity, orderType: request.orderType, limitPrice: request.limitPrice?.toString() }, "order_clicked");
      // A limit order is now resting on the book, not filled -- callers must
      // not treat this the same as a market fill (see engine/loop.ts's use
      // of OrderResult.status to decide whether a Trade row is "open" yet).
      if (isLimit) {
        return { brokerOrderId: `browser-${Date.now()}`, status: "pending" };
      }

      // A successful click only means Playwright didn't throw -- it says
      // nothing about whether TopstepX actually accepted the order
      // server-side. At least 6 phantom "open" trades were recorded from
      // exactly this gap in one session (a silent broker-side rejection --
      // a lockout, a margin check, anything that doesn't throw here --
      // still got reported as "filled"). Confirm a real position actually
      // exists before ever telling the caller this was a fill; treat
      // "still flat" (or never resolvable) the same as a rejected order,
      // since a missed real fill (caught later via reconcile-trade's
      // Failure Shape 2) is far cheaper than another phantom trade.
      const confirmed = await this.confirmPositionOpened(request.symbol);
      if (!confirmed) {
        logger.error({ symbol: request.symbol }, "order_click_succeeded_but_no_position_confirmed");
        return {
          brokerOrderId: "",
          status: "rejected",
          error: "order click succeeded but no real position appeared on the account afterward -- broker likely rejected it silently",
        };
      }
      const filledPrice = await this.readRealFillPrice(request.symbol, request.referencePrice);
      return { brokerOrderId: `browser-${Date.now()}`, status: "filled", filledPrice, filledAt: new Date() };
    } catch (err) {
      logger.error({ symbol: request.symbol, err: String(err) }, "order_placement_failed");
      return { brokerOrderId: "", status: "rejected", error: String(err) };
    }
  }

  // TopstepX needs a moment to actually process an order after the click
  // returns -- polls isPositionFlat a few times with a short delay rather
  // than checking once immediately, which measured live as too early to
  // reliably see the resulting position yet. Returns false (not confirmed)
  // on a persistent "still flat" *or* a persistent "can't tell" -- this is
  // the one place "don't guess" is deliberately overridden by "when unsure,
  // don't record a trade," since the cost of the two failure directions is
  // asymmetric (a missed real fill is reconcilable later; a phantom trade
  // silently pollutes real risk tracking until someone notices).
  private async confirmPositionOpened(symbol: string): Promise<boolean> {
    const instrument = getInstrument(symbol);
    for (let attempt = 0; attempt < FILL_CONFIRMATION_RETRIES; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, FILL_CONFIRMATION_DELAY_MS));
      const isFlat = await this.checkPositionFlat(instrument.brokerContractPrefix).catch(() => null);
      if (isFlat === false) return true;
    }
    return false;
  }

  // Reads the real fill price off the Positions panel after a confirmed real
  // entry (2026-08-17, operator request) -- this class previously never read
  // back a real fill price at all, always echoing the theoretical signal
  // price straight back (see this class's header comment). Polls the same
  // FILL_CONFIRMATION_RETRIES/_DELAY_MS cadence as confirmPositionOpened,
  // since the row's price cell can take the same moment to populate as the
  // row itself takes to appear. A reading is only trusted within 5% of the
  // theoretical price -- a misread (wrong row, stale DOM, a mid-scroll
  // partial render) must never feed a real stop-loss (see
  // execution/engine.ts's shift-by-fill-offset logic, which is exactly what
  // a bad read here would corrupt). Keeps polling across a rejected reading
  // (not just an unreadable one) in case a later attempt catches a settled
  // value; falls back to the theoretical price, logging which happened
  // either way, rather than ever return null to a caller with no fallback
  // of its own.
  private async readRealFillPrice(symbol: string, theoreticalPrice: Decimal): Promise<Decimal> {
    const instrument = getInstrument(symbol);
    let lastDeviationPct: string | null = null;
    for (let attempt = 0; attempt < FILL_CONFIRMATION_RETRIES; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, FILL_CONFIRMATION_DELAY_MS));
      const page = await this.getPage().catch(() => null);
      if (!page) continue;
      const raw = await readOpenPositionFillPrice(page, instrument.brokerContractPrefix).catch(() => null);
      if (raw === null) continue;
      const real = new Decimal(raw);
      const deviation = real.minus(theoreticalPrice).abs().dividedBy(theoreticalPrice);
      if (deviation.lte("0.05")) {
        logger.info({ symbol, theoreticalPrice: theoreticalPrice.toString(), realPrice: real.toString() }, "real_fill_price_used");
        return real;
      }
      lastDeviationPct = deviation.times(100).toFixed(2);
    }
    logger.warn({ symbol, theoreticalPrice: theoreticalPrice.toString(), lastDeviationPct }, "real_fill_price_unavailable_or_too_far_from_theoretical_using_theoretical");
    return theoreticalPrice;
  }

  // Prefers the dedicated Positions panel (a single table of every open
  // position at once, no per-symbol widget contention at all -- see
  // browserControl/positionsPanel.ts) -- falls back to the order-entry
  // widget's own read-only check only if the panel itself isn't available
  // (e.g. the operator removed it from their layout), so this degrades
  // gracefully rather than going fully blind. Replaced a version of this
  // that made the widget check switch contracts itself (2026-07-22): fixed
  // the same missed-close problem, but visibly flipped the shared ticket
  // between symbols on every tick, which wasn't an acceptable trade -- the
  // panel avoids that entirely since it's a passive read, not a switch.
  private async checkPositionFlat(contractPrefix: string): Promise<boolean | null> {
    const page = await this.getPage();
    const viaPanel = await isPositionFlatViaPanel(page, contractPrefix);
    if (viaPanel !== null) return viaPanel;
    return await isPositionFlatCheck(page, contractPrefix);
  }

  async requestClosePosition(symbol: string): Promise<OrderResult> {
    const settings = getSettings();
    try {
      const page = await this.getPage();

      const blockingModal = await findBlockingModalText(page);
      if (blockingModal) {
        return { brokerOrderId: "", status: "rejected", error: `TopstepX is showing a blocking modal: "${blockingModal}"` };
      }

      const instrument = getInstrument(symbol);
      const widget = await findOrSwitchToOrderWidget(page, instrument.brokerContractPrefix);
      if (!widget) {
        return { brokerOrderId: "", status: "rejected", error: `no order-entry widget found for contract prefix "${instrument.brokerContractPrefix}"` };
      }

      const result = await submitClosePosition(widget, settings.dryRunOrders);
      if (result.dryRun) {
        return { brokerOrderId: "", status: "rejected", error: `DRY_RUN_ORDERS is enabled -- would have clicked "${result.buttonText}"` };
      }
      logger.info({ symbol }, "close_position_clicked");
      return { brokerOrderId: `browser-close-${Date.now()}`, status: "filled", filledAt: new Date() };
    } catch (err) {
      logger.error({ symbol, err: String(err) }, "close_position_failed");
      return { brokerOrderId: "", status: "rejected", error: String(err) };
    }
  }

  async flattenPosition(symbol: string, side: "long" | "short", quantity: number): Promise<OrderResult> {
    const settings = getSettings();
    if (quantity <= 0) {
      return { brokerOrderId: "", status: "rejected", error: "refusing to flatten with non-positive quantity" };
    }
    try {
      const page = await this.getPage();

      const blockingModal = await findBlockingModalText(page);
      if (blockingModal) {
        return { brokerOrderId: "", status: "rejected", error: `TopstepX is showing a blocking modal: "${blockingModal}"` };
      }

      const instrument = getInstrument(symbol);
      const widget = await findOrSwitchToOrderWidget(page, instrument.brokerContractPrefix);
      if (!widget) {
        return { brokerOrderId: "", status: "rejected", error: `no order-entry widget found for contract prefix "${instrument.brokerContractPrefix}"` };
      }

      await setQuantity(widget, quantity);

      // No configureBracket call here -- this is a closing trade, not a new
      // entry, so there's no stop/target to attach. Flattening a long means
      // selling, flattening a short means buying: the opposite of the
      // position's own side.
      const result = side === "long" ? await submitSell(widget, settings.dryRunOrders) : await submitBuy(widget, settings.dryRunOrders);

      if (result.dryRun) {
        return {
          brokerOrderId: "",
          status: "rejected",
          error: `DRY_RUN_ORDERS is enabled -- would have clicked "${result.buttonText}" to flatten. Set DRY_RUN_ORDERS=false to place real orders.`,
        };
      }

      logger.info({ symbol, side, quantity }, "flatten_order_clicked");
      return { brokerOrderId: `browser-flatten-${Date.now()}`, status: "filled", filledAt: new Date() };
    } catch (err) {
      logger.error({ symbol, err: String(err) }, "flatten_position_failed");
      return { brokerOrderId: "", status: "rejected", error: String(err) };
    }
  }

  async placeTrailingStop(symbol: string, side: "long" | "short", quantity: number, trailTicks: number): Promise<OrderResult> {
    const settings = getSettings();
    if (quantity <= 0) {
      return { brokerOrderId: "", status: "rejected", error: "refusing to place a trailing stop with non-positive quantity" };
    }
    try {
      const page = await this.getPage();

      const blockingModal = await findBlockingModalText(page);
      if (blockingModal) {
        return { brokerOrderId: "", status: "rejected", error: `TopstepX is showing a blocking modal: "${blockingModal}"` };
      }

      const instrument = getInstrument(symbol);
      const widget = await findOrSwitchToOrderWidget(page, instrument.brokerContractPrefix);
      if (!widget) {
        return { brokerOrderId: "", status: "rejected", error: `no order-entry widget found for contract prefix "${instrument.brokerContractPrefix}"` };
      }

      await setOrderType(widget, "trailingStop");
      await setTrailDistanceTicks(widget, trailTicks);
      await setQuantity(widget, quantity);

      // Protects an EXISTING position -- opposite side from the position
      // itself (sell to protect a long, buy to protect a short), same shape
      // as flattenPosition above, just a resting Trailing Stop order instead
      // of an immediate Market close.
      const result = side === "long" ? await submitSell(widget, settings.dryRunOrders) : await submitBuy(widget, settings.dryRunOrders);

      if (result.dryRun) {
        return {
          brokerOrderId: "",
          status: "rejected",
          error: `DRY_RUN_ORDERS is enabled -- would have clicked "${result.buttonText}" for a ${trailTicks}-tick trailing stop. Set DRY_RUN_ORDERS=false to place real orders.`,
        };
      }

      // A trailing stop is a resting order, not an immediate fill -- same
      // "pending" convention placeOrder uses for a limit order.
      logger.info({ symbol, side, quantity, trailTicks }, "trailing_stop_order_clicked");
      return { brokerOrderId: `browser-trail-${Date.now()}`, status: "pending" };
    } catch (err) {
      logger.error({ symbol, err: String(err) }, "place_trailing_stop_failed");
      return { brokerOrderId: "", status: "rejected", error: String(err) };
    }
  }

  // See BrokerClient.placeTakeProfitOrder's own doc comment for why this exists and why it's
  // deliberately built the same way as placeTrailingStop (a plain resting limit order via the
  // normal order ticket) rather than TopstepX's native Position Brackets feature.
  async placeTakeProfitOrder(symbol: string, side: "long" | "short", quantity: number, limitPrice: Decimal): Promise<OrderResult> {
    const settings = getSettings();
    if (quantity <= 0) {
      return { brokerOrderId: "", status: "rejected", error: "refusing to place a take-profit order with non-positive quantity" };
    }
    try {
      const page = await this.getPage();

      const blockingModal = await findBlockingModalText(page);
      if (blockingModal) {
        return { brokerOrderId: "", status: "rejected", error: `TopstepX is showing a blocking modal: "${blockingModal}"` };
      }

      const instrument = getInstrument(symbol);
      const widget = await findOrSwitchToOrderWidget(page, instrument.brokerContractPrefix);
      if (!widget) {
        return { brokerOrderId: "", status: "rejected", error: `no order-entry widget found for contract prefix "${instrument.brokerContractPrefix}"` };
      }

      await setOrderType(widget, "limit");
      await setLimitPrice(widget, limitPrice, instrument.tickSize);
      await setQuantity(widget, quantity);

      // Protects an EXISTING position -- opposite side from the position itself (sell to take
      // profit on a long, buy to take profit on a short), same shape as placeTrailingStop above.
      const result = side === "long" ? await submitSell(widget, settings.dryRunOrders) : await submitBuy(widget, settings.dryRunOrders);

      if (result.dryRun) {
        return {
          brokerOrderId: "",
          status: "rejected",
          error: `DRY_RUN_ORDERS is enabled -- would have clicked "${result.buttonText}" for a take-profit limit order at ${limitPrice.toString()}. Set DRY_RUN_ORDERS=false to place real orders.`,
        };
      }

      // A resting limit order, not an immediate fill -- same "pending" convention placeOrder's
      // limit-order path and placeTrailingStop both use.
      logger.info({ symbol, side, quantity, limitPrice: limitPrice.toString() }, "take_profit_order_clicked");
      return { brokerOrderId: `browser-tp-${Date.now()}`, status: "pending" };
    } catch (err) {
      logger.error({ symbol, err: String(err) }, "place_take_profit_order_failed");
      return { brokerOrderId: "", status: "rejected", error: String(err) };
    }
  }

  async cancelOrder(): Promise<boolean> {
    throw new Error("BrowserControlBroker does not support cancelOrder -- use closePosition instead");
  }

  async cancelRestingOrder(symbol: string): Promise<OrderResult> {
    const settings = getSettings();
    try {
      const page = await this.getPage();

      const blockingModal = await findBlockingModalText(page);
      if (blockingModal) {
        return { brokerOrderId: "", status: "rejected", error: `TopstepX is showing a blocking modal: "${blockingModal}"` };
      }

      const instrument = getInstrument(symbol);
      const widget = await findOrSwitchToOrderWidget(page, instrument.brokerContractPrefix);
      if (!widget) {
        return { brokerOrderId: "", status: "rejected", error: `no order-entry widget found for contract prefix "${instrument.brokerContractPrefix}"` };
      }

      const result = await submitCancelOrders(widget, settings.dryRunOrders);
      if (result.dryRun) {
        return { brokerOrderId: "", status: "rejected", error: `DRY_RUN_ORDERS is enabled -- would have clicked "${result.buttonText}"` };
      }
      logger.info({ symbol }, "cancel_orders_clicked");
      return { brokerOrderId: `browser-cancel-${Date.now()}`, status: "filled", filledAt: new Date() };
    } catch (err) {
      logger.error({ symbol, err: String(err) }, "cancel_resting_order_failed");
      return { brokerOrderId: "", status: "rejected", error: String(err) };
    }
  }
  async isPositionFlat(symbol: string): Promise<boolean | null> {
    try {
      const instrument = getInstrument(symbol);
      return await this.checkPositionFlat(instrument.brokerContractPrefix);
    } catch (err) {
      logger.warn({ symbol, err: String(err) }, "is_position_flat_check_failed");
      return null; // couldn't determine -- never guess
    }
  }
  async getPositions(): Promise<BrokerPosition[]> {
    throw new Error("BrowserControlBroker does not support getPositions -- positions are tracked via the trades table");
  }
  async getOpenOrders(): Promise<BrokerOrder[]> {
    throw new Error("BrowserControlBroker does not support getOpenOrders");
  }
  async getHistoricalBars(): Promise<HistoricalBar[]> {
    throw new Error("BrowserControlBroker does not support getHistoricalBars -- use the Yahoo/browser price sources instead");
  }
}
