export interface SystemState {
  mode: "analysis_only" | "paper" | "live";
  kill_switch: boolean;
  kill_switch_reason: string | null;
  broker_kind: string;
  min_score_threshold: number;
  updated_at: string;
}

export interface RiskLimits {
  per_trade_risk_pct: number;
  max_daily_loss_pct: number;
  max_trailing_drawdown_pct: number;
  max_position_size: number;
  max_consecutive_losses: number;
  max_daily_trades: number;
}

export interface AccountSummary {
  id: number;
  name: string;
  starting_balance: number;
  risk_limits: RiskLimits;
}

export interface EquityPoint {
  time: string;
  equity: number;
  balance: number;
}

export interface RecommendationScore {
  time: string;
  symbol: string;
  strategy_id: string;
  side: string;
  probability: number;
  decision: string;
  explanation: string;
  trade_id: number | null;
}

export interface Position {
  trade_id: number;
  symbol: string;
  side: string;
  quantity: number;
  entry_price: number;
  stop_price: number;
  take_profit_price: number | null;
  entry_time: string;
  strategy_id: string;
  score: number | null;
  explanation: string;
}

export interface Trade {
  id: number;
  symbol: string;
  strategy_id: string;
  side: string;
  quantity: number;
  entry_time: string;
  entry_price: number;
  exit_time: string | null;
  exit_price: number | null;
  exit_reason: string | null;
  pnl: number | null;
  mae: number | null;
  mfe: number | null;
  score: number | null;
  regime_trend_at_entry: string | null;
  regime_vol_at_entry: string | null;
  status: string;
  explanation: string;
}

export interface RegimeInfo {
  time: string;
  trend_label: string;
  vol_label: string;
  confidence: number;
  features: Record<string, number | null>;
}

export interface NewsEventItem {
  time: string;
  country: string;
  name: string;
  impact: string;
  forecast: string | null;
  previous: string | null;
}

export interface NewsRiskStatus {
  in_risk_window: boolean;
  nearest_event_name: string | null;
  nearest_event_time: string | null;
  minutes_to_event: number | null;
  impact: string | null;
}

export interface PerformanceSummary {
  trade_stats: {
    trade_count: number;
    win_rate: number;
    expected_value: number;
    profit_factor: number | null;
    avg_win: number;
    avg_loss: number;
    avg_mae: number | null;
    avg_mfe: number | null;
    largest_win: number;
    largest_loss: number;
  };
  portfolio_stats: {
    sharpe: number | null;
    sortino: number | null;
    max_drawdown_pct: number;
    max_drawdown_duration_days: number;
    volatility_annualized: number | null;
    cagr: number | null;
  };
  by_strategy: Record<string, { trade_count: number; total_pnl: number; win_rate: number }>;
  by_regime: Record<string, { trade_count: number; total_pnl: number; win_rate: number }>;
}
