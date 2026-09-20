/**
 * Reads TopstepX's own "Trade History" panel (a MUI DataGrid, same family as
 * positionsPanel.ts's Positions panel) -- the real, broker-confirmed record
 * of every closed trade, including its actual fill prices and real
 * commissions/fees. Confirmed live 2026-08-31 (`data-testid=
 * "performance-trades-display-table"`, rows carry `data-id` and per-column
 * `data-field` cells -- captured verbatim against a real closed trade:
 * `{id: "3046950479", contractName: "MNQU26", positionSize: "10",
 * entryTime: "2026-08-31 12:29:44.951", exitedAt: "2026-08-31 12:32:26.101",
 * entryPrice: "29,438.25", exitPrice: "29,435.75", pnL: "$50.00",
 * commissions: "$-5.00", fees: "$-7.20", direction: "Short"}`).
 *
 * This exists because neither entry nor exit prices this app records for a
 * live BrowserControlBroker trade are guaranteed real: entry falls back to
 * the pre-trade theoretical/decision price whenever positionsPanel.ts's own
 * real-fill read fails (confirmed live the same day -- a genuine trade's
 * entry was recorded 12.5 points off from its real fill for exactly this
 * reason), and exit is *never* a confirmed fill at all (engine/loop.ts's
 * closeTrade always writes its own pre-computed stop/target level, tagged
 * "[ESTIMATE]" in the explanation, since until this file there was no way to
 * read a real exit fill back at all). This panel is the one place both
 * numbers are ever genuinely confirmed, after the fact.
 */
import type { Page } from "playwright-core";
import { Decimal } from "decimal.js";
import { parseMoney } from "../browserWatch/extract.js";
import { childLogger } from "../core/logger.js";
import type { ClosedTradeHistoryEntry } from "../brokers/types.js";

const logger = childLogger("tradeHistoryPanel");

const TRADE_HISTORY_TABLE_TESTID = "performance-trades-display-table";

/** Timestamps render in whatever timezone the browser's own machine is set to (confirmed live by correlating this panel's entryTime against this app's own local-time order_clicked log, same machine) -- parsed via the local-timezone Date constructor, not a hardcoded offset, so this stays correct across a DST change without needing to be revisited. */
function parseLocalTimestamp(raw: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{1,3})$/.exec(raw.trim());
  if (!match) return null;
  const [, y, mo, d, hh, mi, ss, ms] = match;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mi), Number(ss), Number(ms!.padEnd(3, "0")));
}

/**
 * Parses one raw {data-field: cell text} row into a typed entry, or null if
 * any required field is missing or doesn't parse -- never guesses a partial
 * row into existence, same "fail closed" posture as every other extractor in
 * this codebase (see browserWatch/extract.ts's header comment).
 */
export function parseClosedTradeRow(raw: Record<string, string>): ClosedTradeHistoryEntry | null {
  const brokerTradeId = raw.id?.trim();
  const contractCode = raw.contractName?.trim().toUpperCase();
  const quantity = raw.positionSize ? Number(raw.positionSize.replace(/,/g, "")) : NaN;
  const entryTime = raw.entryTime ? parseLocalTimestamp(raw.entryTime) : null;
  const exitTime = raw.exitedAt ? parseLocalTimestamp(raw.exitedAt) : null;
  const entryPrice = raw.entryPrice ? parseMoney(raw.entryPrice) : null;
  const exitPrice = raw.exitPrice ? parseMoney(raw.exitPrice) : null;
  const grossPnl = raw.pnL ? parseMoney(raw.pnL) : null;
  const commissions = raw.commissions ? parseMoney(raw.commissions) : null;
  const fees = raw.fees ? parseMoney(raw.fees) : null;
  const sideRaw = raw.direction?.trim().toLowerCase();
  const side = sideRaw === "long" ? "long" : sideRaw === "short" ? "short" : null;

  if (
    !brokerTradeId ||
    !contractCode ||
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    !entryTime ||
    !exitTime ||
    entryPrice === null ||
    exitPrice === null ||
    grossPnl === null ||
    commissions === null ||
    fees === null ||
    side === null
  ) {
    return null;
  }

  const totalDeductions = new Decimal(commissions).plus(fees);
  return {
    brokerTradeId,
    contractCode,
    quantity,
    side,
    entryTime,
    exitTime,
    entryPrice: new Decimal(entryPrice),
    exitPrice: new Decimal(exitPrice),
    grossPnl: new Decimal(grossPnl),
    totalDeductions,
    netPnl: new Decimal(grossPnl).plus(totalDeductions),
  };
}

