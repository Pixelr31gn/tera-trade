/**
 * Read-only TopstepX API reads, run INSIDE the attached TopstepX tab with the
 * session token the web app already keeps in localStorage -- the token never
 * leaves the page. Used where reading the rendered DOM proved unreliable
 * (2026-10-06: the Positions-panel fill read failed on every live entry, so
 * every stop/target was anchored to a stale theoretical price instead).
 */
import type { Page } from "playwright-core";

export interface ApiOpenPosition {
  contractId: string;
  side: "long" | "short";
  size: number;
  averagePrice: number;
}

// Passed to page.evaluate as source text, not a function: tsx/esbuild wrap
// named functions in a `__name(...)` helper that doesn't exist in the page,
// which made a function-form evaluate throw (and read as "unknown") every time.
const OPEN_POSITION_SCRIPT = `(async (prefix) => {
  const token = Object.keys(localStorage)
    .map((k) => (localStorage.getItem(k) || "").replace(/"/g, ""))
    .find((v) => v.startsWith("eyJ"));
  if (!token) return null;
  const post = async (path, body) => {
    const res = await fetch("https://api.topstepx.com/api/" + path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify(body),
    });
    return res.ok ? res.json() : null;
  };
  // The account selected in the TopstepX UI -- where the order ticket's
  // clicks actually go. The web app keeps it under "activeAccount:<env>".
  // 2026-10-06: picking the first canTrade account instead read a different
  // account than the one being traded (four are tradable), saw it flat, and
  // refused every take-profit/trailing stop for the real positions.
  const activeKey = Object.keys(localStorage).find((k) => k.startsWith("activeAccount"));
  const activeId = activeKey ? Number((localStorage.getItem(activeKey) || "").replace(/"/g, "")) : NaN;
  if (!Number.isFinite(activeId)) return null;
  const accounts = await post("Account/search", { onlyActiveAccounts: true });
  const account = accounts && accounts.accounts && accounts.accounts.find((a) => a.id === activeId);
  if (!account) return null;
  const positions = await post("Position/searchOpen", { accountId: account.id });
  if (!positions || !positions.success) return null;
  const match = positions.positions.find((p) => p.contractId.includes("." + prefix + "."));
  if (!match) return "flat";
  return { contractId: match.contractId, side: match.type === 1 ? "long" : "short", size: match.size, averagePrice: match.averagePrice };
})`;

/**
 * The tradable account's open position for a broker contract prefix (e.g.
 * "MES"), or `"flat"` when it has none. Null means the API couldn't be read --
 * callers must treat that as "unknown", never as flat.
 */
export async function readApiOpenPosition(page: Page, contractPrefix: string): Promise<ApiOpenPosition | "flat" | null> {
  try {
    const result = await page.evaluate(`${OPEN_POSITION_SCRIPT}(${JSON.stringify(contractPrefix)})`);
    return result as ApiOpenPosition | "flat" | null;
  } catch {
    return null;
  }
}
