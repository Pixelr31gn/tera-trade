/**
 * Every tool the assistant can call. Read tools are always available once
 * ASSISTANT_ENABLED=true; write tools are only ever included in the request
 * sent to Gemini when the independent assistantActionsEnabled gate is
 * open (see getAvailableTools) -- the model is never even offered a tool it
 * isn't allowed to call, not just relied on to decline it. Every write tool
 * additionally re-checks that same gate inline via withAssistantAudit as
 * defense in depth, since a multi-tool-call turn executes synchronously
 * after the gate was checked once at request-build time.
 *
 * Read tools call the exact same exported functions their HTTP GET routes
 * call (see the api/routes/*.ts files this imports from) -- no
 * reimplemented queries. Write tools call the exact same exported functions
 * their HTTP POST/PATCH routes call.
 */
import type { FunctionDeclaration } from "@google/genai";
import { prisma } from "../db/client.js";
import { getSettings, TradingMode } from "../core/config.js";
// Deliberately NOT imported here: setAssistantActionsEnabled. The assistant
// must never be able to flip its own actions-enabled gate back on -- that's
// the one action reserved for the operator alone (see execution/mode.ts's
// own header comment on that function).
import {
  clearKillSwitch,
  getSystemState,
  ModeChangeError,
  setConfidenceTiers,
  setMode,
  setTakeProfitRMultiple,
  setTradeseaLiveEnabled,
  type ConfidenceTierInput,
} from "../execution/mode.js";
import { manager } from "../api/wsManager.js";
import { placeManualOrder, type ManualTradeInput } from "../api/routes/trades.js";
import { closeOpenPosition, enableLetItRide } from "../api/routes/positions.js";
import { updateRiskLimits, type RiskLimitsUpdateBody } from "../api/routes/accounts.js";
import { getOpenPositions, getOpenOrders } from "../api/routes/positions.js";
import { getTrades } from "../api/routes/trades.js";
import { getRecommendations, getActionableRecommendations } from "../api/routes/scores.js";
import { getAccountsList, getEquityCurve } from "../api/routes/accounts.js";
import { getPerformanceSummary } from "../api/routes/performance.js";
import { getCurrentRegime } from "../api/routes/regime.js";
import { getUpcomingNews } from "../api/routes/news.js";
import { getNewsRiskStatus } from "../news/risk.js";
import { getMarketSnapshot, getSupportResistanceSnapshot } from "../api/routes/market.js";
import { getDealerLevelsSnapshot, getDealerLevelsReportSnapshot } from "../api/routes/dealerLevels.js";
import { getOpeningRangeStats } from "../engine/openingRangeCache.js";
import { DEFAULT_INSTRUMENTS } from "../marketData/instruments.js";
import { cached, computeSessionPerformanceForAllSessions, computeStrategyComparison, computeVersionDivergence, computeStrategyStatus } from "../api/routes/analytics.js";
import { getSystemStateSnapshot } from "../api/routes/system.js";
import { listActiveDailyPlanZones, setDailyPlanZones, clearDailyPlanZones, type DailyPlanZoneInput } from "../engine/dailyPlanZoneCache.js";
import { setDailyPlanTakeProfitTarget } from "../engine/dailyPlanTakeProfitCache.js";
import { resolveDailyPlanAt } from "../engine/dailyPlanSessionOverride.js";
import { listDisabledStrategies, disableStrategy, enableStrategy } from "../engine/strategyEnablementCache.js";
import { listDisabledStrategySymbols, disableStrategySymbol, enableStrategySymbol } from "../engine/strategySymbolEnablementCache.js";
import { childLogger } from "../core/logger.js";

const logger = childLogger("assistantTools");

// ---------------------------------------------------------------------------
// Output shaping -- every read tool's result is hard-capped regardless of
// what the individual query returns, so one unexpectedly large table (e.g.
// get_trades with a high limit) can't blow the model's context on its own.
// ---------------------------------------------------------------------------
const MAX_RESULT_CHARS = 8000;

function toModelText(value: unknown): string {
  const json = JSON.stringify(value, null, 2) ?? "null";
  if (json.length <= MAX_RESULT_CHARS) return json;
  return `${json.slice(0, MAX_RESULT_CHARS)}\n... [truncated -- ${json.length} total chars, ${json.length - MAX_RESULT_CHARS} cut]`;
}

