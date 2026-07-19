/** Donchian-channel breakout: close beyond the prior N-bar high/low. */
import { Decimal } from "decimal.js";
import type { OhlcBar } from "../regime/indicators.js";
import type { Signal, Strategy } from "./types.js";

const LOOKBACK = 20;

export class BreakoutStrategy implements Strategy {
  strategyId = "breakout_donchian_20";

  generateSignal(symbol: string, bars: OhlcBar[]): Signal | null {
    if (bars.length < LOOKBACK + 1) return null;

    const window = bars.slice(-(LOOKBACK + 1), -1); // prior N bars, excluding current
    const priorHigh = Math.max(...window.map((b) => b.high));
    const priorLow = Math.min(...window.map((b) => b.low));
    const last = bars[bars.length - 1]!;

    if (last.close > priorHigh) {
      return {
        strategyId: this.strategyId,
        symbol,
        side: "long",
        structureSwingPrice: new Decimal(priorLow),
        signalKind: "breakout",
        breakoutLevelPrice: new Decimal(priorHigh),
        reason: `close ${last.close} broke above the prior ${LOOKBACK}-bar high of ${priorHigh}`,
      };
    }
    if (last.close < priorLow) {
      return {
        strategyId: this.strategyId,
        symbol,
        side: "short",
        structureSwingPrice: new Decimal(priorHigh),
        signalKind: "breakout",
        breakoutLevelPrice: new Decimal(priorLow),
        reason: `close ${last.close} broke below the prior ${LOOKBACK}-bar low of ${priorLow}`,
      };
    }
    return null;
  }
}
