/**
 * Fills missing minutes in bars_1m from TopstepX's own 1-minute history
 * (2026-11-11, operator request: "why do we just backfill using topstep's
 * chart, it has all that data"). Inserts only minutes that aren't already
 * stored (skipDuplicates) -- existing bars, including the live aggregator's,
 * are never changed.
 *
 *   npx tsx --env-file=.env scripts/backfillFromTopstep.ts            # last 48h, all active symbols
 *   npx tsx --env-file=.env scripts/backfillFromTopstep.ts 72 --dry   # 72h, count only
 *
 * Why: the backend only builds bars while it runs, so downtime leaves holes
 * (2026-11-09 23:50 -> 2026-11-11 14:16 UTC left the 5m/60m EMAs mostly on
 * Monday's prices). Yahoo's backfill only has 5-minute bars and a different
 * data source; this is the same feed the account trades.
 *
 * Read-only against TopstepX: runs History/retrieveBars inside the attached,
 * logged-in tab with the session token the web app already holds (same
 * pattern as src/browserControl/topstepApi.ts -- the token never leaves the
 * page). Clicks nothing. Uses the micro contract (MES/MNQ/MGC), whose prices
 * are the same as the full-size symbol stored here.
 */
import { connectToChrome, findPage } from "../src/browserWatch/cdpClient.js";
import { getSettings } from "../src/core/config.js";
import { prisma } from "../src/db/client.js";
import { ACTIVE_INSTRUMENTS } from "../src/marketData/instruments.js";

const FETCH_SCRIPT = `(async ({ prefix, startTime, endTime }) => {
  const token = Object.keys(localStorage).map((k) => (localStorage.getItem(k) || "").replace(/"/g, "")).find((v) => v.startsWith("eyJ"));
  if (!token) return { error: "no TopstepX session token in the tab" };
  const post = async (path, body) => {
    const r = await fetch("https://api.topstepx.com/api/" + path, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify(body) });
    return r.ok ? r.json() : { error: path + " HTTP " + r.status };
  };
  const found = await post("Contract/search", { searchText: prefix, live: false });
  const contracts = (found.contracts || []).filter((c) => c.id.includes("." + prefix + "."));
  const contract = contracts.find((c) => c.activeContract) || contracts[0];
  if (!contract) return { error: "no " + prefix + " contract found" };
  const res = await post("History/retrieveBars", { contractId: contract.id, live: false, startTime, endTime, unit: 2, unitNumber: 1, limit: 20000, includePartialBar: false });
  if (!res.bars) return { error: res.error || res.errorMessage || "no bars returned" };
  return { contractId: contract.id, bars: res.bars.map((b) => [b.t, b.o, b.h, b.l, b.c, b.v]) };
})`;

async function main(): Promise<void> {
  const hours = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 48);
  const dryRun = process.argv.includes("--dry");
  const settings = getSettings();
  const browser = await connectToChrome(settings.browserCdpUrl);
  const page = await findPage(browser, settings.browserUrlMatch);
  if (!page) throw new Error("No logged-in TopstepX tab found");

  const end = new Date();
  // The last minute is still forming -- leave it to the live aggregator.
  end.setUTCSeconds(0, 0);
  const start = new Date(end.getTime() - hours * 3_600_000);

  for (const spec of ACTIVE_INSTRUMENTS) {
    const arg = { prefix: spec.brokerContractPrefix, startTime: start.toISOString(), endTime: end.toISOString() };
    const res = (await page.evaluate(`${FETCH_SCRIPT}(${JSON.stringify(arg)})`)) as
      { error?: string; contractId?: string; bars?: Array<[string, number, number, number, number, number]> };
    if (res.error || !res.bars) {
      console.log(`${spec.symbol}: ${res.error}`);
      continue;
    }
    const rows = res.bars
      .map(([t, o, h, l, c, v]) => ({ time: new Date(t), symbol: spec.symbol, open: String(o), high: String(h), low: String(l), close: String(c), volume: String(v) }))
      .filter((r) => r.time < end);
    const existing = await prisma.bar.count({ where: { symbol: spec.symbol, time: { gte: start, lt: end } } });
    if (dryRun) {
      console.log(`${spec.symbol} (${res.contractId}): TopstepX has ${rows.length} bars, ${existing} already stored`);
      continue;
    }
    const inserted = await prisma.bar.createMany({ data: rows, skipDuplicates: true });
    console.log(`${spec.symbol} (${res.contractId}): TopstepX has ${rows.length} bars, ${existing} already stored, inserted ${inserted.count}`);
  }
  await prisma.$disconnect();
  // Don't browser.close(): over CDP that would close the operator's Chrome.
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
