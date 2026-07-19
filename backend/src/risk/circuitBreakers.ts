/**
 * Hard risk circuit breakers, independent of any strategy signal.
 *
 * These checks run before every new trade and can also flip the global kill
 * switch (system_state.kill_switch), which blocks *all* new entries
 * account-wide until an operator clears it. They mirror the account rules
 * Topstep itself enforces (daily loss limit, trailing max drawdown) so Terra
 * Trade never lets a strategy dig the account into a hole the prop firm
 * would already have failed on.
 */
import { Decimal } from "decimal.js";
import { getSettings } from "../core/config.js";

export interface AccountRiskState {
  currentEquity: Decimal;
  peakEquity: Decimal;
  dailyStartingEquity: Decimal;
  consecutiveLosses: number;
  tradesToday: number;
}

export interface RiskLimitsConfig {
  perTradeRiskPct: Decimal;
  maxDailyLossPct: Decimal;
  maxTrailingDrawdownPct: Decimal;
  maxConsecutiveLosses: number;
  maxDailyTrades: number;
  maxPositionSize: number;
  /** Fixed-dollar overrides -- when set, perTradeRiskDollars/perTradeProfitDollars take priority over the percentage fields (see risk/engine.ts). */
  perTradeRiskDollars?: Decimal | null;
  perTradeProfitDollars?: Decimal | null;
  maxDailyLossDollars?: Decimal | null;
}

export interface CircuitBreakerDecision {
  allowed: boolean;
  tripKillSwitch: boolean;
  reason: string | null;
}

export function checkCircuitBreakers(state: AccountRiskState, limits: RiskLimitsConfig): CircuitBreakerDecision {
  // KILL_SWITCH_ENABLED=false (set for now, during paper testing) skips both
  // auto-trip checks below entirely -- daily-loss and trailing-drawdown no
  // longer block or pause anything. The softer per-check pauses further down
  // (consecutive losses, max daily trades) are untouched; only the kill
  // switch itself is disabled. Must be re-enabled before ever going live --
  // see KILL_SWITCH_ENABLED's comment in core/config.ts.
  if (getSettings().killSwitchEnabled) {
    const dailyLossDollars = state.dailyStartingEquity.minus(state.currentEquity);

    // Fixed-dollar daily loss cap, checked first when configured -- an absolute
    // limit that doesn't drift with equity the way the percentage check does.
    if (limits.maxDailyLossDollars != null && dailyLossDollars.gte(limits.maxDailyLossDollars)) {
      return {
        allowed: false,
        tripKillSwitch: true,
        reason: `daily loss of $${dailyLossDollars.toFixed(2)} has reached the $${limits.maxDailyLossDollars} daily loss limit`,
      };
    }

    const dailyLossPct = state.dailyStartingEquity.gt(0) ? dailyLossDollars.dividedBy(state.dailyStartingEquity).times(100) : new Decimal(0);

    if (dailyLossPct.gte(limits.maxDailyLossPct)) {
      return {
        allowed: false,
        tripKillSwitch: true,
        reason: `daily loss of ${dailyLossPct.toFixed(2)}% has reached the ${limits.maxDailyLossPct}% daily loss limit`,
      };
    }

    const trailingDdPct = state.peakEquity.gt(0)
      ? state.peakEquity.minus(state.currentEquity).dividedBy(state.peakEquity).times(100)
      : new Decimal(0);

    if (trailingDdPct.gte(limits.maxTrailingDrawdownPct)) {
      return {
        allowed: false,
        tripKillSwitch: true,
        reason: `trailing drawdown of ${trailingDdPct.toFixed(2)}% has reached the ${limits.maxTrailingDrawdownPct}% trailing drawdown limit`,
      };
    }
  }

  if (state.consecutiveLosses >= limits.maxConsecutiveLosses) {
    return {
      allowed: false,
      tripKillSwitch: false,
      reason: `${state.consecutiveLosses} consecutive losses have reached the max-consecutive-losses limit of ${limits.maxConsecutiveLosses}; pausing new entries`,
    };
  }

  if (state.tradesToday >= limits.maxDailyTrades) {
    return {
      allowed: false,
      tripKillSwitch: false,
      reason: `${state.tradesToday} trades taken today have reached the max-daily-trades limit of ${limits.maxDailyTrades}`,
    };
  }

  return { allowed: true, tripKillSwitch: false, reason: null };
}
