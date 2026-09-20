export interface ConfidenceTier {
  threshold: number;
  quantity: number;
}

export interface SystemState {
  /** Per-instrument executable toggle -- every symbol in ACTIVE_INSTRUMENTS, with whether it's currently allowed to open new trades. Doesn't affect an already-open position on the symbol. */
  tradableSymbols: { symbol: string; enabled: boolean }[];
  mode: "analysis_only" | "paper" | "live";
  killSwitch: boolean;
  killSwitchReason: string | null;
  brokerKind: string;
  liveBrokerConnected: boolean;
  tradesea: {
    enabled: boolean;
    liveEnabled: boolean;
    liveBrokerConnected: boolean;
  };
  /** The AI assistant's own independent gates -- see execution/mode.ts's setAssistantActionsEnabled. `enabled` reflects static env config (ASSISTANT_ENABLED); `actionsEnabled` reflects the runtime DB toggle that gates its real-money write-tools. */
  assistant: {
    enabled: boolean;
    actionsEnabled: boolean;
  };
  minScoreThreshold: number;
  activeStrategyVersion: "v1" | "v2" | "v3" | "v4" | "v5" | "v6" | "v7";
  /** Shared across every strategy/scoring version -- see risk/stops.ts's computeInitialStop. */
  takeProfitRMultiple: number;
  /** Exactly 3, ascending by threshold -- see risk/sizing.ts's computeConfidenceTierQuantity. */
  confidenceTiers: ConfidenceTier[];
  updatedAt: string;
}

export interface RiskLimits {
  perTradeRiskPct: number;
  maxDailyLossPct: number;
  maxTrailingDrawdownPct: number;
  maxPositionSize: number;
  maxConsecutiveLosses: number;
  maxDailyTrades: number;
  perTradeRiskDollars: number | null;
  perTradeProfitDollars: number | null;
  maxDailyLossDollars: number | null;
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

export interface EquityAccountOption {
  id: number;
  name: string;
  brokerAccountId: string | null;
  isCurrentlyActive: boolean;
  startingBalance: number;
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
  strategyVersion: "v1" | "v2" | "v3" | "v4" | "v5" | "v6" | "v7";
  entryPrice: number;
  stopPrice: number;
  takeProfitPrice: number;
  quantity: number;
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
  strategyVersion: "v1" | "v2" | "v3" | "v4" | "v5" | "v6" | "v7";
  entryPrice: number;
  stopPrice: number;
  takeProfitPrice: number;
  quantity: number;
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
  trailingStopPlaced: boolean;
  /** Whether a real broker-side take-profit LIMIT order is resting for this position yet (see engine/loop.ts's activateTakeProfitOrder) -- false means the target is only enforced by this app's own price-tick polling. */
  takeProfitOrderPlaced: boolean;
  letItRide: boolean;
  /** Which broker this position is actually open on -- e.g. "browser_control" (TopstepX), "tradesea_browser_control", "simulated". Matters now that positions from more than one live broker can appear in the same list. */
  brokerKind: string;
}

export interface Trade {
  id: number;
  symbol: string;
  strategyId: string;
  side: string;
  quantity: number;
  entryTime: string;
  entryPrice: number;
  stopPrice: number;
  takeProfitPrice: number | null;
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
  /** Blended across every scored setup (taken + skipped) -- converges across scoring versions almost regardless of judgment quality. See takenWinRate. */
  winRate: number | null;
  avgRMultiple: number | null;
  /** How many setups this version's own decision was "taken" on. */
  takenCount: number;
  takenResolvedCount: number;
  /** Win rate restricted to this version's own decision === "taken" rows -- the metric that actually differs between versions. */
  takenWinRate: number | null;
  takenAvgRMultiple: number | null;
  modelTrained: boolean;
  minRowsRequiredForModel: number;
  byMarketStructure: Record<string, SessionLabelBreakdown>;
  byLiquidity: Record<string, SessionLabelBreakdown>;
  byPriceAction: Record<string, SessionLabelBreakdown>;
}

export type StrategyComparison = Record<"v1" | "v2" | "v3" | "v4" | "v5" | "v6" | "v7", Record<string, SessionPerformance>>;

/** GET /api/dealer-levels -- see backend/src/analytics/dealerGex.ts. One entry per symbol (ES, NQ), always the most recently computed levels regardless of which session computed them. */
export interface DealerLevels {
  time: string;
  session: "new_york" | "london" | "asian";
  spotPrice: string;
  callWall: string | null;
  putWall: string | null;
  gammaFlip: string | null;
  callWallConfirmedByPriceAction: boolean;
  putWallConfirmedByPriceAction: boolean;
}

export type DealerLevelsBySymbol = Record<string, DealerLevels>;

export interface DivergenceBucket {
  n: number;
  win: number;
  loss: number;
  pending: number;
  winRate: number | null;
}

export type VersionDivergence = Record<string, { onlyATook: DivergenceBucket; onlyBTook: DivergenceBucket; agreedPairs: number }>;

export interface MaStack {
  maFast: number | null;
  maMid: number | null;
  maSlow: number | null;
  direction: "up" | "down" | "mixed";
}

export interface FibLevel {
  ratio: number;
  label: string;
  price: number;
}

export interface MarketSnapshot {
  symbol: string;
  tickSize: string;
  pointValue: string;
  lastPrice: string | null;
  lastPriceTime: string | null;
  trendLabel: string | null;
  volLabel: string | null;
  regimeConfidence: string | null;
  session: string;
  maStack: MaStack;
  swingHigh: number | null;
  swingLow: number | null;
  swingDirection: "up" | "down" | null;
  fibLevels: FibLevel[];
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
  // Keyed by strategyId, then by symbol -- "all" is the blended-across-symbols total (see
  // backend/src/api/routes/performance.ts's own comment on why this is nested now).
  byStrategy: Record<string, Record<string, { tradeCount: number; totalPnl: number; winRate: number }>>;
  byRegime: Record<string, { tradeCount: number; totalPnl: number; winRate: number }>;
}

export interface StrategyStatus {
  strategyId: string;
  fireCount: number;
  lastFiredAt: string | null;
  takenCount: number;
}

export interface PpmSnapshot {
  symbol: string;
  windowMinutes: number;
  upPointsPerMinute: number;
  downPointsPerMinute: number;
  netPointsPerMinute: number;
  sampleCount: number;
}

/** One raw Gemini content part -- see backend/src/assistant/client.ts. A message's `content` is an array of these; most messages carry exactly one, but a multi-tool-call turn carries several. */
export interface AssistantContentPart {
  text?: string;
  functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name?: string; response?: { output?: string; error?: string } };
  thoughtSignature?: string;
}

