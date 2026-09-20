/**
 * Drives Tradesea's real "Order" tab ticket (app.tradesea.ai/trade) over the
 * same CDP connection browserWatch reads account/price data from -- this
 * module actually clicks, types, and submits. Mirrors browserControl/
 * orderTicket.ts's role for TopstepX, but Tradesea's DOM has NO
 * data-testid/id/aria-label attributes at all (confirmed live, 2026-08-26) --
 * every selector below is text/structure-based and was verified live against
 * the real sandbox account before being written here (see this repo's
 * browser-automation-dev skill).
 *
 * Tradesea has three order-pad modes (Scalp/DOM/Order); this module always
 * drives the "Order" tab specifically -- unlike the DOM-ladder or Scalp
 * modes, it exposes explicit Quantity + Stop Loss/Take Profit price fields
 * that map directly onto what RiskEngine.assessNewTrade already computes
 * (absolute stop/target prices), rather than requiring a tick-offset or
 * click-a-ladder-cell translation.
 *
 * Buy/Sell here are TOGGLE buttons (pick which side the ticket is armed
 * for), not immediate-submit like TopstepX's -- the ticket only actually
 * submits when Confirm is clicked. This is unverified against a REAL
 * Confirm click as of this writing (only dry-run highlighting and read-only
 * toggling were tested live) -- see docs/BUILD_HISTORY.md and this repo's
 * browser-automation-dev skill: get explicit operator confirmation before
 * the first real Confirm click, same as any new write path.
 *
 * KNOWN GAP: symbol switching within the ticket is still unresolved --
 * this module only operates on whatever instrument the ticket is currently
 * displaying (matched via pure.ts's matchesContractPrefix); if a signal
 * fires for a different symbol than what's currently shown, findOrderWidget
 * returns null (fails closed) rather than guessing at how to switch
 * instruments. This matters in practice: Tera Trade actively trades BOTH
 * ES and NQ, but the ticket currently only shows MNQ.
 *
 * Investigated live across two passes, 2026-08-28: there's no search box/
 * dropdown near the order ticket itself. The chart (a TradingView widget
 * embedded in a `blob:` iframe -- its own accessibility text documents
 * "Change symbol: start typing" / "Quick search: Ctrl+K") is the most
 * likely real mechanism, since TradingView's own order-panel widgets
 * typically follow the chart's active symbol. Ruled out concretely:
 *   - Ctrl+K, once genuinely focused on the chart pane, DOES open a real
 *     overlay ("Search tool or function... Type to search for drawings,
 *     functions and settings") -- but it's TradingView's general command
 *     palette (drawing tools/indicators/settings), NOT symbol search.
 *   - The chart's own `<canvas data-name="pane-canvas">` has `tabIndex=-1`
 *     and refuses DOM focus even via an explicit `.focus()` call --
 *     confirming TradingView routes chart keyboard shortcuts by mouse
 *     hover/click state, not standard DOM focus.
 *   - A REAL page-level `page.mouse.click()` on the canvas does shift
 *     top-page `document.activeElement` to the `<iframe>` element itself
 *     (confirmed) -- but subsequent `page.keyboard.type("MES", ...)`,
 *     tried both after a hover-only mousemove and after this real click,
 *     produced no visible change at all: symbol stayed "MNQ", no overlay
 *     appeared, nothing in the frame's own body text changed.
 * Net conclusion: top-page-dispatched keyboard events are not reliably
 * reaching whatever internal element inside this specific `blob:`-embedded
 * chart instance TradingView's "start typing to change symbol" shortcut
 * actually listens on -- a deeper internals question (which exact element/
 * listener setup this embed uses) than DOM archaeology can resolve
 * efficiently. Deliberately stopped here rather than continue open-ended
 * trial-and-error against a real account's live chart widget -- consulting
 * TradingView's own widget API/docs (if Tradesea's embed exposes one) is
 * the more promising next step, not more guessing.
 */
import type { Locator, Page } from "playwright-core";
import { Decimal } from "decimal.js";
import { matchesContractPrefix } from "./pure.js";
import { childLogger } from "../../core/logger.js";

const logger = childLogger("tradesea/orderTicket");

export interface OrderWidget {
  symbolLabel: Locator;
  buyButton: Locator;
  sellButton: Locator;
  marketButton: Locator;
  limitButton: Locator;
  /** Only present/meaningful once the Limit button has been clicked -- Tradesea doesn't render this field for Market orders (confirmed live, 2026-08-26; pre-filled with the current market price when it first appears). */
  limitPriceInput: Locator;
  qtyInput: Locator;
  stopLossToggle: Locator;
  stopLossPriceInput: Locator;
  takeProfitToggle: Locator;
  takeProfitPriceInput: Locator;
  confirmButton: Locator;
  cancelButton: Locator;
}

