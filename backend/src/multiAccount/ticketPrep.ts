/**
 * Points THIS PC's TopstepX order ticket at a contract and stops -- never
 * changes order type or quantity, never touches Buy/Sell/Close. This is the
 * same UI step orderTicket.findOrSwitchToOrderWidget performs before every real
 * order, exposed on its own so an operator can put every account's ticket on a
 * new contract (e.g. MNQ -> MES) before any trade, on the controller and, via
 * the executor's /prepare endpoint, on every remote PC.
 *
 * Operator-initiated only. Do not call while an order is in flight: the ticket
 * is shared, and switching its contract mid-order is the exact interleaving
 * behind the 2026-10-06 wrong-symbol incident (see browserControlBroker.ts).
 */
import { findBlockingModalText, findOrSwitchToOrderWidget } from "../browserControl/orderTicket.js";
import { connectToChrome, findPage } from "../browserWatch/cdpClient.js";
import { getSettings } from "../core/config.js";

export interface PrepareResult {
  ok: boolean;
  /** Contract text the ticket shows afterwards, e.g. "MESZ26". */
  contract?: string;
  /** Quantity box as shown (Topstep remembers one per contract). */
  quantity?: string;
  error?: string;
}

export async function prepareTicket(contractPrefix: string): Promise<PrepareResult> {
  try {
    const settings = getSettings();
    const browser = await connectToChrome(settings.browserCdpUrl);
    const page = await findPage(browser, settings.browserUrlMatch);
    if (!page) return { ok: false, error: `no Chrome tab matching "${settings.browserUrlMatch}" at ${settings.browserCdpUrl}` };

    const modal = await findBlockingModalText(page);
    if (modal) return { ok: false, error: `TopstepX is showing a blocking modal: "${modal}"` };

    const widget = await findOrSwitchToOrderWidget(page, contractPrefix);
    if (!widget) return { ok: false, error: `could not point the order ticket at ${contractPrefix} (no widget, or the contract switch failed)` };

    const contract = await widget.buyButton.locator('xpath=preceding::input[@type="text"][1]').inputValue().catch(() => "?");
    const quantity = await widget.qtyInput.inputValue().catch(() => "?");
    return { ok: true, contract, quantity };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
