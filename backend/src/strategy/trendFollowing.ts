/** EMA(9/21) crossover trend-following entry. */
import { Decimal } from "decimal.js";
import type { OhlcBar } from "../regime/indicators.js";
import type { Signal, Strategy } from "./types.js";

const FAST = 9;
const SLOW = 21;
const SWING_LOOKBACK = 10;

function ema(values: number[], span: number): number[] {
  const alpha = 2 / (span + 1);
  const out: number[] = [values[0]!];
  for (let i = 1; i < values.length; i++) {
    out.push(alpha * values[i]! + (1 - alpha) * out[i - 1]!);
  }
  return out;
}

export class TrendFollowingStrategy implements Strategy {
  strategyId = "trend_following_ema_9_21";

  generateSignal(symbol: string, bars: OhlcBar[]): Signal | null {
    if (bars.length < SLOW + 2) return null;

    const closes = bars.map((b) => b.close);
    const fastEma = ema(closes, FAST);
    const slowEma = ema(closes, SLOW);

    const prevDiff = fastEma[fastEma.length - 2]! - slowEma[slowEma.length - 2]!;
    const currDiff = fastEma[fastEma.length - 1]! - slowEma[slowEma.length - 1]!;

    const swingWindow = bars.slice(-(SWING_LOOKBACK + 1), -1);

    if (prevDiff <= 0 && currDiff > 0) {
      return {
        strategyId: this.strategyId,
        symbol,
        side: "long",
        structureSwingPrice: new Decimal(Math.min(...swingWindow.map((b) => b.low))),
        reason: `${FAST}-EMA crossed above the ${SLOW}-EMA, signaling a new up-trend`,
      };
    }
    if (prevDiff >= 0 && currDiff < 0) {
      return {
        strategyId: this.strategyId,
        symbol,
        side: "short",
        structureSwingPrice: new Decimal(Math.max(...swingWindow.map((b) => b.high))),
        reason: `${FAST}-EMA crossed below the ${SLOW}-EMA, signaling a new down-trend`,
      };
    }
    return null;
  }
}
