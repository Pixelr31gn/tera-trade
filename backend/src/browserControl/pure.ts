/**
 * Pure, unit-testable pieces of the browser-driven order placement flow
 * (browserControlBroker.ts). Everything that actually touches the page lives
 * there instead, since a real Playwright Page can't be meaningfully unit
 * tested -- these are the parts worth verifying in isolation.
 */
import type { Decimal } from "decimal.js";

// CME futures month codes: one letter per month (F=Jan ... Z=Dec).
const FUTURES_MONTH_CODES = "FGHJKMNQUVXZ";

/** Matches TopstepX's rendered contract code for a given prefix, e.g. "MNQ" -> /^MNQ[FGHJ...]\d{2}$/i matching "MNQU26". */
export function buildContractPattern(prefix: string): RegExp {
  return new RegExp(`^${prefix}[${FUTURES_MONTH_CODES}]\\d{2}$`, "i");
}

export interface BracketDollarAmounts {
  riskDollars: number;
  profitDollars: number | null;
}

/**
 * TopstepX's "Position Brackets" panel takes the stop-loss/take-profit as
 * approximate dollar amounts for the whole position (labeled "Risk (~$)" /
 * "Profit (~$)"), not tick offsets or absolute prices -- this converts our
 * absolute stopPrice/takeProfitPrice into the dollar figures to type in.
 * Rounds to the nearest dollar since the UI field is an approximate ("~$") amount.
 */
export function computeBracketDollars(
  entryPrice: Decimal,
  stopPrice: Decimal,
  takeProfitPrice: Decimal | null,
  quantity: number,
  pointValue: Decimal
): BracketDollarAmounts {
  const riskDollars = Math.round(entryPrice.minus(stopPrice).abs().times(pointValue).times(quantity).toNumber());
  const profitDollars = takeProfitPrice ? Math.round(takeProfitPrice.minus(entryPrice).abs().times(pointValue).times(quantity).toNumber()) : null;
  return { riskDollars: Math.max(1, riskDollars), profitDollars: profitDollars !== null ? Math.max(1, profitDollars) : null };
}