/**
 * Ensures the ticket is on the "Order" tab (not Scalp/DOM) -- no-ops if
 * already there. The three modes are siblings of one tab strip; clicking the
 * already-active one is harmless (confirmed live).
 */
// Confirmed live, 2026-08-27: the order pad can be collapsed to a
// minimized "Scalp Pad" view (a "Minimize Scalp/DOM/Order Pad" button,
// title varies by whichever mode was minimized) that has no mode tabs at
// all -- the automation would otherwise silently start failing every
// order ("ticket not currently showing contract prefix") until a human
// manually restores it. Restoring first makes this self-healing instead.
async function ensureOrderPadExpanded(page: Page): Promise<void> {
  const expandButton = page.locator('button[title="Expand to full order pad"]');
  if ((await expandButton.count()) > 0 && (await expandButton.isVisible().catch(() => false))) {
    await expandButton.click();
    await page.waitForTimeout(300);
  }
}

export async function ensureOrderTab(page: Page): Promise<void> {
  await ensureOrderPadExpanded(page);
  await page.getByTitle("Orderpad mode Order").click();
}

/**
 * Builds the OrderWidget for whatever instrument the Order-tab ticket is
 * currently displaying, or null if the ticket itself isn't present (wrong
 * tab, page not loaded, DOM changed). Read-only -- never switches anything.
 * See findOrSwitchToTicketForSymbol for the write-path version.
 */
export async function findOrderTicket(page: Page): Promise<OrderWidget | null> {
  // The ticket's own instrument label sits at the top of the panel, shown as
  // e.g. "CME:MNQ" (an "EXCHANGE:SYMBOL" shape unique to this label on the
  // page). Same "CME:MNQ" text also appears elsewhere (order history rows,
  // positions table), so this is scoped to the nearest such label preceding
  // the Buy/Sell toggle pair, which resolves to the Order-tab ticket's own
  // header specifically (confirmed live, 2026-08-26: exactly 1 match while
  // the Order tab is active, text reads "CME:MNQ").
  const buyButton = page.locator('button:has(span:text-is("Buy"))');
  if ((await buyButton.count()) === 0) return null;

  const symbolLabel = buyButton.locator('xpath=preceding::span[contains(text(),":")][1]');

  return {
    symbolLabel,
    buyButton,
    sellButton: page.locator('button:has(span:text-is("Sell"))'),
    marketButton: page.locator('button:has(span:text-is("Market"))'),
    limitButton: page.locator('button:has(span:text-is("Limit"))'),
    limitPriceInput: page.locator('span:text-is("Limit Price")').locator("xpath=following::input[1]"),
    qtyInput: page.locator('span:text-is("Quantity")').locator("xpath=following::input[1]"),
    ...buildBracketLocators(page, "Stop Loss"),
    ...buildTakeProfitLocators(page),
    confirmButton: page.locator("button", { hasText: /^Confirm$/ }),
    cancelButton: page.locator("button", { hasText: /^Cancel$/ }),
  };
}

// Stop Loss and Take Profit are structurally identical sections (a checkbox
// toggle + label, then a bordered Price/Ticks input pair) -- scoped by
// walking up from each section's own label to its containing "flex-col
// gap-1.5" ancestor, then finding the two type=text inputs within JUST that
// container (excluding Trail's own #trail_tick input, which lives in the
// SAME container as the Stop Loss toggle+label row -- confirmed live,
// 2026-08-26: without the :not(#trail_tick) exclusion, index 0 resolves to
// trail_tick instead of the Stop Loss Price input). Index 0 is the Price
// input, index 1 is Ticks -- confirmed live via the disabled-before/
// enabled-after-toggle-click check.
function buildBracketLocators(page: Page, labelText: "Stop Loss"): { stopLossToggle: Locator; stopLossPriceInput: Locator } {
  const label = page.locator(`span:text-is("${labelText}")`);
  const section = label.locator('xpath=ancestor::div[contains(@class,"flex-col") and contains(@class,"gap-1.5")][1]');
  const inputs = section.locator('input[type="text"]:not(#trail_tick)');
  return {
    stopLossToggle: label.locator("xpath=preceding-sibling::button[1]"),
    stopLossPriceInput: inputs.nth(0),
  };
}

