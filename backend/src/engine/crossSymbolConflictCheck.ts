/**
 * ES/NQ cross-symbol conflict check (2026-09-01, operator request: "ES and
 * NQ should never enter into conflicting trades") -- see
 * marketData/instruments.ts's CONFLICTING_PARTNER_SYMBOL for why this pair
 * specifically, and risk/engine.ts's hasConflictingCrossSymbolPosition param
 * for where the result actually blocks a trade.
 *
 * Shared by every live call site that assesses a new trade outside the
 * decideOnBar/DecisionContext path (engine/loop.ts's Tradesea reassessment
 * and scanSymbolContinuously) -- the one call site that DOES go through
 * decideOnBar uses replay/liveDecisionContext.ts's hasConflictingPosition
 * instead, which wraps this same function so live behaves identically either
 * way.
 */
import { prisma } from "../db/client.js";
import { getConflictingPartnerSymbol } from "../marketData/instruments.js";

/**
 * Is there an open position, across `accountIds`, on `symbol`'s correlated
 * partner (ES<->NQ) whose side is OPPOSITE `side`? False for any symbol with
 * no defined partner, when nothing is open on the partner, or when the
 * partner's open position shares the same side (both long, or both short --
 * correlated exposure in the same direction, not a conflict).
 */
export async function hasConflictingCrossSymbolPosition(accountIds: number[], symbol: string, side: "long" | "short"): Promise<boolean> {
  const partnerSymbol = getConflictingPartnerSymbol(symbol);
  if (!partnerSymbol) return false;
  const oppositeSide = side === "long" ? "short" : "long";
  const conflicting = await prisma.trade.findFirst({
    where: { accountId: { in: accountIds }, symbol: partnerSymbol, side: oppositeSide, status: "open" },
    select: { id: true },
  });
  return conflicting !== null;
}