/**
 * Reads up to `limit` raw rows from the Trade History grid, most recent
 * first (TopstepX's own default sort). Returns null only when the panel
 * itself can't be found/read at all (operator's layout doesn't have it, a
 * DOM change, etc.) -- callers must treat null as "unknown," never as "no
 * closed trades," same convention as positionsPanel.ts.
 */
export async function readClosedTradeHistoryRows(page: Page, limit = 15): Promise<Record<string, string>[] | null> {
  const table = page.locator(`[data-testid="${TRADE_HISTORY_TABLE_TESTID}"]`);
  if ((await table.count()) === 0) {
    logger.warn("trade_history_panel_not_found");
    return null;
  }

  try {
    return await page.evaluate(
      ({ testId, rowLimit }) => {
        const el = document.querySelector(`[data-testid="${testId}"]`);
        if (!el) return [];
        const rowEls = Array.from(el.querySelectorAll('[role="row"][data-id]')).slice(0, rowLimit);
        return rowEls.map((rowEl) => {
          const cells = Array.from(rowEl.querySelectorAll("[data-field]"));
          const row: Record<string, string> = {};
          for (const cell of cells) {
            const field = cell.getAttribute("data-field");
            if (field) row[field] = (cell.textContent ?? "").trim();
          }
          return row;
        });
      },
      { testId: TRADE_HISTORY_TABLE_TESTID, rowLimit: limit }
    );
  } catch (err) {
    logger.warn({ err: String(err) }, "trade_history_panel_read_failed");
    return null;
  }
}

/** Reads and parses the grid in one call, filtered to rows whose contract starts with `contractPrefix` (e.g. "MNQ" matches "MNQU26") -- rows that fail to parse are silently dropped, not surfaced as an error, same "fail closed" posture as parseClosedTradeRow. */
export async function readClosedTradeHistoryForContract(page: Page, contractPrefix: string, limit = 15): Promise<ClosedTradeHistoryEntry[] | null> {
  const rawRows = await readClosedTradeHistoryRows(page, limit);
  if (rawRows === null) return null;
  const prefix = contractPrefix.toUpperCase();
  return rawRows.map(parseClosedTradeRow).filter((entry): entry is ClosedTradeHistoryEntry => entry !== null && entry.contractCode.startsWith(prefix));
}

// Generous relative to the confirmation-latency spikes already observed live
// (order-to-confirmation gaps past a minute during heavy page contention --
// see this file's header comment) -- wide enough to still catch a genuinely
// slow confirmation, tight enough that it won't cross into a different,
// unrelated trade on the same contract minutes later.
const MATCH_TOLERANCE_MS = 3 * 60 * 1000;

/**
 * Finds the closed-trade-history entry that's really this Trade's own real
 * fill, matched on side + quantity + closest entryTime (never on price --
 * price is exactly what this is meant to correct). Returns null when
 * nothing plausible is within MATCH_TOLERANCE_MS; never guesses a distant or
 * wrong-quantity row into a match.
 *
 * `excludeBrokerTradeIds` (2026-09-03, operator report: "the pn&l is not
 * correct... you should be basing the pn&l based off the id that gets made
 * per trade") -- without this, two of OUR OWN trades close enough together
 * (same side/quantity, both within MATCH_TOLERANCE_MS of the same real fill
 * -- exactly what the known TOCTOU duplicate-entry race produces, see
 * engine/loop.ts's manageOpenTrades) can both match the SAME real TopstepX
 * closed-trade row, double-attributing one real fill's entry/exit/pnl to two
 * different Trade rows. Confirmed live: trades #234 and #236, both NQ long
 * entry 29496.75 ~3 minutes apart, both ended up with brokerOrderId
 * "3063210748" and the identical -$18.60. Once a broker trade ID has been
 * claimed by one of our trades, it can never be matched again.
 */
export function findMatchingClosedTrade(
  trade: { side: string; quantity: number; entryTime: Date },
  entries: ClosedTradeHistoryEntry[],
  excludeBrokerTradeIds: ReadonlySet<string> = new Set()
): ClosedTradeHistoryEntry | null {
  let best: ClosedTradeHistoryEntry | null = null;
  let bestDeltaMs = Infinity;
  for (const entry of entries) {
    if (excludeBrokerTradeIds.has(entry.brokerTradeId)) continue;
    if (entry.side !== trade.side || entry.quantity !== trade.quantity) continue;
    const deltaMs = Math.abs(entry.entryTime.getTime() - trade.entryTime.getTime());
    if (deltaMs > MATCH_TOLERANCE_MS) continue;
    if (deltaMs < bestDeltaMs) {
      bestDeltaMs = deltaMs;
      best = entry;
    }
  }
  return best;
}