function buildTakeProfitLocators(page: Page): { takeProfitToggle: Locator; takeProfitPriceInput: Locator } {
  const label = page.locator('span:text-is("Take Profit")');
  const section = label.locator('xpath=ancestor::div[contains(@class,"flex-col") and contains(@class,"gap-1.5")][1]');
  const inputs = section.locator('input[type="text"]:not(#trail_tick)');
  return {
    takeProfitToggle: label.locator("xpath=preceding-sibling::button[1]"),
    takeProfitPriceInput: inputs.nth(0),
  };
}

/**
 * Finds the Order-tab ticket only if it's currently showing contractPrefix
 * (e.g. "MNQ" matching a displayed "CME:MNQ"). Returns null (fails closed,
 * does not attempt to switch) if the ticket shows a different instrument --
 * see this file's header comment on the symbol-switching gap.
 */
export async function findOrderWidget(page: Page, contractPrefix: string): Promise<OrderWidget | null> {
  await ensureOrderTab(page);
  const widget = await findOrderTicket(page);
  if (!widget) return null;

  const displayed = (await widget.symbolLabel.textContent().catch(() => null))?.trim();
  if (!displayed || !matchesContractPrefix(displayed, contractPrefix)) {
    logger.warn({ contractPrefix, displayed }, "tradesea_order_ticket_wrong_symbol");
    return null;
  }
  return widget;
}

/**
 * "Close Position"/"Cancel All" (aria-label based, confirmed live 2026-08-27)
 * only exist in the "Scalp"/"DOM" order-pad modes, NOT "Order" -- a
 * completely separate action bar from OrderWidget above. "Reverse" and
 * "Flatten All" also live here but aren't driven yet (not wired into
 * BrokerClient -- see this file's header comment on scope).
 */
export interface DomActionWidget {
  symbolLabel: Locator;
  closePositionButton: Locator;
  cancelAllButton: Locator;
}

/** Ensures the order pad is on "DOM" mode (Close Position/Cancel All are present in both Scalp and DOM; DOM is the one this app already calibrates elsewhere). Expands the pad first if it's minimized -- see ensureOrderPadExpanded. */
export async function ensureDomTab(page: Page): Promise<void> {
  await ensureOrderPadExpanded(page);
  await page.getByTitle("Orderpad mode DOM").click();
}

/**
 * Finds the DOM-tab action bar only if it's currently showing
 * contractPrefix (same matching rule as findOrderWidget). Returns null
 * (fails closed) otherwise -- including when the action bar isn't present
 * at all (e.g. Order mode is active and switching there failed).
 */
export async function findDomActionWidget(page: Page, contractPrefix: string): Promise<DomActionWidget | null> {
  await ensureDomTab(page);

  const closePositionButton = page.locator('button[aria-label="Close Position"]');
  if ((await closePositionButton.count()) === 0) return null;

  const symbolLabel = closePositionButton.locator('xpath=preceding::span[contains(text(),":")][1]');
  const displayed = (await symbolLabel.textContent().catch(() => null))?.trim();
  if (!displayed || !matchesContractPrefix(displayed, contractPrefix)) {
    logger.warn({ contractPrefix, displayed }, "tradesea_dom_action_bar_wrong_symbol");
    return null;
  }

  return {
    symbolLabel,
    closePositionButton,
    cancelAllButton: page.locator('button[aria-label="Cancel All"]'),
  };
}

/** Sets the ticket's quantity and verifies the input actually holds the new value before returning. */
export async function setQuantity(widget: OrderWidget, quantity: number): Promise<void> {
  await widget.qtyInput.fill(String(quantity));
  await widget.qtyInput.press("Tab");

  const value = await widget.qtyInput.inputValue();
  if (Number(value) !== quantity) {
    throw new Error(`quantity did not take effect -- input reads "${value}", expected ${quantity}`);
  }
}

/** Selects Market or Limit order type (Stop is not used by this app). No-op-if-already-selected is not checked -- these are stateless toggle buttons, always safe to click again. */
export async function setOrderType(widget: OrderWidget, orderType: "market" | "limit"): Promise<void> {
  const button = orderType === "market" ? widget.marketButton : widget.limitButton;
  await button.click();
  // Selecting Limit reveals a new "Limit Price" input (absent for Market) --
  // wait for it so a subsequent setLimitPrice call doesn't race the ticket's
  // own re-render.
  if (orderType === "limit") {
    await widget.limitPriceInput.waitFor({ state: "visible", timeout: 5000 });
  }
}

/**
 * Fills the Limit Price field and verifies the input holds a value near what
 * was typed before returning. Only call after setOrderType(widget, "limit")
 * -- the field doesn't exist for Market orders. Tolerance mirrors
 * setStopLossPrice/setTakeProfitPrice.
 */