export interface AssistantMessage {
  id: number;
  role: "user" | "assistant";
  content: AssistantContentPart[];
  createdAt: string;
}

/** Audit row for a real write-tool call -- see backend/src/assistant/tools.ts's withAssistantAudit. Written on every write-tool call regardless of outcome. */
export interface AssistantAction {
  id: number;
  toolName: string;
  input: unknown;
  status: "success" | "error";
  resultSummary: string;
  rawResult: unknown;
  errorMessage: string | null;
  tradeId: number | null;
  messageId: number | null;
  createdAt: string;
}

/** GET /api/daily-plan -- see backend/src/api/routes/dailyPlan.ts. */
export interface DailyPlanSymbolView {
  support: { priceLow: number; priceHigh: number; label: string } | null;
  resistance: { priceLow: number; priceHigh: number; label: string } | null;
  takeProfitLikelyMovePoints: number | null;
  takeProfitCapPoints: number | null;
  takeProfitLabel: string | null;
  currentPrice: number | null;
  status: "no_plan" | "below_support" | "testing_support" | "mid_range" | "testing_resistance" | "above_resistance";
}

/** GET /api/scout/pitches -- see backend/src/api/routes/scout.ts. */
export interface ScoutPitch {
  id: number;
  title: string;
  problem: string;
  proposedAgent: string;
  toolsNeeded: unknown;
  costEstimate: string;
  frequencyEstimate: string;
  category: string;
  occurrenceCount: number;
  status: string;
  score: number;
  rating: number | null;
  ratingNote: string | null;
  ratedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ScoutPitchesResponse {
  pitches: ScoutPitch[];
  taylorApprovalMinRating: number;
}

/** GET /api/taylor/blueprints -- see backend/src/api/routes/taylor.ts. */
export interface TailorBlueprint {
  pitchId: number;
  pitchTitle: string;
  pitchRatingAtGeneration: number;
  createdAt: string;
}