/** JSON round-trip so Decimal/Date instances become plain strings before hitting a Prisma Json column. */
function toPlainJson(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

export interface ToolExecutionResult {
  content: string;
  isError: boolean;
}

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

type ReadToolHandler = (input: Record<string, unknown>) => Promise<unknown>;

const READ_TOOLS: { tool: FunctionDeclaration; handler: ReadToolHandler }[] = [
  {
    tool: {
      name: "get_system_state",
      description: "Current trading mode, kill switch, Tradesea status, assistant-actions gate, active strategy version, take-profit R multiple, and confidence tiers.",
      parametersJsonSchema: { type: "object", properties: {} },
    },
    handler: async () => getSystemStateSnapshot(),
  },
  {
    tool: {
      name: "get_positions",
      description: "Every currently open position across all connected accounts (TopstepX and, if configured, Tradesea).",
      parametersJsonSchema: { type: "object", properties: {} },
    },
    handler: async () => getOpenPositions(),
  },
  {
    tool: {
      name: "get_orders",
      description: "The most recent 100 order records across all connected accounts.",
      parametersJsonSchema: { type: "object", properties: {} },
    },
    handler: async () => getOpenOrders(),
  },
  {
    tool: {
      name: "get_trades",
      description: "Historical trades, optionally filtered by status (\"open\"/\"closed\"), symbol, or accountId (defaults to the primary account).",
      parametersJsonSchema: {
        type: "object",
        properties: {
          status: { type: "string", description: "\"open\" or \"closed\"" },
          symbol: { type: "string" },
          accountId: { type: "number" },
          limit: { type: "number", description: "Max rows, capped at 50 for this tool regardless of what's requested." },
        },
      },
    },
    handler: async (input) =>
      getTrades({
        status: typeof input.status === "string" ? input.status : undefined,
        symbol: typeof input.symbol === "string" ? input.symbol : undefined,
        accountId: typeof input.accountId === "number" ? input.accountId : undefined,
        limit: Math.min(typeof input.limit === "number" ? input.limit : 50, 50),
      }),
  },
  {
    tool: {
      name: "get_recommendations",
      description: "Recent scored setups (taken and skipped, every strategy version) with their hypothetical trade plan.",
      parametersJsonSchema: { type: "object", properties: { limit: { type: "number", description: "Capped at 50." } } },
    },
    handler: async (input) => getRecommendations(Math.min(typeof input.limit === "number" ? input.limit : 50, 50)),
  },
  {
    tool: {
      name: "get_actionable_recommendations",
      description: "Setups that would actually be traded right now under the real consensus + risk-engine rules -- one per symbol, excludes symbols with an open position.",
      parametersJsonSchema: { type: "object", properties: {} },
    },
    handler: async () => getActionableRecommendations(),
  },
  {
    tool: {
      name: "get_accounts",
      description: "Every account (primary + Tradesea if configured) with its current risk limits.",
      parametersJsonSchema: { type: "object", properties: {} },
    },
    handler: async () => getAccountsList(),
  },
  {
    tool: {
      name: "get_equity_curve",
      description: "Equity curve points for one account over a trailing window.",
      parametersJsonSchema: {
        type: "object",
        properties: { accountId: { type: "number" }, days: { type: "number", description: "Default 30." } },
        required: ["accountId"],
      },
    },
    handler: async (input) => getEquityCurve(Number(input.accountId), typeof input.days === "number" ? input.days : 30),
  },
  {
    tool: {
      name: "get_performance_summary",
      description: "Closed-trade stats (win rate, profit factor, avg R, etc.) and equity-curve ratios (Sharpe/Sortino/drawdown) for an account, plus a breakdown by strategy and by regime.",
      parametersJsonSchema: { type: "object", properties: { accountId: { type: "number", description: "Defaults to the primary account." } } },
    },
    handler: async (input) => getPerformanceSummary(typeof input.accountId === "number" ? input.accountId : undefined),
  },
  {
    tool: {
      name: "get_regime_current",
      description: "Current trend/volatility regime classification per instrument.",
      parametersJsonSchema: { type: "object", properties: {} },
    },
    handler: async () => getCurrentRegime(),
  },
  {
    tool: {
      name: "get_news_upcoming",
      description: "Economic calendar events from 6 hours ago through 7 days out.",
      parametersJsonSchema: { type: "object", properties: {} },
    },
    handler: async () => getUpcomingNews(),
  },
  {
    tool: {
      name: "get_news_risk_status",
      description: "Whether trading is currently inside a high-impact news risk window, and the nearest upcoming event.",
      parametersJsonSchema: { type: "object", properties: {} },
    },
    handler: async () => getNewsRiskStatus(),
  },
  {
    tool: {
      name: "get_market_snapshot",
      description: "Per-instrument last price, contract specs, current regime, session, moving-average stack, and Fibonacci levels.",
      parametersJsonSchema: { type: "object", properties: {} },
    },
    handler: async () => getMarketSnapshot(),
  },
  {
    tool: {
      name: "get_support_resistance",
      description: "Support/resistance pivot levels per instrument -- the same levels a real entry is gated against.",
      parametersJsonSchema: { type: "object", properties: {} },
    },
    handler: async () => getSupportResistanceSnapshot(),
  },
  {
    tool: {
      name: "get_dealer_levels",
      description: "Most recent dealer gamma-exposure levels per instrument (call wall, put wall, gamma flip) derived from CBOE options chains.",
      parametersJsonSchema: { type: "object", properties: {} },
    },
    handler: async () => getDealerLevelsSnapshot(),
  },
  {
    tool: {
      name: "get_dealer_levels_report",
      description: "Plain-English narrative report of the dealer gamma levels per instrument.",
      parametersJsonSchema: { type: "object", properties: {} },
    },
    handler: async () => getDealerLevelsReportSnapshot(),
  },
  {
    tool: {
      name: "get_opening_range",
      description: "Opening-range breakout statistics (empirical probability the session's first-hour high/low is later broken) for one or all instruments.",
      parametersJsonSchema: { type: "object", properties: { symbol: { type: "string" } } },
    },
    handler: async (input) => {
      const symbols = typeof input.symbol === "string" ? [input.symbol] : DEFAULT_INSTRUMENTS.map((i) => i.symbol);
      const entries = await Promise.all(symbols.map(async (symbol) => [symbol, await getOpeningRangeStats(symbol)] as const));
      return Object.fromEntries(entries);
    },
  },
  {
    tool: {
      name: "get_session_performance",
      description: "Per-session (New York/London/Asian) resolved-outcome win rate, avg R, and confluence-label breakdown over the last 30 days.",
      parametersJsonSchema: { type: "object", properties: {} },
    },
    handler: async () => cached("session-performance", () => computeSessionPerformanceForAllSessions()),
  },
  {
    tool: {
      name: "get_strategy_comparison",
      description: "v1 through v7 scoring versions compared side-by-side per session over the last 30 days -- true apples-to-apples since every version is shadow-scored on the same signals.",
      parametersJsonSchema: { type: "object", properties: {} },
    },
    handler: async () => cached("strategy-comparison", () => computeStrategyComparison()),
  },
  {
    tool: {
      name: "get_version_divergence",
      description: "For every pair of scoring versions, how each version's INCREMENTAL picks (signals where it disagreed with the other) actually resolved -- the real evidence of whose judgment is better.",
      parametersJsonSchema: { type: "object", properties: {} },
    },
    handler: async () => cached("version-divergence", () => computeVersionDivergence()),
  },
  {
    tool: {
      name: "get_strategy_status",
      description: "Whether a given strategyId (e.g. \"breakout_donchian_20\") is actively firing signals -- fire count and last-fired time.",
      parametersJsonSchema: { type: "object", properties: { strategyId: { type: "string" } }, required: ["strategyId"] },
    },
    handler: async (input) => computeStrategyStatus(String(input.strategyId)),
  },
  {
    tool: {
      name: "get_daily_plan_zones",
      description: "Every symbol's currently active daily-plan zones (set via set_daily_plan_zones) -- the key price levels currently gating real execution this trading session.",
      parametersJsonSchema: { type: "object", properties: {} },
    },
    handler: async () => listActiveDailyPlanZones(),
  },
  {
    tool: {
      name: "get_disabled_strategies",
      description: "Every strategyId currently taken out of live signal generation (set via disable_strategy), with the reason it was disabled.",
      parametersJsonSchema: { type: "object", properties: {} },
    },
    handler: async () => listDisabledStrategies(),
  },
  {
    tool: {
      name: "get_disabled_strategy_symbols",
      description: "Every (strategyId, symbol) pair currently taken out of live signal generation for that symbol specifically (set via disable_strategy_symbol), with the reason.",
      parametersJsonSchema: { type: "object", properties: {} },
    },
    handler: async () => listDisabledStrategySymbols(),
  },
];

// ---------------------------------------------------------------------------
// Write tools -- real actions, no human confirmation. Every one funnels
// through withAssistantAudit, which re-checks the gate, records an
// AssistantAction row regardless of outcome, and broadcasts on the live feed.
// ---------------------------------------------------------------------------

type AuditOutcome = { ok: true; summary: string; raw?: unknown; tradeId?: number } | { ok: false; error: string };

async function recordAssistantAction(toolName: string, input: unknown, outcome: AuditOutcome, assistantMessageId: number | null): Promise<void> {
  const row = await prisma.assistantAction.create({
    data: {
      toolName,
      input: toPlainJson(input) as Parameters<typeof prisma.assistantAction.create>[0]["data"]["input"],
      status: outcome.ok ? "success" : "error",
      resultSummary: outcome.ok ? outcome.summary : outcome.error,
      rawResult: outcome.ok ? (toPlainJson(outcome.raw) as Parameters<typeof prisma.assistantAction.create>[0]["data"]["rawResult"]) : undefined,
      errorMessage: outcome.ok ? null : outcome.error,
      tradeId: outcome.ok ? outcome.tradeId ?? null : null,
      messageId: assistantMessageId,
    },
  });
  logger.info({ toolName, status: row.status }, "assistant_action_recorded");
  await manager.broadcast({
    type: "assistant_action",
    action: { id: row.id, toolName, status: row.status, resultSummary: row.resultSummary, tradeId: row.tradeId, createdAt: row.createdAt },
  });
}

async function withAssistantAudit(toolName: string, input: unknown, assistantMessageId: number | null, run: () => Promise<AuditOutcome>): Promise<AuditOutcome> {
  const settings = getSettings();
  const state = await getSystemState();
  if (!settings.assistantEnabled || !state.assistantActionsEnabled) {
    const outcome: AuditOutcome = { ok: false, error: "Assistant actions are currently disabled -- the assistantActionsEnabled gate is off. This write tool cannot run." };
    await recordAssistantAction(toolName, input, outcome, assistantMessageId);
    return outcome;
  }
  let outcome: AuditOutcome;
  try {
    outcome = await run();
  } catch (err) {
    outcome = { ok: false, error: err instanceof ModeChangeError ? err.message : err instanceof Error ? err.message : String(err) };
  }
  await recordAssistantAction(toolName, input, outcome, assistantMessageId);
  return outcome;
}

type WriteToolHandler = (input: Record<string, unknown>, assistantMessageId: number | null) => Promise<AuditOutcome>;

const WRITE_TOOLS: { tool: FunctionDeclaration; handler: WriteToolHandler }[] = [
  {
    tool: {
      name: "place_manual_order",
      description: "Place a real market order with a mandatory stop and optional take-profit. Bypasses scoring but NOT circuit breakers or the mandatory-stop rule. Executes immediately, no confirmation.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          side: { type: "string", enum: ["long", "short"] },
          quantity: { type: "number" },
          stopPrice: { type: "number" },
          takeProfitPrice: { type: "number" },
        },
        required: ["symbol", "side", "quantity", "stopPrice"],
      },
    },
    handler: async (input, messageId) =>
      withAssistantAudit("place_manual_order", input, messageId, async () => {
        const result = await placeManualOrder(input as unknown as ManualTradeInput);
        if (!result.ok) return { ok: false, error: result.error };
        return {
          ok: true,
          summary: `Placed ${input.side} ${input.quantity} ${input.symbol} @ ~${result.data.fillPrice} (trade #${result.data.tradeId}).`,
          raw: result.data,
          tradeId: result.data.tradeId,
        };
      }),
  },
  {
    tool: {
      name: "close_position",
      description: "Close an open position by trade id via its owning broker.",
      parametersJsonSchema: { type: "object", properties: { tradeId: { type: "number" } }, required: ["tradeId"] },
    },
    handler: async (input, messageId) =>
      withAssistantAudit("close_position", input, messageId, async () => {
        const tradeId = Number(input.tradeId);
        const result = await closeOpenPosition(tradeId);
        if (!result.ok) return { ok: false, error: result.error };
        return { ok: true, summary: `Close submitted for trade #${tradeId}.`, raw: result.data, tradeId };
      }),
  },
  {
    tool: {
      name: "let_it_ride",
      description: "Irreversible: stop force-closing this open trade at its stored take-profit price once its real trailing-stop order is live, letting a winner run further.",
      parametersJsonSchema: { type: "object", properties: { tradeId: { type: "number" } }, required: ["tradeId"] },
    },
    handler: async (input, messageId) =>
      withAssistantAudit("let_it_ride", input, messageId, async () => {
        const tradeId = Number(input.tradeId);
        const result = await enableLetItRide(tradeId);
        if (!result.ok) return { ok: false, error: result.error };
        return { ok: true, summary: `Let-it-ride enabled for trade #${tradeId}.`, raw: result.data, tradeId };
      }),
  },
  {
    tool: {
      name: "acknowledge_recommendation",
      description: "Mark a recommendation row as acknowledged (reviewed, no further action needed).",
      parametersJsonSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
    },
    handler: async (input, messageId) =>
      withAssistantAudit("acknowledge_recommendation", input, messageId, async () => {
        const id = Number(input.id);
        const existing = await prisma.score.findUnique({ where: { id } });
        if (!existing) return { ok: false, error: `Recommendation #${id} not found.` };
        await prisma.score.update({ where: { id }, data: { acknowledged: true, acknowledgedAt: new Date() } });
        return { ok: true, summary: `Acknowledged recommendation #${id}.`, raw: { status: "acknowledged" } };
      }),
  },
  {
    tool: {
      name: "set_trading_mode",
      description: "Switch TopstepX trading mode. LIVE requires the live broker to already be connected and LIVE_TRADING_CONFIRMED=true -- this tool cannot bypass that gate, only trip it if it's already open.",
      parametersJsonSchema: { type: "object", properties: { mode: { type: "string", enum: ["analysis_only", "paper", "live"] } }, required: ["mode"] },
    },
    handler: async (input, messageId) =>
      withAssistantAudit("set_trading_mode", input, messageId, async () => {
        const state = await setMode(input.mode as TradingMode);
        return { ok: true, summary: `Trading mode set to ${state.mode}.`, raw: { mode: state.mode } };
      }),
  },
  {
    tool: {
      name: "set_tradesea_live_enabled",
      description: "Enable or disable Tradesea's own live-trading switch. Enabling requires TRADESEA_ENABLED and TRADESEA_LIVE_TRADING_CONFIRMED to already be set -- this tool cannot bypass that gate.",
      parametersJsonSchema: { type: "object", properties: { enabled: { type: "boolean" } }, required: ["enabled"] },
    },
    handler: async (input, messageId) =>
      withAssistantAudit("set_tradesea_live_enabled", input, messageId, async () => {
        const state = await setTradeseaLiveEnabled(Boolean(input.enabled));
        return { ok: true, summary: `Tradesea live-enabled set to ${state.tradeseaLiveEnabled}.`, raw: { tradeseaLiveEnabled: state.tradeseaLiveEnabled } };
      }),
  },
  {
    tool: {
      name: "clear_kill_switch",
      description: "Clear the TopstepX trading kill switch (does NOT touch the assistant's own separate actions-enabled gate).",
      parametersJsonSchema: { type: "object", properties: {} },
    },
    handler: async (input, messageId) =>
      withAssistantAudit("clear_kill_switch", input, messageId, async () => {
        const state = await clearKillSwitch();
        return { ok: true, summary: `Kill switch cleared (now ${state.killSwitch}).`, raw: { killSwitch: state.killSwitch } };
      }),
  },
  {
    tool: {
      name: "set_take_profit_r_multiple",
      description: "Set the reward:risk multiple applied to every new signal's take-profit target, shared across every strategy/scoring version.",
      parametersJsonSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
    },
    handler: async (input, messageId) =>
      withAssistantAudit("set_take_profit_r_multiple", input, messageId, async () => {
        const state = await setTakeProfitRMultiple(Number(input.value));
        return { ok: true, summary: `takeProfitRMultiple set to ${state.takeProfitRMultiple}.`, raw: { takeProfitRMultiple: state.takeProfitRMultiple } };
      }),
  },
  {
    tool: {
      name: "set_confidence_tiers",
      description: "Set the 3 confidence-tier probability thresholds and position-size quantities used for sizing (must be strictly ascending thresholds).",
      parametersJsonSchema: {
        type: "object",
        properties: {
          tiers: {
            type: "array",
            description: "Exactly 3 entries, ascending by threshold.",
            items: { type: "object", properties: { threshold: { type: "number" }, quantity: { type: "number" } }, required: ["threshold", "quantity"] },
          },
        },
        required: ["tiers"],
      },
    },
    handler: async (input, messageId) =>
      withAssistantAudit("set_confidence_tiers", input, messageId, async () => {
        const tiers = input.tiers as [ConfidenceTierInput, ConfidenceTierInput, ConfidenceTierInput];
        if (!Array.isArray(tiers) || tiers.length !== 3) return { ok: false, error: "tiers must be an array of exactly 3 entries." };
        const state = await setConfidenceTiers(tiers);
        return {
          ok: true,
          summary: `Confidence tiers updated.`,
          raw: {
            confidenceTiers: [
              { threshold: state.confidenceTier1Threshold, quantity: state.confidenceTier1Quantity },
              { threshold: state.confidenceTier2Threshold, quantity: state.confidenceTier2Quantity },
              { threshold: state.confidenceTier3Threshold, quantity: state.confidenceTier3Quantity },
            ],
          },
        };
      }),
  },
  {
    tool: {
      name: "update_risk_limits",
      description: "Update an account's risk limits (per-trade risk, daily loss cap, trailing drawdown cap, max position size, max consecutive losses, max daily trades, and optional fixed-dollar overrides).",
      parametersJsonSchema: {
        type: "object",
        properties: {
          accountId: { type: "number" },
          perTradeRiskPct: { type: "number" },
          maxDailyLossPct: { type: "number" },
          maxTrailingDrawdownPct: { type: "number" },
          maxPositionSize: { type: "number" },
          maxConsecutiveLosses: { type: "number" },
          maxDailyTrades: { type: "number" },
          perTradeRiskDollars: { type: ["number", "null"] },
          perTradeProfitDollars: { type: ["number", "null"] },
          maxDailyLossDollars: { type: ["number", "null"] },
        },
        required: ["accountId", "perTradeRiskPct", "maxDailyLossPct", "maxTrailingDrawdownPct", "maxPositionSize", "maxConsecutiveLosses", "maxDailyTrades"],
      },
    },
    handler: async (input, messageId) =>
      withAssistantAudit("update_risk_limits", input, messageId, async () => {
        const accountId = Number(input.accountId);
        const body: RiskLimitsUpdateBody = {
          perTradeRiskPct: Number(input.perTradeRiskPct),
          maxDailyLossPct: Number(input.maxDailyLossPct),
          maxTrailingDrawdownPct: Number(input.maxTrailingDrawdownPct),
          maxPositionSize: Number(input.maxPositionSize),
          maxConsecutiveLosses: Number(input.maxConsecutiveLosses),
          maxDailyTrades: Number(input.maxDailyTrades),
          perTradeRiskDollars: input.perTradeRiskDollars === null || input.perTradeRiskDollars === undefined ? null : Number(input.perTradeRiskDollars),
          perTradeProfitDollars: input.perTradeProfitDollars === null || input.perTradeProfitDollars === undefined ? null : Number(input.perTradeProfitDollars),
          maxDailyLossDollars: input.maxDailyLossDollars === null || input.maxDailyLossDollars === undefined ? null : Number(input.maxDailyLossDollars),
        };
        const result = await updateRiskLimits(accountId, body);
        if (!result.ok) return { ok: false, error: result.error };
        return { ok: true, summary: `Risk limits updated for account #${accountId}.`, raw: result.data };
      }),
  },
  {
    tool: {
      name: "set_daily_plan_zones",
      description:
        "Set this trading session's support and resistance boundaries for a symbol from your own daily-plan analysis (real S/R pivots, dealer gamma walls, etc). ALWAYS exactly two zones: the lower one becomes the support boundary, the upper one the resistance boundary -- pick real levels bracketing current price that actually bound where price is likely to range this session, not a narrow pivot band. Scoped to the CURRENT session (New York/London/Asian) -- REPLACES any zones already set for this symbol this session, not additive, and automatically expires at the next session boundary. Once set, this becomes a REAL execution gate (risk/engine.ts's evaluateDailyPlanRange): fading a boundary (short at resistance, long at support) is allowed with its stop placed beyond that boundary and its target at the opposite one; a confirmed break through a boundary is allowed WITH that break (long above resistance, short below support) at normal sizing; a trade fighting a boundary it hasn't broken is blocked; anything strictly between the two boundaries is unrestricted. `enforcement` is no longer read as hard/soft -- set it to \"hard\" for both zones; use `label` to say which boundary it is and what real level it's based on. A symbol with no zones set (or a count other than exactly two) is completely unaffected.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          zones: {
            type: "array",
            description: "Exactly two zones for this symbol this session -- the support boundary and the resistance boundary. Replaces whatever was set before.",
            items: {
              type: "object",
              properties: {
                priceLow: { type: "number" },
                priceHigh: { type: "number" },
                enforcement: { type: "string", enum: ["hard", "soft"] },
                label: { type: "string", description: "Which boundary this is and what real level it's based on, e.g. \"support boundary (put wall floor at 7650)\" or \"resistance boundary (heavy pivot ceiling at 7707)\"." },
              },
              required: ["priceLow", "priceHigh", "enforcement", "label"],
            },
          },
        },
        required: ["symbol", "zones"],
      },
    },
    handler: async (input, messageId) =>
      withAssistantAudit("set_daily_plan_zones", input, messageId, async () => {
        const symbol = String(input.symbol);
        const zonesInput = input.zones;
        if (!Array.isArray(zonesInput)) return { ok: false, error: "zones must be an array." };
        const zones: DailyPlanZoneInput[] = [];
        for (const z of zonesInput as Record<string, unknown>[]) {
          const priceLow = Number(z.priceLow);
          const priceHigh = Number(z.priceHigh);
          const enforcement = z.enforcement;
          if (!Number.isFinite(priceLow) || !Number.isFinite(priceHigh) || priceLow >= priceHigh) {
            return { ok: false, error: `invalid zone: priceLow (${z.priceLow}) must be a number strictly less than priceHigh (${z.priceHigh}).` };
          }
          if (enforcement !== "hard" && enforcement !== "soft") {
            return { ok: false, error: `invalid zone enforcement "${enforcement}" -- must be "hard" or "soft".` };
          }
          zones.push({ priceLow, priceHigh, enforcement, label: String(z.label ?? "") });
        }
        await setDailyPlanZones(symbol, zones, resolveDailyPlanAt());
        return {
          ok: true,
          summary: zones.length > 0 ? `Set ${zones.length} daily plan zone(s) for ${symbol} this session.` : `Cleared all daily plan zones for ${symbol} this session.`,
          raw: { symbol, zones },
        };
      }),
  },
  {
    tool: {
      name: "clear_daily_plan_zones",
      description: "Remove this session's daily-plan zones for a symbol -- the daily-plan-zone gate returns to a no-op for that symbol until re-set.",
      parametersJsonSchema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
    },
    handler: async (input, messageId) =>
      withAssistantAudit("clear_daily_plan_zones", input, messageId, async () => {
        const symbol = String(input.symbol);
        await clearDailyPlanZones(symbol);
        return { ok: true, summary: `Cleared daily plan zones for ${symbol}.`, raw: { symbol } };
      }),
  },
  {
    tool: {
      name: "set_daily_take_profit_target",
      description:
        "Set this trading session's estimated likely achievable point move for a symbol -- your own read of how far price can realistically travel this session, informed by the same range/direction/dealer-gamma data behind set_daily_plan_zones (e.g. \"NQ can realistically move 60 points today given the range and regime strength\"). This is NOT the trade's actual take-profit distance -- the system takes a fraction of your estimate as the real target (currently 1/3, a deliberate risk margin so the target stays reachable rather than requiring the full move), so give your genuine, undiscounted estimate of the likely move, not an already-conservative number. Scoped to the CURRENT session, same as set_daily_plan_zones -- REPLACES any estimate already set for this symbol this session, and expires at the next session boundary. Only applies to symbols using the fixed-target execution path (currently ES/NQ) -- see get_system_state or ask if unsure. A symbol with no estimate set this session falls back to a fixed default.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          likelyMovePoints: { type: "number", description: "Your estimate of the likely achievable point move this session, in price points (not dollars) -- the full move, not pre-divided by anything." },
          label: { type: "string", description: "Short reasoning, e.g. \"session range is ~180pts wide, ADX 41 (strong trend) favors reaching a meaningful fraction of it\"." },
        },
        required: ["symbol", "likelyMovePoints", "label"],
      },
    },
    handler: async (input, messageId) =>
      withAssistantAudit("set_daily_take_profit_target", input, messageId, async () => {
        const symbol = String(input.symbol);
        const likelyMovePoints = Number(input.likelyMovePoints);
        if (!Number.isFinite(likelyMovePoints) || likelyMovePoints <= 0) {
          return { ok: false, error: `likelyMovePoints (${input.likelyMovePoints}) must be a positive number.` };
        }
        const label = String(input.label ?? "");
        await setDailyPlanTakeProfitTarget(symbol, likelyMovePoints, label, resolveDailyPlanAt());
        return {
          ok: true,
          summary: `Set daily take-profit target for ${symbol}: likely move ${likelyMovePoints}pts this session (real target = 1/3 of that, per risk/stops.ts's DAILY_PLAN_TAKE_PROFIT_FRACTION).`,
          raw: { symbol, likelyMovePoints, label },
        };
      }),
  },
  {
    tool: {
      name: "disable_strategy",
      description:
        "Temporarily take a strategyId out of live signal generation (e.g. \"breakout_donchian_20\", \"continuous_v3_scan_short\") -- it stops firing new signals/trades entirely until re-enabled. Reversible via enable_strategy. Base this on a real, adequately-sized sample -- a handful of trades (single digits) is not enough to disable a strategy on; say so and decline if the evidence you have is that thin, rather than acting on noise.",
      parametersJsonSchema: {
        type: "object",
        properties: { strategyId: { type: "string" }, reason: { type: "string", description: "Why -- cite the specific data (win rate, sample size, regime) that justifies this." } },
        required: ["strategyId", "reason"],
      },
    },
    handler: async (input, messageId) =>
      withAssistantAudit("disable_strategy", input, messageId, async () => {
        const strategyId = String(input.strategyId);
        const reason = String(input.reason);
        await disableStrategy(strategyId, reason);
        return { ok: true, summary: `Disabled strategy "${strategyId}": ${reason}`, raw: { strategyId, reason } };
      }),
  },
  {
    tool: {
      name: "enable_strategy",
      description: "Re-enable a previously disabled strategyId -- it resumes generating live signals/trades immediately.",
      parametersJsonSchema: { type: "object", properties: { strategyId: { type: "string" } }, required: ["strategyId"] },
    },
    handler: async (input, messageId) =>
      withAssistantAudit("enable_strategy", input, messageId, async () => {
        const strategyId = String(input.strategyId);
        await enableStrategy(strategyId);
        return { ok: true, summary: `Re-enabled strategy "${strategyId}".`, raw: { strategyId } };
      }),
  },
  {
    tool: {
      name: "disable_strategy_symbol",
      description:
        "Finer than disable_strategy: takes one strategyId out of live signal generation for ONE specific symbol only (e.g. disable \"continuous_v3_scan_long\" on \"GC\" while it keeps trading ES/NQ normally). Use this instead of disable_strategy when a strategy's performance genuinely differs by instrument -- disabling the whole strategy would also block symbols where it's actually winning. Same evidence bar as disable_strategy: a real, adequately-sized per-symbol sample, not a handful of trades.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          strategyId: { type: "string" },
          symbol: { type: "string" },
          reason: { type: "string", description: "Why -- cite the specific per-symbol data (win rate, sample size) that justifies this." },
        },
        required: ["strategyId", "symbol", "reason"],
      },
    },
    handler: async (input, messageId) =>
      withAssistantAudit("disable_strategy_symbol", input, messageId, async () => {
        const strategyId = String(input.strategyId);
        const symbol = String(input.symbol);
        const reason = String(input.reason);
        await disableStrategySymbol(strategyId, symbol, reason);
        return { ok: true, summary: `Disabled strategy "${strategyId}" on ${symbol}: ${reason}`, raw: { strategyId, symbol, reason } };
      }),
  },
  {
    tool: {
      name: "enable_strategy_symbol",
      description: "Re-enable a previously disabled (strategyId, symbol) pair -- that strategy resumes generating live signals/trades on that symbol immediately.",
      parametersJsonSchema: {
        type: "object",
        properties: { strategyId: { type: "string" }, symbol: { type: "string" } },
        required: ["strategyId", "symbol"],
      },
    },
    handler: async (input, messageId) =>
      withAssistantAudit("enable_strategy_symbol", input, messageId, async () => {
        const strategyId = String(input.strategyId);
        const symbol = String(input.symbol);
        await enableStrategySymbol(strategyId, symbol);
        return { ok: true, summary: `Re-enabled strategy "${strategyId}" on ${symbol}.`, raw: { strategyId, symbol } };
      }),
  },
];

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Write tools are only included when the assistant's own actions gate is open -- the model is never offered a tool it can't use. */
export function getAvailableTools(actionsEnabled: boolean): FunctionDeclaration[] {
  const tools = READ_TOOLS.map((t) => t.tool);
  if (actionsEnabled) tools.push(...WRITE_TOOLS.map((t) => t.tool));
  return tools;
}

export async function executeTool(name: string, input: unknown, assistantMessageId: number | null): Promise<ToolExecutionResult> {
  const inputObj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;

  const readTool = READ_TOOLS.find((t) => t.tool.name === name);
  if (readTool) {
    try {
      const result = await readTool.handler(inputObj);
      return { content: toModelText(result), isError: false };
    } catch (err) {
      logger.warn({ tool: name, err: String(err) }, "read_tool_failed");
      return { content: `Error running ${name}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }

  const writeTool = WRITE_TOOLS.find((t) => t.tool.name === name);
  if (writeTool) {
    const outcome = await writeTool.handler(inputObj, assistantMessageId);
    if (outcome.ok) return { content: toModelText({ status: "success", summary: outcome.summary, result: outcome.raw }), isError: false };
    return { content: `Error running ${name}: ${outcome.error}`, isError: true };
  }

  return { content: `Unknown tool: ${name}`, isError: true };
}
