/**
 * Bollinger Band mean-reversion: fade a close outside the bands back to the mean.
 *
 * Best suited to ranging regimes -- the scoring engine's trendAlignment
 * factor naturally penalizes this strategy's signals when the regime is
 * strongly trending, since a reversion trade against a strong trend is
 * exactly the "fights the trend" case.
 */
import { Decimal } from "decimal.js";
import type { OhlcBar } from "../regime/indicators.js";
import type { Signal, Strategy } from "./types.js";

const PERIOD = 20;
const NUM_STD = 2.0;

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export class MeanReversionStrategy implements Strategy {
  strategyId = "mean_reversion_bollinger_20";

  generateSignal(symbol: string, bars: OhlcBar[]): Signal | null {
    if (bars.length < PERIOD + 1) return null;

    const closes = bars.slice(-PERIOD).map((b) => b.close);
    const sma = mean(closes);
    const std = Math.sqrt(mean(closes.map((c) => (c - sma) ** 2)));
    if (!std) return null;

    const upper = sma + NUM_STD * std;
    const lower = sma - NUM_STD * std;
    const last = bars[bars.length - 1]!;

    if (last.close < lower) {
      return {
        strategyId: this.strategyId,
        symbol,
        side: "long",
        structureSwingPrice: new Decimal(last.low),
        reason: `close ${last.close} is below the lower Bollinger Band (${lower.toFixed(2)}), reversion toward ${sma.toFixed(2)} expected`,
      };
    }
    if (last.close > upper) {
      return {
        strategyId: this.strategyId,
        symbol,
        side: "short",
        structureSwingPrice: new Decimal(last.high),
        reason: `close ${last.close} is above the upper Bollinger Band (${upper.toFixed(2)}), reversion toward ${sma.toFixed(2)} expected`,
      };
    }
    return null;
  }
}
