/**
 * Drives TopstepX's real order-entry widget over the same CDP connection
 * browserWatch/watcher.ts uses read-only -- this module actually clicks,
 * types, and submits. Selectors below were verified live against the real
 * account's DOM (data-testid attributes are stable; the qty/contract input
 * relationships were confirmed with `preceding::` XPath cross-checked
 * against the buy button's own displayed quantity).
 *
 * TopstepX's "Position Brackets" panel expresses stop-loss/take-profit as
 * approximate dollar amounts for the whole position ("Risk (~$)" /
 * "Profit (~$)"), auto-applied to the next order only if "Automatically
 * apply Risk / Profit bracket to new Positions" is checked -- confirmed live
 * that this checkbox was OFF by default, which would otherwise mean a Buy/
 * Sell click here opens a position with NO stop attached at all.
 */
import type { Locator, Page } from "playwright-core";
import { Decimal } from "decimal.js";
import { buildContractPattern } from "./pure.js";
import { childLogger } from "../core/logger.js";

const logger = childLogger("orderTicket");

export interface OrderWidget {
  buyButton: Locator;
  sellButton: Locator;
  closeButton: Locator;
  bracketSettingsButton: Locator;
  qtyInput: Locator;
  /** MUI Select showing "Market" | "Limit" | "Stop Market" | "Trailing Stop" (confirmed live 2026-07-20). Same order card the buy/sell buttons live in -- not a second widget. */
  orderTypeSelect: Locator;
  /** Only present/meaningful once orderTypeSelect reads "Limit" -- TopstepX doesn't render this field for Market orders. */
  limitPriceInput: Locator;
  /**
   * Only present/meaningful once orderTypeSelect reads "Trailing Stop" --
   * labeled "Trail Distance (Ticks)" on the real page (confirmed live
   * 2026-07-22, operator screenshot). Selector inferred from the same
   * `order-card-input-field-<name>` convention as limitPriceInput -- NOT
   * itself confirmed live yet, verify before the first real trailing-stop
   * order (see setTrailDistanceTicks).
   */
  trailDistanceInput: Locator;
  /** Cancels every resting order for this symbol (not a single order by ID -- the ticket has no per-order cancel, only "Cancel Orders" for the whole symbol). */
  cancelOrdersButton: Locator;
}

/**
 * Checks for any open modal dialog (TopstepX has multiple distinct ones seen
 * live -- "max-loss-modal-dialog" for Maximum Loss Limit, "dll-violation-
 * dialog-dialog" for Daily Loss Limit, and presumably others for different
 * violations) before attempting any interaction. A MUI modal by definition
 * blocks interaction with everything behind it, so this checks generically
 * for any visible `.MuiDialog-root` rather than an exhaustive, easily
 * incomplete list of specific testids -- without this, a click against a
 * covered element just retries silently for the full 30s timeout and
 * surfaces as an opaque Playwright error instead of the real reason.
 */
export async function findBlockingModalText(page: Page): Promise<string | null> {
  const modal = page.locator('.MuiDialog-root[role="presentation"]');
  const count = await modal.count();
  for (let i = 0; i < count; i++) {
    const candidate = modal.nth(i);
    if (await candidate.isVisible().catch(() => false)) {
      return (await candidate.textContent())?.trim().slice(0, 200) ?? "a blocking modal is open";
    }
  }
  return null;
}

function buildOrderWidget(page: Page, buyButton: Locator, index: number): OrderWidget {
  return {
    buyButton,
    sellButton: page.locator('[data-testid="order-card-click-button-sell"]').nth(index),
    closeButton: page.locator('[data-testid="order-card-click-button-close-position"]').nth(index),
    bracketSettingsButton: page.locator('[data-testid="oco-bracket-selector-click-button-settings"]').nth(index),
    qtyInput: buyButton.locator('xpath=preceding::input[@type="number"][1]'),
    orderTypeSelect: page.locator('[data-testid="order-card-input-select-order-type"] [role="combobox"]').nth(index),
    limitPriceInput: page.locator('[data-testid="order-card-input-field-limit-price"] input').nth(index),
    trailDistanceInput: page.locator('[data-testid="order-card-input-field-trail-distance"] input').nth(index),
    cancelOrdersButton: page.locator('[data-testid="order-card-click-button-cancel-orders"]').nth(index),
  };
}

/**
 * Finds the order-entry widget currently showing the given contract prefix
 * (e.g. "MNQ" matches a rendered contract code like "MNQU26"). There can be
 * more than one order-entry widget on the page (one per symbol the user has
 * added to their layout); this scans all of them and returns null if none
 * currently show the requested contract. Purely read-only -- never switches
 * anything (see findOrSwitchToOrderWidget below for the version that does).
 */
