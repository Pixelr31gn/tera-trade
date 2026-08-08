import { z } from "zod";

export const TradingMode = {
  ANALYSIS_ONLY: "analysis_only",
  PAPER: "paper",
  LIVE: "live",
} as const;
export type TradingMode = (typeof TradingMode)[keyof typeof TradingMode];

export const BrokerKind = {
  SIMULATED: "simulated",
  PROJECTX: "projectx",
  BROWSER_CONTROL: "browser_control",
} as const;
export type BrokerKind = (typeof BrokerKind)[keyof typeof BrokerKind];

export const PriceSource = { YAHOO: "yahoo", BROWSER: "browser" } as const;
export type PriceSource = (typeof PriceSource)[keyof typeof PriceSource];

export const AccountSource = { SIMULATED: "simulated", BROWSER: "browser" } as const;
export type AccountSource = (typeof AccountSource)[keyof typeof AccountSource];

const boolFromEnv = z
  .string()
  .optional()
  .transform((v) => v?.toLowerCase() === "true");

const boolFromEnvDefault = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : v.toLowerCase() === "true"));

const numberFromEnv = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v !== undefined && v !== "" ? Number(v) : fallback));

const optionalNumberFromEnv = () =>
  z
    .string()
    .optional()
    .transform((v) => (v !== undefined && v !== "" ? Number(v) : undefined));

const EnvSchema = z.object({
  APP_NAME: z.string().default("Tera Trade"),
  ENVIRONMENT: z.string().default("development"),
  LOG_LEVEL: z.string().default("info"),
  API_KEY: z.string().default("change-me-dev-key"),

  // --- License (see core/license.ts and ../../LICENSE.md) ---
  LICENSE_KEY: z.string().default(""),
  LICENSED_TO: z.string().default(""),
  LICENSE_SIGNING_SECRET: z.string().default(""),

  DATABASE_URL: z.string(),

  TRADING_MODE: z.nativeEnum(TradingMode).default(TradingMode.ANALYSIS_ONLY),
  BROKER_KIND: z.nativeEnum(BrokerKind).default(BrokerKind.SIMULATED),
  LIVE_TRADING_CONFIRMED: boolFromEnv,
  // Defaults ON (protective) so a forgotten override can't silently disable
  // account-wide loss protection once real money is on the line -- must be
  // explicitly set to "false" (done for now, during paper testing) to
  // disable the daily-loss/trailing-drawdown auto-trip. Re-enable before
  // ever switching to live trading.
  KILL_SWITCH_ENABLED: boolFromEnvDefault(true),

  PROJECTX_BASE_URL: z.string().default("https://api.topstepx.com"),
  PROJECTX_RTC_URL: z.string().default("https://rtc.topstepx.com"),
  PROJECTX_USERNAME: z.string().default(""),
  PROJECTX_API_KEY: z.string().default(""),
  PROJECTX_ACCOUNT_ID: z.string().optional(),

  INSTRUMENT_SYMBOLS: z.string().default("ES,NQ,CL,GC"),

  HISTORICAL_BACKFILL_DAYS: numberFromEnv(365),
  BAR_INTERVAL_MINUTES: numberFromEnv(5),

  NEWS_CALENDAR_URL: z.string().default("https://nfs.faireconomy.media/ff_calendar_thisweek.json"),
  NEWS_RISK_WINDOW_MINUTES: numberFromEnv(15),
  NEWS_HIGH_IMPACT_ONLY: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? true : v.toLowerCase() === "true")),

  MIN_SCORE_THRESHOLD: numberFromEnv(0.65),

  DEFAULT_PER_TRADE_RISK_PCT: numberFromEnv(0.5),
  DEFAULT_MAX_DAILY_LOSS_PCT: numberFromEnv(3.0),
  DEFAULT_MAX_TRAILING_DRAWDOWN_PCT: numberFromEnv(6.0),
  DEFAULT_MAX_POSITION_SIZE: numberFromEnv(3),
  MAX_CONSECUTIVE_LOSSES: numberFromEnv(3),
  MAX_DAILY_TRADES: numberFromEnv(8),

  // Fixed-dollar overrides for new accounts -- unset by default, falling
  // back to the percentage-based fields above (see risk/engine.ts).
  DEFAULT_PER_TRADE_RISK_DOLLARS: optionalNumberFromEnv(),
  DEFAULT_PER_TRADE_PROFIT_DOLLARS: optionalNumberFromEnv(),
  DEFAULT_MAX_DAILY_LOSS_DOLLARS: optionalNumberFromEnv(),

  ENGINE_POLL_SECONDS: numberFromEnv(30),

  PORT: numberFromEnv(8000),

  // --- Browser-attach data source (read-only DOM watch of a broker web platform) ---
  PRICE_SOURCE: z.nativeEnum(PriceSource).default(PriceSource.YAHOO),
  ACCOUNT_SOURCE: z.nativeEnum(AccountSource).default(AccountSource.SIMULATED),
  BROWSER_CDP_URL: z.string().default("http://localhost:9222"),
  BROWSER_URL_MATCH: z.string().default("topstepx.com"),
  BROWSER_POLL_SECONDS: numberFromEnv(5),
  BROWSER_SELECTORS_PATH: z.string().optional(),

  // --- Automatic debug-mode Chrome launch (see browserWatch/chromeLauncher.ts) ---
  // Lets each user just start the app, rather than manually running Chrome
  // with --remote-debugging-port every time -- the whole point of the
  // "no API, local browser" distribution model.
  CHROME_AUTO_LAUNCH: boolFromEnvDefault(true),
  CHROME_EXECUTABLE_PATH: z.string().optional(),
  CHROME_DEBUG_USER_DATA_DIR: z.string().optional(),
  CHROME_DEBUG_START_URL: z.string().default("https://topstepx.com/"),

  // --- Order-flow listener (reads live bid/ask size + trade-aggressor flow
  // off the same TopstepX tab's WebSocket traffic, see
  // browserWatch/orderFlowListener.ts) -- only meaningful when PRICE_SOURCE
  // is browser, since it depends on the same attached tab.
  ORDER_FLOW_ENABLED: boolFromEnvDefault(true),
  ORDER_FLOW_FLUSH_SECONDS: numberFromEnv(10),

  // --- Browser-control (real mouse/click order placement via BrowserControlBroker) ---
  // Defaults to true (dry-run) so real clicks require an explicit, separate opt-in
  // on top of TRADING_MODE=live + BROKER_KIND=browser_control + LIVE_TRADING_CONFIRMED.
  DRY_RUN_ORDERS: boolFromEnvDefault(true),

  // --- Execution Decision Engine (2026-07-20) -- routes an approved signal
  // through fair-value-map scoring and a resting limit order instead of an
  // immediate market order. Defaults OFF: this is new, untested-live
  // automation (real limit-order DOM automation, built and unit-tested the
  // same night the market happened to be closed for maintenance) -- must be
  // deliberately turned on, and only after a DRY_RUN_ORDERS=true smoke test,
  // same posture as DRY_RUN_ORDERS itself.
  EXECUTION_DECISION_ENGINE_ENABLED: boolFromEnvDefault(false),
});

