/**
 * Points this PC's TopstepX order ticket at a contract and STOPS -- no order
 * type change, no quantity change, never touches Buy/Sell/Close. The state the
 * broker reaches right before it would place a trade on that contract.
 *
 *   npx tsx --env-file=.env scripts/prepareTicket.ts MES
 *   npx tsx --env-file=.env scripts/prepareTicket.ts MNQ
 *
 * Why it exists: multi-account mirroring needs every account's ticket to be
 * able to reach the new contract (e.g. MNQ -> MES). This proves that, per PC,
 * without placing anything. Changing the ticket's contract is the same UI step
 * orderTicket.findOrSwitchToOrderWidget performs before every real order.
 */
import { connectToChrome, findPage } from "../src/browserWatch/cdpClient.js";
import { findBlockingModalText, findOrSwitchToOrderWidget } from "../src/browserControl/orderTicket.js";
import { getSettings } from "../src/core/config.js";

async function main(): Promise<void> {
  const prefix = (process.argv[2] ?? "MES").toUpperCase();
  const settings = getSettings();

  const browser = await connectToChrome(settings.browserCdpUrl);
  const page = await findPage(browser, settings.browserUrlMatch);
  if (!page) {
    console.error(`FAIL: no Chrome tab matching "${settings.browserUrlMatch}" at ${settings.browserCdpUrl}`);
    process.exit(1);
  }

  const modal = await findBlockingModalText(page);
  if (modal) {
    console.error(`FAIL: TopstepX is showing a blocking modal: "${modal}"`);
    process.exit(1);
  }

  const widget = await findOrSwitchToOrderWidget(page, prefix);
  if (!widget) {
    console.error(`FAIL: could not point the order ticket at ${prefix} (no widget, or the contract switch failed)`);
    process.exit(1);
  }

  const contract = await widget.buyButton.locator('xpath=preceding::input[@type="text"][1]').inputValue().catch(() => "?");
  const qty = await widget.qtyInput.inputValue().catch(() => "?");
  const buyText = (await widget.buyButton.textContent().catch(() => ""))?.trim();
  const sellText = (await widget.sellButton.textContent().catch(() => ""))?.trim();
  console.log(`OK: ticket is on ${contract}  |  qty field: ${qty}  |  buttons: "${buyText}" / "${sellText}"  |  nothing clicked`);
  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
