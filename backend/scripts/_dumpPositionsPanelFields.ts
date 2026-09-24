/**
 * READ-ONLY diagnostic: dumps every data-field key and its text for each row of
 * TopstepX's Positions panel, plus the column headers.
 *
 * Why: browserControl/positionsPanel.ts's readOpenPositionFillPrice tries
 * FILL_PRICE_FIELD_CANDIDATES = ["entryPrice", "avgPrice"] and has never once
 * matched -- every real entry since logging was added shows
 * real_fill_price_unavailable with lastDeviationPoints: null, i.e. nothing was
 * read at all. The table and the row ARE found (isPositionFlatViaPanel works
 * off the same locators), so the only unknown is the actual field key for the
 * price cell. This prints it rather than guessing a third candidate.
 *
 * Touches nothing: locator reads and textContent only, no clicks, no typing,
 * no navigation. Same posture as browserWatch's own extraction.
 */
import { connectToChrome, findPage } from "../src/browserWatch/cdpClient.js";
import { getSettings } from "../src/core/config.js";

async function main(): Promise<void> {
  const settings = getSettings();
  const browser = await connectToChrome(settings.browserCdpUrl);
  const page = await findPage(browser, settings.browserUrlMatch);
  if (!page) {
    console.error(`No Chrome tab matching "${settings.browserUrlMatch}"`);
    process.exit(1);
  }

  const table = page.locator('[data-testid="positions-display-table"]');
  const tableCount = await table.count();
  console.log(`positions-display-table found: ${tableCount}`);
  if (tableCount === 0) {
    console.error("panel not in the layout -- nothing to dump");
    process.exit(1);
  }

  // Column headers, to correlate visible labels with field keys.
  const headers = await table.locator('[role="columnheader"]').evaluateAll((els) =>
    els.map((el) => ({ field: el.getAttribute("data-field"), label: (el.textContent ?? "").trim() }))
  );
  console.log("\n--- column headers (data-field -> visible label) ---");
  for (const h of headers) console.log(`  ${String(h.field).padEnd(28)} ${h.label}`);

  const rows = table.locator('[role="row"][data-id]');
  const rowCount = await rows.count();
  console.log(`\n--- ${rowCount} open position row(s) ---`);

  for (let i = 0; i < rowCount; i++) {
    const cells = await rows
      .nth(i)
      .locator("[data-field]")
      .evaluateAll((els) => els.map((el) => ({ field: el.getAttribute("data-field"), text: (el.textContent ?? "").trim() })));
    console.log(`\nrow ${i}:`);
    for (const c of cells) console.log(`  ${String(c.field).padEnd(28)} ${JSON.stringify(c.text)}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