export interface Settings {
  appName: string;
  environment: string;
  logLevel: string;
  apiKey: string;
  licenseKey: string;
  licensedTo: string;
  licenseSigningSecret: string;
  databaseUrl: string;
  tradingMode: TradingMode;
  brokerKind: BrokerKind;
  liveTradingConfirmed: boolean;
  killSwitchEnabled: boolean;
  projectXBaseUrl: string;
  projectXRtcUrl: string;
  projectXUsername: string;
  projectXApiKey: string;
  projectXAccountId: string | undefined;
  instrumentSymbols: string[];
  historicalBackfillDays: number;
  barIntervalMinutes: number;
  newsCalendarUrl: string;
  newsRiskWindowMinutes: number;
  newsHighImpactOnly: boolean;
  minScoreThreshold: number;
  defaultPerTradeRiskPct: number;
  defaultMaxDailyLossPct: number;
  defaultMaxTrailingDrawdownPct: number;
  defaultMaxPositionSize: number;
  maxConsecutiveLosses: number;
  maxDailyTrades: number;
  defaultPerTradeRiskDollars: number | undefined;
  defaultPerTradeProfitDollars: number | undefined;
  defaultMaxDailyLossDollars: number | undefined;
  enginePollSeconds: number;
  port: number;
  priceSource: PriceSource;
  accountSource: AccountSource;
  browserCdpUrl: string;
  browserUrlMatch: string;
  browserPollSeconds: number;
  browserSelectorsPath: string | undefined;
  chromeAutoLaunch: boolean;
  chromeExecutablePath: string | undefined;
  chromeDebugUserDataDir: string | undefined;
  chromeDebugStartUrl: string;
  orderFlowEnabled: boolean;
  orderFlowFlushSeconds: number;
  dryRunOrders: boolean;
  executionDecisionEngineEnabled: boolean;
}

