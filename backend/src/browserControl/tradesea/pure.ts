/**
 * Pure, unit-testable pieces of Tradesea's order-placement flow
 * (brokers/tradeseaBrowserControlBroker.ts). Mirrors browserControl/pure.ts's
 * role for TopstepX -- everything that actually touches the page lives in
 * orderTicket.ts/positionsPanel.ts instead, since a real Playwright Page
 * can't be meaningfully unit tested.
 */

/**
 * Matches Tradesea's displayed instrument symbol against a contract prefix,
 * e.g. "MNQ" matches "CME:MNQ". Unlike TopstepX (which renders a dated CME
 * contract code like "MNQU26", requiring a month-code regex -- see
 * browserControl/pure.ts's buildContractPattern), Tradesea's UI shows the
 * continuous symbol directly with no expiry suffix (confirmed live,
 * 2026-08-26) -- an exact match on the root after stripping any "EXCHANGE:"
 * prefix is sufficient, no regex needed.
 */
export function matchesContractPrefix(displayedSymbol: string, contractPrefix: string): boolean {
  const root = displayedSymbol.split(":").pop() ?? displayedSymbol;
  return root.trim().toUpperCase() === contractPrefix.trim().toUpperCase();
}