export async function setLimitPrice(widget: OrderWidget, price: Decimal, tickSize: Decimal): Promise<void> {
  await widget.limitPriceInput.fill(price.toString());
  await widget.limitPriceInput.press("Tab");

  const value = await widget.limitPriceInput.inputValue();
  const parsed = value ? new Decimal(value.replace(/,/g, "")) : null;
  if (parsed === null || parsed.minus(price).abs().gt(tickSize.dividedBy(2))) {
    throw new Error(`limit price did not take effect -- input reads "${value}", expected a price near ${price.toString()}`);
  }
}

/** Selects which side (Buy/Sell) the ticket is armed for -- does NOT submit; Confirm does. */
export async function selectSide(widget: OrderWidget, side: "buy" | "sell"): Promise<void> {
  const button = side === "buy" ? widget.buyButton : widget.sellButton;
  await button.click();
}

/**
 * Enables the Stop Loss section (if not already) and fills its Price field,
 * verifying the input holds the value before returning. Mirrors
 * browserControl/orderTicket.ts's setLimitPrice half-tick tolerance --
 * Tradesea's ticket may format/round the displayed value.
 */
export async function setStopLossPrice(widget: OrderWidget, price: Decimal, tickSize: Decimal): Promise<void> {
  const alreadyEnabled = (await widget.stopLossPriceInput.getAttribute("disabled")) === null;
  if (!alreadyEnabled) await widget.stopLossToggle.click();

  await widget.stopLossPriceInput.fill(price.toString());
  await widget.stopLossPriceInput.press("Tab");

  const value = await widget.stopLossPriceInput.inputValue();
  const parsed = value ? new Decimal(value.replace(/,/g, "")) : null;
  if (parsed === null || parsed.minus(price).abs().gt(tickSize.dividedBy(2))) {
    throw new Error(`stop loss price did not take effect -- input reads "${value}", expected a price near ${price.toString()}`);
  }
}

/** Same shape as setStopLossPrice, for the Take Profit section. */
export async function setTakeProfitPrice(widget: OrderWidget, price: Decimal, tickSize: Decimal): Promise<void> {
  const alreadyEnabled = (await widget.takeProfitPriceInput.getAttribute("disabled")) === null;
  if (!alreadyEnabled) await widget.takeProfitToggle.click();

  await widget.takeProfitPriceInput.fill(price.toString());
  await widget.takeProfitPriceInput.press("Tab");

  const value = await widget.takeProfitPriceInput.inputValue();
  const parsed = value ? new Decimal(value.replace(/,/g, "")) : null;
  if (parsed === null || parsed.minus(price).abs().gt(tickSize.dividedBy(2))) {
    throw new Error(`take profit price did not take effect -- input reads "${value}", expected a price near ${price.toString()}`);
  }
}

export interface SubmitResult {
  dryRun: boolean;
  buttonText: string;
}

/**
 * Clicks Confirm to submit the ticket as currently armed (side/qty/SL/TP all
 * already set by the calls above). Same dry-run highlight-instead-of-click
 * convention as browserControl/orderTicket.ts's submit().
 */
async function submit(button: Locator, dryRun: boolean, fallbackText: string): Promise<SubmitResult> {
  const buttonText = (await button.textContent()) || fallbackText;
  if (dryRun) {
    await button.evaluate((el) => {
      (el as HTMLElement).style.outline = "4px solid red";
      (el as HTMLElement).style.outlineOffset = "2px";
      el.scrollIntoView({ block: "center" });
    });
    return { dryRun: true, buttonText };
  }
  await button.click();
  return { dryRun: false, buttonText };
}

export function submitConfirm(widget: OrderWidget, dryRun: boolean): Promise<SubmitResult> {
  return submit(widget.confirmButton, dryRun, "Confirm");
}

/** One-click full close of whatever position is currently open on the DOM tab's displayed instrument -- no quantity needed, unlike flattenPosition's opposite-side-order approach. */
export function submitClosePosition(widget: DomActionWidget, dryRun: boolean): Promise<SubmitResult> {
  return submit(widget.closePositionButton, dryRun, "Close Position");
}

/** Cancels every resting order for the DOM tab's displayed instrument -- not a single order by ID (Tradesea's UI has no per-order cancel, only "Cancel All" for the whole symbol, same shape as TopstepX's cancelOrdersButton). */
export function submitCancelAll(widget: DomActionWidget, dryRun: boolean): Promise<SubmitResult> {
  return submit(widget.cancelAllButton, dryRun, "Cancel All");
}
