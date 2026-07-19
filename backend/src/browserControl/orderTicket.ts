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
import { buildContractPattern } from "./pure.js";
import { childLogger } from "../core/logger.js";

const logger = childLogger("orderTicket");

export interface OrderWidget {
  buyButton: Locator;
  sellButton: Locator;
  closeButton: Locator;
  bracketSettingsButton: Locator;
  qtyInput: Locator;
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

/**
 * Finds the order-entry widget currently showing the given contract prefix
 * (e.g. "MNQ" matches a rendered contract code like "MNQU26"). There can be
 * more than one order-entry widget on the page (one per symbol the user has
 * added to their layout); this scans all of them and returns null if none
 * currently show the requested contract.
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

    return {
      buyButton,
      sellButton: page.locator('[data-testid="order-card-click-button-sell"]').nth(i),
      closeButton: page.locator('[data-testid="order-card-click-button-close-position"]').nth(i),
      bracketSettingsButton: page.locator('[data-testid="oco-bracket-selector-click-button-settings"]').nth(i),
      qtyInput: buyButton.locator('xpath=preceding::input[@type="number"][1]'),
    };
  }
  // Logged at warn (not just returned as null) so a widget-not-found failure
  // -- e.g. during a close-position call -- leaves behind what contract text
  // each order card actually showed, instead of just "not found" with no way
  // to tell whether TopstepX's DOM changed once a position was open.
  logger.warn({ contractPrefix, buyButtonCount: count, seenContractTexts }, "order_widget_not_found");
  return null;
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

  await page.locator("button", { hasText: /^Close$/ }).last().click();
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