export async function findOrderWidget(page: Page, contractPrefix: string): Promise<OrderWidget | null> {
  const pattern = buildContractPattern(contractPrefix);
  const buyButtons = page.locator('[data-testid="order-card-click-button-buy"]');
  const count = await buyButtons.count();

  const seenContractTexts: string[] = [];
  for (let i = 0; i < count; i++) {
    const buyButton = buyButtons.nth(i);
    const contractText = await buyButton
      .locator('xpath=preceding::input[@type="text"][1]')
      .inputValue()
      .catch(() => "");
    seenContractTexts.push(contractText);
    if (!pattern.test(contractText)) continue;
    return buildOrderWidget(page, buyButton, i);
  }
  // Logged at warn (not just returned as null) so a widget-not-found failure
  // -- e.g. during a close-position call -- leaves behind what contract text
  // each order card actually showed, instead of just "not found" with no way
  // to tell whether TopstepX's DOM changed once a position was open.
  logger.warn({ contractPrefix, buyButtonCount: count, seenContractTexts }, "order_widget_not_found");
  return null;
}

/**
 * Switches an order-entry widget's own contract selector (a searchable MUI
 * Autocomplete, data-testid "contract-selector-input-select-contract" --
 * confirmed live 2026-07-21) to the given prefix, e.g. from "MNQU26" to
 * "MESU26". No-ops if it's already showing the right contract.
 */
export async function switchContract(page: Page, contractInput: Locator, contractPrefix: string): Promise<void> {
  const current = await contractInput.inputValue();
  if (current.toUpperCase().startsWith(contractPrefix.toUpperCase())) return;

  await contractInput.click();
  await contractInput.fill(contractPrefix);
  const option = page.getByRole("option", { name: new RegExp(`^${contractPrefix}`, "i") });
  await option
    .first()
    .waitFor({ state: "visible", timeout: 5000 })
    .catch(() => {
      throw new Error(`no contract option matching "${contractPrefix}" appeared after searching for it`);
    });
  await option.first().click();

  const updated = await contractInput.inputValue();
  if (!updated.toUpperCase().startsWith(contractPrefix.toUpperCase())) {
    throw new Error(`contract switch to "${contractPrefix}" did not take effect -- input still reads "${updated}"`);
  }
}

/**
 * Same as findOrderWidget, but if no existing widget already shows the
 * right contract, actively switches the first available widget to it
 * instead of failing -- this account's real layout (confirmed live
 * 2026-07-21) has only ONE order-entry widget total, shared across every
 * symbol Tera Trade trades, not one pinned widget per symbol as originally
 * assumed. Only used by write paths (placeOrder, close/cancel) -- never by
 * isPositionFlat or other read-only checks, which must stay side-effect-free
 * (switching a widget's contract as a side effect of a status check could
 * yank it out from under an order that's mid-flight on a different symbol).
 * Tried switching isPositionFlat too (2026-07-22) to fix missed trailing-
 * stop closes, but the shared ticket visibly flipping symbols on every tick
 * wasn't an acceptable UX tradeoff -- reverted; see getPositionsPanelSymbols
 * for the actual fix (reads the dedicated Positions panel instead, no
 * widget/contract switching involved at all).
 */
export async function findOrSwitchToOrderWidget(page: Page, contractPrefix: string): Promise<OrderWidget | null> {
  const existing = await findOrderWidget(page, contractPrefix);
  if (existing) return existing;

  const buyButtons = page.locator('[data-testid="order-card-click-button-buy"]');
  if ((await buyButtons.count()) === 0) return null;

  const buyButton = buyButtons.first();
  const contractInput = buyButton.locator('xpath=preceding::input[@type="text"][1]');
  try {
    await switchContract(page, contractInput, contractPrefix);
  } catch (err) {
    logger.warn({ contractPrefix, err: String(err) }, "contract_switch_failed");
    return null;
  }
  return buildOrderWidget(page, buyButton, 0);
}

/**
 * Read-only check for whether the order-entry widget for `contractPrefix`
 * currently shows "No Active Position" -- TopstepX's own literal text for a
 * flat position, confirmed live (2026-07-15). Returns null (not false) when
 * this can't be determined confidently -- the widget wasn't found, or its
 * text couldn't be read -- so callers never mistake "couldn't check" for
 * "confirmed flat." Scoped to the same order card as the widget's own
 * close-position button (a stable, semantically-meaningful ancestor) rather
 * than a fixed DOM depth, since exact markup levels aren't guaranteed stable.
 * Superseded by getPositionsPanelSymbols for managing already-open trades
 * (2026-07-22) -- still used as-is for the fill-confirmation check right
 * after placing a new order, where the widget is already on the right
 * contract and no switching is needed.
 */
