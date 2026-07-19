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
 * Buy/Sell/Close click still runs for real -- quantity, $ risk/profit
 * brackets -- but the click itself is replaced with a highlight, so the
 * intended action can be verified visually before any money moves.
 *
 * Known limitation: this only PLACES/CLOSES orders on command. It does not
 * detect when TopstepX's own bracket order closes a position server-side
 * (stop/target hit) -- a `trades` row opened this way stays "open" in our DB
 * until closed via the explicit close-position action.
 */
import { Decimal } from "decimal.js";
import type { Browser, Page } from "playwright-core";
import { connectToChrome, findPage } from "../browserWatch/cdpClient.js";
import { computeBracketDollars } from "../browserControl/pure.js";
import {
  configureBracket,
  findBlockingModalText,
  findOrderWidget,
  isPositionFlat as isPositionFlatCheck,
  setQuantity,
  submitBuy,
  submitClosePosition,
  submitSell,
} from "../browserControl/orderTicket.js";
import { getSettings } from "../core/config.js";
import { childLogger } from "../core/logger.js";
import { getLatestBrowserAccountSnapshot } from "../engine/liveAccountOverride.js";
import { getInstrument } from "../marketData/instruments.js";
import type { BrokerAccount, BrokerClient, BrokerOrder, BrokerPosition, HistoricalBar, OrderRequest, OrderResult } from "./types.js";
import { OrderSide } from "./types.js";

const logger = childLogger("browserControlBroker");

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
    if (!request.stopLossPrice || !request.referencePrice) {
      return { brokerOrderId: "", status: "rejected", error: "refusing to place an order with no stop-loss price -- no stop, no trade" };
    }

    try {
      const page = await this.getPage();

      const blockingModal = await findBlockingModalText(page);
      if (blockingModal) {
        return { brokerOrderId: "", status: "rejected", error: `TopstepX is showing a blocking modal: "${blockingModal}"` };
      }

      const instrument = getInstrument(request.symbol);
      const widget = await findOrderWidget(page, instrument.brokerContractPrefix);
      if (!widget) {
        return {
          brokerOrderId: "",
          status: "rejected",
          error: `no order-entry widget found on TopstepX for contract prefix "${instrument.brokerContractPrefix}" -- add one to your layout`,
        };
      }

      await setQuantity(widget, request.quantity);

      const { riskDollars, profitDollars } = computeBracketDollars(
        request.referencePrice,
        request.stopLossPrice,
        request.takeProfitPrice ?? null,
        request.quantity,
        instrument.pointValue
      );
      await configureBracket(page, widget, riskDollars, profitDollars);

      const result =
        request.side === OrderSide.BUY ? await submitBuy(widget, settings.dryRunOrders) : await submitSell(widget, settings.dryRunOrders);

      if (result.dryRun) {
        logger.info(
          { symbol: request.symbol, side: request.side, quantity: request.quantity, riskDollars, profitDollars, buttonText: result.buttonText },
          "dry_run_order_not_submitted"
        );
        return {
          brokerOrderId: "",
          status: "rejected",
          error: `DRY_RUN_ORDERS is enabled -- would have clicked "${result.buttonText}" (risk ~$${riskDollars}, profit ~$${profitDollars ?? "n/a"}). Set DRY_RUN_ORDERS=false to place real orders.`,
        };
      }

      logger.info({ symbol: request.symbol, side: request.side, quantity: request.quantity, riskDollars, profitDollars }, "order_clicked");
      return { brokerOrderId: `browser-${Date.now()}`, status: "filled", filledPrice: request.referencePrice, filledAt: new Date() };
    } catch (err) {
      logger.error({ symbol: request.symbol, err: String(err) }, "order_placement_failed");
      return { brokerOrderId: "", status: "rejected", error: String(err) };
    }
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
      const widget = await findOrderWidget(page, instrument.brokerContractPrefix);
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

  async cancelOrder(): Promise<boolean> {
    throw new Error("BrowserControlBroker does not support cancelOrder -- use closePosition instead");
  }
  async isPositionFlat(symbol: string): Promise<boolean | null> {
    try {
      const page = await this.getPage();
      const instrument = getInstrument(symbol);
      return await isPositionFlatCheck(page, instrument.brokerContractPrefix);
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
