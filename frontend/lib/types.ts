export interface SystemState {
  mode: "analysis_only" | "paper" | "live";
  killSwitch: boolean;
  killSwitchReason: string | null;
  brokerKind: string;
  minScoreThreshold: number;
  updatedAt: string;
}

export interface RiskLimits {
  perTradeRiskPct: number;
  maxDailyLossPct: number;
  maxTrailingDrawdownPct: number;
  maxPositionSize: number;
  maxConsecutiveLosses: number;
  maxDailyTrades: number;
}

export interface AccountSummary {
  id: number;
  name: string;
  startingBalance: number;
  riskLimits: RiskLimits;
}

export interface EquityPoint {
  time: string;
  equity: number;
  balance: number;
}

export interface RecommendationScore {
  id: number;
  time: string;
  symbol: string;
  strategyId: string;
  side: string;
  probability: number;
  decision: string;
  explanation: string;
  tradeId: number | null;
}

export interface ActionableRecommendation {
  id: number;
  time: string;
  symbol: string;
  strategyId: string;
  side: string;
  probability: number;
  explanation: string;
  actionability: "fresh" | "stale";
}

export interface Position {
  tradeId: number;
  symbol: string;
  side: string;
  quantity: number;
  entryPrice: number;
  stopPrice: number;
  takeProfitPrice: number | null;
  entryTime: string;
  strategyId: string;
  score: number | null;
  explanation: string;
}

export interface Trade {
  id: number;
  symbol: string;
  strategyId: string;
  side: string;
  quantity: number;
  entryTime: string;
  entryPrice: number;
  exitTime: string | null;
  exitPrice: number | null;
  exitReason: string | null;
  pnl: number | null;
  mae: number | null;
  mfe: number | null;
  score: number | null;
  regimeTrendAtEntry: string | null;
  regimeVolAtEntry: string | null;
  status: string;
  explanation: string;
}

export interface RegimeInfo {
  time: string;
  trendLabel: string;
  volLabel: string;
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
  inRiskWindow: boolean;
  nearestEventName: string | null;
  nearestEventTime: string | null;
  minutesToEvent: number | null;
  impact: string | null;
}

export interface OpeningRangeStats {
  symbol: string;
  sessionsAnalyzed: number;
  probHighBroken: number | null;
  probLowBroken: number | null;
  probBothBroken: number | null;
  probNeitherBroken: number | null;
}

export interface SessionLabelBreakdown {
  sampleSize: number;
  resolvedCount: number;
  winRate: number | null;
  avgRMultiple: number | null;
}

export interface SessionPerformance {
  session: "new_york" | "london" | "asian";
  totalScores: number;
  outcomeCounts: Record<string, number>;
  resolvedCount: number;
  winRate: number | null;
  avgRMultiple: number | null;
  modelTrained: boolean;
  minRowsRequiredForModel: number;
  byMarketStructure: Record<string, SessionLabelBreakdown>;
  byLiquidity: Record<string, SessionLabelBreakdown>;
  byPriceAction: Record<string, SessionLabelBreakdown>;
}

export interface PerformanceSummary {
  tradeStats: {
    tradeCount: number;
    winRate: number;
    expectedValue: number;
    profitFactor: number | null;
    avgWin: number;
    avgLoss: number;
    avgMae: number | null;
    avgMfe: number | null;
    largestWin: number;
    largestLoss: number;
  };
  portfolioStats: {
    sharpe: number | null;
    sortino: number | null;
    maxDrawdownPct: number;
    maxDrawdownDurationDays: number;
    volatilityAnnualized: number | null;
    cagr: number | null;
  };
  byStrategy: Record<string, { tradeCount: number; totalPnl: number; winRate: number }>;
  byRegime: Record<string, { tradeCount: number; totalPnl: number; winRate: number }>;
}