export async function isPositionFlat(page: Page, contractPrefix: string): Promise<boolean | null> {
  const widget = await findOrderWidget(page, contractPrefix);
  if (!widget) return null;

  const cardText = await widget.buyButton
    .locator("xpath=ancestor::div[.//*[@data-testid='order-card-click-button-close-position']][1]")
    .textContent()
    .catch(() => null);
  if (cardText === null) return null;
  return cardText.includes("No Active Position");
}

/** Sets the order ticket's quantity and verifies the buy button's own displayed quantity actually changed before returning. */
export async function setQuantity(widget: OrderWidget, quantity: number): Promise<void> {
  await widget.qtyInput.fill(String(quantity));
  await widget.qtyInput.press("Tab");

  const buyText = await widget.buyButton.textContent();
  if (!buyText || !buyText.includes(String(quantity))) {
    throw new Error(`quantity did not take effect -- buy button reads "${buyText}", expected it to reference ${quantity}`);
  }
}

const ORDER_TYPE_LABEL: Record<"market" | "limit" | "trailingStop", string> = {
  market: "Market",
  limit: "Limit",
  trailingStop: "Trailing Stop",
};

/**
 * Selects the order ticket's order type. Stop Market exists in the dropdown
 * but nothing here drives it yet -- only Market/Limit/Trailing Stop
 * (v1.3, see setTrailDistanceTicks) are used. No-ops if already on the
 * requested type, to avoid an unnecessary reopen-and-reselect on every call.
 */
export async function setOrderType(widget: OrderWidget, orderType: "market" | "limit" | "trailingStop"): Promise<void> {
  const label = ORDER_TYPE_LABEL[orderType];
  const currentText = (await widget.orderTypeSelect.textContent())?.trim();
  if (currentText === label) return;

  await widget.orderTypeSelect.click();
  const option = widget.orderTypeSelect.page().getByRole("option", { name: label, exact: true });
  await option.waitFor({ state: "visible", timeout: 5000 });
  await option.click();

  const confirmedText = (await widget.orderTypeSelect.textContent())?.trim();
  if (confirmedText !== label) {
    throw new Error(`order type did not change to "${label}" -- reads "${confirmedText}"`);
  }
}

/**
 * Fills the limit price and verifies the buy/sell buttons' own displayed
 * price actually updated before returning -- same "trust the button, not
 * the input" verification shape as setQuantity. Only call after
 * setOrderType(widget, "limit"); the field doesn't exist for Market orders.
 * Price comparison is numeric with a half-tick tolerance rather than exact
 * string equality, since the button can format/round the price differently
 * than what was typed (e.g. trailing zeros).
 */
export async function setLimitPrice(widget: OrderWidget, price: Decimal, tickSize: Decimal): Promise<void> {
  await widget.limitPriceInput.fill(price.toString());
  await widget.limitPriceInput.press("Tab");

  const buyText = await widget.buyButton.textContent();
  const match = buyText?.match(/@\s*([\d,]+\.?\d*)/);
  const buttonPrice = match ? new Decimal(match[1]!.replace(/,/g, "")) : null;
  if (buttonPrice === null || buttonPrice.minus(price).abs().gt(tickSize.dividedBy(2))) {
    throw new Error(`limit price did not take effect -- buy button reads "${buyText}", expected a price near ${price.toString()}`);
  }
}

/**
 * Fills the trailing-stop distance (in ticks) and verifies by reading the
 * input's own value back -- unlike setLimitPrice, a Trailing Stop order's
 * buy/sell button just reads "BUY +N TRAILING STOP" with no price/distance
 * in it, so there's no button-text cross-check available here. Only call
 * after setOrderType(widget, "trailingStop"); the field doesn't exist for
 * Market/Limit orders.
 */
export async function setTrailDistanceTicks(widget: OrderWidget, ticks: number): Promise<void> {
  await widget.trailDistanceInput.fill(String(ticks));
  await widget.trailDistanceInput.press("Tab");

  const value = await widget.trailDistanceInput.inputValue();
  if (Number(value) !== ticks) {
    throw new Error(`trail distance did not take effect -- input reads "${value}", expected ${ticks}`);
  }
}

/**
 * Opens the bracket settings popover, ensures auto-apply-to-new-positions is
 * on, fills the $ risk/profit amounts, and closes it. Runs in full even
 * during a dry run -- this is account configuration, not order submission,
 * and the user watching the screen should see the real values populate to
 * confirm the automation is computing them correctly.
 */