let cached: Settings | undefined;

export function getSettings(): Settings {
  if (cached) return cached;
  const env = EnvSchema.parse(process.env);
  cached = {
    appName: env.APP_NAME,
    environment: env.ENVIRONMENT,
    logLevel: env.LOG_LEVEL,
    apiKey: env.API_KEY,
    licenseKey: env.LICENSE_KEY,
    licensedTo: env.LICENSED_TO,
    licenseSigningSecret: env.LICENSE_SIGNING_SECRET,
    databaseUrl: env.DATABASE_URL,
    tradingMode: env.TRADING_MODE,
    brokerKind: env.BROKER_KIND,
    liveTradingConfirmed: env.LIVE_TRADING_CONFIRMED,
    killSwitchEnabled: env.KILL_SWITCH_ENABLED,
    projectXBaseUrl: env.PROJECTX_BASE_URL,
    projectXRtcUrl: env.PROJECTX_RTC_URL,
    projectXUsername: env.PROJECTX_USERNAME,
    projectXApiKey: env.PROJECTX_API_KEY,
    projectXAccountId: env.PROJECTX_ACCOUNT_ID,
    instrumentSymbols: env.INSTRUMENT_SYMBOLS.split(",").map((s) => s.trim()).filter(Boolean),
    historicalBackfillDays: env.HISTORICAL_BACKFILL_DAYS,
    barIntervalMinutes: env.BAR_INTERVAL_MINUTES,
    newsCalendarUrl: env.NEWS_CALENDAR_URL,
    newsRiskWindowMinutes: env.NEWS_RISK_WINDOW_MINUTES,
    newsHighImpactOnly: env.NEWS_HIGH_IMPACT_ONLY,
    minScoreThreshold: env.MIN_SCORE_THRESHOLD,
    defaultPerTradeRiskPct: env.DEFAULT_PER_TRADE_RISK_PCT,
    defaultMaxDailyLossPct: env.DEFAULT_MAX_DAILY_LOSS_PCT,
    defaultMaxTrailingDrawdownPct: env.DEFAULT_MAX_TRAILING_DRAWDOWN_PCT,
    defaultMaxPositionSize: env.DEFAULT_MAX_POSITION_SIZE,
    maxConsecutiveLosses: env.MAX_CONSECUTIVE_LOSSES,
    maxDailyTrades: env.MAX_DAILY_TRADES,
    defaultPerTradeRiskDollars: env.DEFAULT_PER_TRADE_RISK_DOLLARS,
    defaultPerTradeProfitDollars: env.DEFAULT_PER_TRADE_PROFIT_DOLLARS,
    defaultMaxDailyLossDollars: env.DEFAULT_MAX_DAILY_LOSS_DOLLARS,
    enginePollSeconds: env.ENGINE_POLL_SECONDS,
    port: env.PORT,
    priceSource: env.PRICE_SOURCE,
    accountSource: env.ACCOUNT_SOURCE,
    browserCdpUrl: env.BROWSER_CDP_URL,
    browserUrlMatch: env.BROWSER_URL_MATCH,
    browserPollSeconds: env.BROWSER_POLL_SECONDS,
    browserSelectorsPath: env.BROWSER_SELECTORS_PATH,
    chromeAutoLaunch: env.CHROME_AUTO_LAUNCH,
    chromeExecutablePath: env.CHROME_EXECUTABLE_PATH,
    chromeDebugUserDataDir: env.CHROME_DEBUG_USER_DATA_DIR,
    chromeDebugStartUrl: env.CHROME_DEBUG_START_URL,
    orderFlowEnabled: env.ORDER_FLOW_ENABLED,
    orderFlowFlushSeconds: env.ORDER_FLOW_FLUSH_SECONDS,
    dryRunOrders: env.DRY_RUN_ORDERS,
    executionDecisionEngineEnabled: env.EXECUTION_DECISION_ENGINE_ENABLED,
  };
  return cached;
}

/** Test-only: clear the cached settings so a test can re-read process.env. */
export function _resetSettingsCacheForTests(): void {
  cached = undefined;
}