export async function configureBracket(page: Page, widget: OrderWidget, riskDollars: number, profitDollars: number | null): Promise<void> {
  await widget.bracketSettingsButton.click();

  const riskInput = page.locator('input[name="risk"]');
  await riskInput.waitFor({ state: "visible", timeout: 5000 });

  // Stable data-testid (confirmed live), NOT `input[type="checkbox"].first()`
  // on the whole page -- that untargeted lookup previously let a real order
  // go out with the auto-apply toggle never actually confirmed checked, with
  // no real bracket attached to the position at all.
  const autoApplyCheckbox = page.locator('[data-testid="auto-oco-brackets-toggle-switch-auto-apply"] input[type="checkbox"]');
  await autoApplyCheckbox.check(); // no-op if already checked -- never blindly toggles

  await riskInput.fill(String(riskDollars));
  await riskInput.press("Tab");

  if (profitDollars !== null) {
    const profitInput = page.locator('input[name="toMake"]');
    await profitInput.fill(String(profitDollars));
    await profitInput.press("Tab");
  }

  // Hard verification before closing the popover -- if the checkbox didn't
  // actually end up checked, or the typed values didn't take, refuse rather
  // than silently submit an order with no real bracket attached.
  if (!(await autoApplyCheckbox.isChecked())) {
    throw new Error("bracket auto-apply checkbox did not end up checked -- refusing to submit an order that would have no stop/target attached");
  }
  const riskValue = await riskInput.inputValue();
  if (riskValue !== String(riskDollars)) {
    throw new Error(`bracket risk input reads "${riskValue}" after fill, expected "${riskDollars}" -- refusing to submit`);
  }
  if (profitDollars !== null) {
    const profitValue = await page.locator('input[name="toMake"]').inputValue();
    if (profitValue !== String(profitDollars)) {
      throw new Error(`bracket profit input reads "${profitValue}" after fill, expected "${profitDollars}" -- refusing to submit`);
    }
  }

  // Checking the box (or editing risk/profit) turns this popover's button
  // row from "Close" into "Cancel"/"Save Changes" -- clicking "Close" here
  // (2026-07-20 incident, found live by the operator from two real
  // unprotected positions in one night) discards the edit instead of
  // persisting it, while every check above still reads back "correct"
  // because it's reading the popover's own live input state, not whether
  // anything actually got saved to the account. Only fall back to the plain
  // "Close" click when nothing was actually dirtied (e.g. an identical
  // risk/profit + already-checked box from a prior order), in which case
  // there's nothing to save and no Save Changes button will even be showing.
  const saveButton = page.locator("button", { hasText: /^Save Changes$/ });
  if ((await saveButton.count()) > 0) {
    await saveButton.first().click();
    // Confirmed live (2026-07-21): Save Changes persists the settings but
    // does NOT itself dismiss the popover -- its own button row reverts from
    // Cancel/Save Changes back to Close once there's nothing left unsaved.
    // The first version of this fix wrongly assumed Save Changes also
    // closed the dialog and waited for that instead, which timed out on the
    // very first real order and left the popover open, blocking every
    // subsequent order for ~13 minutes as a false "blocking modal" reading
    // (see findBlockingModalText). Close still has to be clicked explicitly.
    const closeButton = page.locator("button", { hasText: /^Close$/ }).last();
    await closeButton.waitFor({ state: "visible", timeout: 5000 }).catch(() => {
      throw new Error("bracket popover's Close button did not reappear after clicking Save Changes -- refusing to submit, bracket state unconfirmed");
    });
    await closeButton.click();
  } else {
    await page.locator("button", { hasText: /^Close$/ }).last().click();
  }

  // Final check against the exact failure mode that just happened live --
  // a bracket popover left open (for any reason) is a `.MuiDialog-root` that
  // findBlockingModalText would then read as a blocking modal on every
  // subsequent order attempt for any symbol, not just this one.
  const stillOpen = await page.locator('.MuiDialog-root[role="presentation"]').first().isVisible().catch(() => false);
  if (stillOpen) {
    throw new Error("bracket popover is still open after clicking Close -- refusing to submit, bracket state unconfirmed");
  }
}

export interface SubmitResult {
  dryRun: boolean;
  buttonText: string;
}

async function submit(button: Locator, dryRun: boolean): Promise<SubmitResult> {
  const buttonText = (await button.textContent()) ?? "";
  if (dryRun) {
    // Highlight instead of clicking, so the intended action is visible on the
    // real screen without ever submitting anything.
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

export function submitBuy(widget: OrderWidget, dryRun: boolean): Promise<SubmitResult> {
  return submit(widget.buyButton, dryRun);
}
export function submitSell(widget: OrderWidget, dryRun: boolean): Promise<SubmitResult> {
  return submit(widget.sellButton, dryRun);
}
export function submitClosePosition(widget: OrderWidget, dryRun: boolean): Promise<SubmitResult> {
  return submit(widget.closeButton, dryRun);
}
/** Cancels every resting order for this symbol -- see OrderWidget.cancelOrdersButton's comment on why this isn't per-order. */
export function submitCancelOrders(widget: OrderWidget, dryRun: boolean): Promise<SubmitResult> {
  return submit(widget.cancelOrdersButton, dryRun);
}
