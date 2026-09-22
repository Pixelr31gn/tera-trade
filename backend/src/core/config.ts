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
  // The second concurrent live broker (Tradesea, app.tradesea.ai) -- see
  // docs/BUILD_HISTORY.md. Runs alongside BROWSER_CONTROL (TopstepX), never
  // replacing it; gated by its own independent TRADESEA_* opt-ins below,
  // never by BROKER_KIND/LIVE_TRADING_CONFIRMED (those stay TopstepX-only).
  TRADESEA_BROWSER_CONTROL: "tradesea_browser_control",
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
  // Where the backend also writes its logs as newline-delimited JSON, on top of
  // the pretty stdout stream (see core/logger.ts). Empty disables the file.
  // Default matches the path .gitignore and .claude/skills/daily-plan-fallback
  // have both assumed existed since long before it actually did -- 2026-09-21,
  // operator permission, after a whole debugging session spent inferring from
  // the database because no log line was readable anywhere.
  LOG_FILE: z.string().default("backend-dev.log"),
  API_KEY: z.string().default("change-me-dev-key"),

  // --- Dashboard login (see core/auth.ts) ---
  // Blank by default -- login is refused (fails closed) until set. Run
  // `npm run auth:set-password` (backend/) to generate this; never store the
  // plaintext password itself. SESSION_SECRET signs the login session cookie
  // and is separate from API_KEY (which stays available for non-browser
  // callers). A future TOTP second factor slots in alongside these two
  // without changing either.
  AUTH_PASSWORD_HASH: z.string().default(""),
  SESSION_SECRET: z.string().default(""),

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
  // Opened as a second tab in the same debug Chrome session once it's
  // reachable, so the dashboard is always sitting right next to the
  // TopstepX tab instead of requiring a separate manual browser window.
  // Blank disables this (e.g. if you'd rather keep the debug profile
  // TopstepX-only).
  DASHBOARD_URL: z.string().default("http://localhost:3000"),

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

  // --- Tradesea (second concurrent live broker, app.tradesea.ai) ---
  // Fully independent of TopstepX's TRADING_MODE/BROKER_KIND/
  // LIVE_TRADING_CONFIRMED/DRY_RUN_ORDERS above -- those keep gating
  // TopstepX only, unchanged. Everything below defaults off/safe so an
  // existing install is completely unaffected until explicitly turned on.
  TRADESEA_ENABLED: boolFromEnvDefault(false),
  TRADESEA_BROWSER_CDP_URL: z.string().default("http://localhost:9223"),
  TRADESEA_BROWSER_URL_MATCH: z.string().default("app.tradesea.ai"),
  // Mirrors DRY_RUN_ORDERS's own default/reasoning -- real clicks on
  // Tradesea require this to be explicitly set to false, separately from
  // TopstepX's own DRY_RUN_ORDERS.
  TRADESEA_DRY_RUN_ORDERS: boolFromEnvDefault(true),
  // Mirrors LIVE_TRADING_CONFIRMED's own reasoning -- a second, independent
  // opt-in so Tradesea going live can never be a side effect of TopstepX's
  // own live-trading config.
  TRADESEA_LIVE_TRADING_CONFIRMED: boolFromEnv,
  // Each optional -- falls back to the matching DEFAULT_* value (same risk
  // posture as TopstepX) when unset. See engine/bootstrap.ts's
  // ensureAccountForBrokerKind.
  TRADESEA_DEFAULT_PER_TRADE_RISK_PCT: optionalNumberFromEnv(),
  TRADESEA_DEFAULT_MAX_DAILY_LOSS_PCT: optionalNumberFromEnv(),
  TRADESEA_DEFAULT_MAX_TRAILING_DRAWDOWN_PCT: optionalNumberFromEnv(),
  TRADESEA_DEFAULT_MAX_POSITION_SIZE: optionalNumberFromEnv(),
  TRADESEA_MAX_CONSECUTIVE_LOSSES: optionalNumberFromEnv(),
  TRADESEA_MAX_DAILY_TRADES: optionalNumberFromEnv(),

  // --- AI assistant (in-app "Quin"-equivalent, see backend/src/assistant/) ---
  // Off by default -- an existing install is unaffected until all of
  // GEMINI_API_KEY, ASSISTANT_ENABLED, ASSISTANT_ACTIONS_CONFIRMED, and
  // the runtime assistantActionsEnabled DB toggle (see
  // execution/mode.ts's setAssistantActionsEnabled) are set. Same layered,
  // independent-gate posture as Tradesea's own TRADESEA_* opt-ins --
  // deliberately never widens TopstepX's or Tradesea's own trading gates.
  // Google Gemini (aistudio.google.com), not Anthropic -- picked 2026-08-28
  // for its free tier and better-proven function-calling reliability in
  // multi-turn agent loops than the other free/cheap alternative considered
  // (xAI/Grok, which requires a paid key and documented weaker tool-calling
  // reliability -- disqualifying for a path that executes real trades with
  // zero human confirmation).
  GEMINI_API_KEY: z.string().default(""),
  // Pinned to a specific version, not the "-latest" alias -- confirmed live
  // 2026-08-28 that the alias currently resolves to gemini-3.7-flash, a
  // days-old release returning consistent 503 "high demand" errors, while
  // this pinned version responded reliably. Revisit the alias once that
  // settles; a pin at least fails predictably instead of degrading whenever
  // Google rolls the alias onto whatever's newest.
  ASSISTANT_MODEL: z.string().default("gemini-3.5-flash"),
  ASSISTANT_ENABLED: boolFromEnvDefault(false),
  // Mirrors TRADESEA_LIVE_TRADING_CONFIRMED's own reasoning -- a second,
  // independent opt-in so the assistant's real-money write-tools going live
  // can never be a side effect of ASSISTANT_ENABLED alone.
  ASSISTANT_ACTIONS_CONFIRMED: boolFromEnv,

  // Local-model cutover (started 2026-08-30 as a narrow pilot scoped to just
  // the daily-plan scheduler's one tool -- see this repo's git history on
  // ollamaClient.ts -- to prove tool-calling reliability on a low-stakes,
  // already-digest-fed task before trusting it with anything higher-stakes.
  // Promoted 2026-09-01, operator request: run the FULL 38-tool assistant
  // (chat + scheduler both) against a self-hosted Qwen model over Ollama on
  // a second machine, specifically to remove Gemini's free-tier caps
  // (20 calls/day, 250k input tokens/min -- see systemPrompt.ts and
  // dailyPlanScheduler.ts's own comments on those, and the 2026-09-01
  // incident where a single mistimed quota hit silenced the daily-plan
  // scheduler's retries for an entire session). client.ts and
  // dailyPlanScheduler.ts both call the one exported sendChatMessage, which
  // routes to Gemini or Ollama based on this setting -- no separate
  // per-feature provider knob. Defaults to "gemini" so an unset .env is
  // unchanged behavior; switching requires deliberately setting this AND
  // pointing OLLAMA_BASE_URL at wherever Qwen is actually reachable.
  ASSISTANT_PROVIDER: z.enum(["gemini", "ollama"]).default("gemini"),
  // Ollama's server address for the active ASSISTANT_PROVIDER="ollama" path.
  // Defaults to a local server for safety (a fresh checkout with the
  // provider flipped on but no address configured should fail loudly, not
  // silently try to reach some assumed remote host) -- when Qwen is hosted
  // on a second machine, set this to that machine's Tailscale address
  // (e.g. http://100.x.y.z:11434 or its MagicDNS name) rather than exposing
  // Ollama's port to the public internet; this repo already runs Tailscale
  // for cross-device dashboard access (see BUILD_HISTORY.md), so no new
  // network exposure is needed.
  OLLAMA_BASE_URL: z.string().default("http://localhost:11434"),
  // Must match a model actually pulled on the Ollama host and confirmed
  // tool-capable (`ollama list` / `/api/tags` advertises "tools"). No
  // universal default makes sense across machines -- set this to the exact
  // Qwen tag you have pulled (e.g. "qwen2.5:14b", "qwen2.5:32b-instruct").
  OLLAMA_MODEL: z.string().default("qwen2.5:14b"),

  // --- Scout (local dev-environment agent, see backend/src/scout/) ---
  // Off by default -- a fresh checkout is unaffected. Deliberately independent of
  // ASSISTANT_ENABLED: Scout never trades and never touches ASSISTANT_ACTIONS_CONFIRMED
  // or any trading gate, so there's no reason its own on/off switch should be coupled to
  // the trading assistant's.
  SCOUT_ENABLED: boolFromEnvDefault(false),
  // Both fall back to the trading assistant's own OLLAMA_BASE_URL/OLLAMA_MODEL when unset
  // -- Scout runs against the SAME self-hosted Qwen 3.6 install by default (the operator's
  // own framing: "runs locally against Qwen 3.6 via Ollama"), since that's the only Qwen
  // 3.6 tag actually pulled anywhere in this setup. Set these separately only if Scout
  // should run against a different host/model than the trading assistant.
  SCOUT_OLLAMA_BASE_URL: z.string().optional(),
  SCOUT_OLLAMA_MODEL: z.string().optional(),
  // How often Scout runs one reasoning tick (scan activity + runtime signals, draft/reinforce
  // pitches). 60 minutes by default -- frequent enough to catch same-day recurrence, infrequent
  // enough that a local Ollama call every tick is no real burden.
  SCOUT_TICK_MINUTES: numberFromEnv(60),
  // Local hour (0-23) the once-daily digest compiles -- "end of day," not real-time, per the
  // operator's own requirement. Default 22 (10pm).
  SCOUT_DIGEST_HOUR: numberFromEnv(22),
  // Comma-separated, repo-root-relative directories Scout's file watcher watches for build
  // activity (see scout/buildActivity.ts). Missing paths are skipped silently, not an error --
  // lets one default list cover installs that don't have every directory (e.g. no frontend/).
  SCOUT_WATCH_PATHS: z.string().default("backend/src,backend/prisma,backend/scripts,backend/tests,frontend/app,frontend/components,frontend/lib,docs"),
  // Claude Code's own session-log directory for THIS repo, e.g.
  // C:\Users\you\.claude\projects\c--path-to-this-repo -- auto-derived from the repo root path
  // using Claude Code's own directory-naming scheme (see buildActivity.ts's deriveClaudeProjectDir)
  // when unset. Set this explicitly if the auto-derived guess doesn't match what's actually on
  // disk (path casing varies by which shell launched Claude Code).
  SCOUT_CLAUDE_PROJECT_DIR: z.string().optional(),

  // --- Taylor (see backend/src/taylor/) -- the agent Scout itself recommended: turns an
  // operator-APPROVED pitch into a detailed build blueprint. Same independent on/off switch and
  // Ollama fallback posture as Scout above -- runs as its own process, off by default.
  TAYLOR_ENABLED: boolFromEnvDefault(false),
  TAYLOR_OLLAMA_BASE_URL: z.string().optional(),
  TAYLOR_OLLAMA_MODEL: z.string().optional(),
  // How often Taylor checks for newly-approved (rated >= TAYLOR_APPROVAL_MIN_RATING), not-yet-
  // blueprinted pitches. Less time-sensitive than Scout's own tick -- a rating doesn't need a
  // same-hour response -- so this defaults longer.
  TAYLOR_TICK_MINUTES: numberFromEnv(120),
  // A pitch counts as "approved" (per the operator's own original framing: "a second agent that
  // turns an APPROVED pitch into a build blueprint") once rated at or above this. 4 by default --
  // a 3/5 reads as "fine, not exciting" in scout/ranking.ts's own rating scale, not clear approval.
  TAYLOR_APPROVAL_MIN_RATING: numberFromEnv(4),

  // --- Cross-Regime Analyzer (see backend/src/crossRegimeAnalyzer/) -- Scout pitch #6, "auto-flag
  // cross-regime underperformer combos": a deterministic (no LLM) daily scan of
  // computeSessionPerformanceForAllSessions()'s existing byMarketStructure/byLiquidity/
  // byPriceAction breakdowns for labels that keep losing, feeding flagged combos back into
  // Scout's own write_pitch/ScoutPitch pipeline rather than a separate alert channel. Off by
  // default, independent switch, same posture as Scout/Taylor above.
  CROSS_REGIME_ENABLED: boolFromEnvDefault(false),
  // How often the scan runs. Daily by default -- per the pitch's own "daily" frequency estimate,
  // and because these breakdowns are already 24h-cached (analytics.ts's `cached()`), so running
  // more often than that would just re-scan the same cached numbers.
  CROSS_REGIME_TICK_HOURS: numberFromEnv(24),
  // A label needs at least this many scored setups behind it before its avgRMultiple is trusted
  // enough to flag -- guards against a 2-sample bucket with one bad trade reading as "underperforms
  // forever." 20 is deliberately lower than the blueprint's own first-guess of 150: this system's
  // actual per-label sample sizes (a single-operator futures bot, not a high-volume shop) rarely
  // reach triple digits, so 150 would mean the check never fires. Tune up once real volume justifies it.
  CROSS_REGIME_MIN_SAMPLE_SIZE: numberFromEnv(20),
  // A label's avgRMultiple below this (R-multiples, not dollars) counts as "underperforming."
  // -0.03 is a deliberately loose starting floor (small negative edge, not a blowup) so the first
  // few weeks surface candidates for the operator to judge rather than staying silent by being too
  // strict out of the gate.
  CROSS_REGIME_MAX_AVG_R: numberFromEnv(-0.03),

  // --- Auto-Provisioner (see backend/src/autoProvisioner/) -- Scout pitch #2, "pitch-to-agent
  // auto-provisioner": reads Taylor's own blueprints and scaffolds a first-draft implementation
  // for a human to review. Deliberately narrower than the pitch's original framing -- see
  // autoProvisioner/systemPrompt.ts's header comment for why it stages files and never commits,
  // pushes, or opens a PR on its own. Off by default, independent switch. Reuses the general
  // OLLAMA_BASE_URL/MODEL (and Gemini fallback) the same way Scout/Taylor do.
  AUTO_PROVISIONER_ENABLED: boolFromEnvDefault(false),
  AUTO_PROVISIONER_OLLAMA_BASE_URL: z.string().optional(),
  AUTO_PROVISIONER_OLLAMA_MODEL: z.string().optional(),
  // How often it checks for newly-written, not-yet-provisioned blueprints. 6 hours per the
  // blueprint's own estimate -- code scaffolding is a heavier/slower LLM turn than Scout/Taylor's
  // own reasoning ticks, and there's no urgency (a blueprint just sits there, unlike a live signal).
  AUTO_PROVISIONER_TICK_HOURS: numberFromEnv(6),

  // --- Artifice (see backend/src/artifice/) -- the triage step between Taylor writing a blueprint
  // and a human (or the Auto-Provisioner) deciding to build it: reviews ALL untriaged blueprints
  // together in one pass (so it can catch e.g. three near-identical blueprints proposing the same
  // underlying idea), cross-checks each one's cited evidence against the same real,
  // already-computed session-performance data crossRegimeAnalyzer itself reads, and writes a
  // build/merge/low_priority/skip verdict with reasoning. Off by default, independent switch, same
  // posture as Scout/Taylor/Auto-Provisioner above. Reuses the general OLLAMA_BASE_URL/MODEL (and
  // Gemini fallback) the same way.
  ARTIFICE_ENABLED: boolFromEnvDefault(false),
  ARTIFICE_OLLAMA_BASE_URL: z.string().optional(),
  ARTIFICE_OLLAMA_MODEL: z.string().optional(),
  // How often Artifice checks for untriaged blueprints. A blueprint sitting untriaged costs
  // nothing while it waits, same low-urgency posture as Taylor's own tick.
  ARTIFICE_TICK_MINUTES: numberFromEnv(120),
});

export interface Settings {
  appName: string;
  environment: string;
  logLevel: string;
  logFile: string;
  apiKey: string;
  authPasswordHash: string;
  sessionSecret: string;
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
  dashboardUrl: string;
  orderFlowEnabled: boolean;
  orderFlowFlushSeconds: number;
  dryRunOrders: boolean;
  tradeseaEnabled: boolean;
  tradeseaBrowserCdpUrl: string;
  tradeseaBrowserUrlMatch: string;
  tradeseaDryRunOrders: boolean;
  tradeseaLiveTradingConfirmed: boolean;
  tradeseaDefaultPerTradeRiskPct: number | undefined;
  tradeseaDefaultMaxDailyLossPct: number | undefined;
  tradeseaDefaultMaxTrailingDrawdownPct: number | undefined;
  tradeseaDefaultMaxPositionSize: number | undefined;
  tradeseaMaxConsecutiveLosses: number | undefined;
  tradeseaMaxDailyTrades: number | undefined;
  geminiApiKey: string;
  assistantModel: string;
  assistantEnabled: boolean;
  assistantActionsConfirmed: boolean;
  assistantProvider: "gemini" | "ollama";
  ollamaBaseUrl: string;
  ollamaModel: string;
  scoutEnabled: boolean;
  scoutOllamaBaseUrl: string;
  scoutOllamaModel: string;
  scoutTickMinutes: number;
  scoutDigestHour: number;
  scoutWatchPaths: string[];
  scoutClaudeProjectDir: string | undefined;
  taylorEnabled: boolean;
  taylorOllamaBaseUrl: string;
  taylorOllamaModel: string;
  taylorTickMinutes: number;
  taylorApprovalMinRating: number;
  crossRegimeEnabled: boolean;
  crossRegimeTickHours: number;
  crossRegimeMinSampleSize: number;
  crossRegimeMaxAvgR: number;
  autoProvisionerEnabled: boolean;
  autoProvisionerOllamaBaseUrl: string;
  autoProvisionerOllamaModel: string;
  autoProvisionerTickHours: number;
  artificeEnabled: boolean;
  artificeOllamaBaseUrl: string;
  artificeOllamaModel: string;
  artificeTickMinutes: number;
}

let cached: Settings | undefined;

export function getSettings(): Settings {
  if (cached) return cached;
  const env = EnvSchema.parse(process.env);
  cached = {
    appName: env.APP_NAME,
    environment: env.ENVIRONMENT,
    logLevel: env.LOG_LEVEL,
    logFile: env.LOG_FILE,
    apiKey: env.API_KEY,
    authPasswordHash: env.AUTH_PASSWORD_HASH,
    sessionSecret: env.SESSION_SECRET,
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
    dashboardUrl: env.DASHBOARD_URL,
    orderFlowEnabled: env.ORDER_FLOW_ENABLED,
    orderFlowFlushSeconds: env.ORDER_FLOW_FLUSH_SECONDS,
    dryRunOrders: env.DRY_RUN_ORDERS,
    tradeseaEnabled: env.TRADESEA_ENABLED,
    tradeseaBrowserCdpUrl: env.TRADESEA_BROWSER_CDP_URL,
    tradeseaBrowserUrlMatch: env.TRADESEA_BROWSER_URL_MATCH,
    tradeseaDryRunOrders: env.TRADESEA_DRY_RUN_ORDERS,
    tradeseaLiveTradingConfirmed: env.TRADESEA_LIVE_TRADING_CONFIRMED,
    tradeseaDefaultPerTradeRiskPct: env.TRADESEA_DEFAULT_PER_TRADE_RISK_PCT,
    tradeseaDefaultMaxDailyLossPct: env.TRADESEA_DEFAULT_MAX_DAILY_LOSS_PCT,
    tradeseaDefaultMaxTrailingDrawdownPct: env.TRADESEA_DEFAULT_MAX_TRAILING_DRAWDOWN_PCT,
    tradeseaDefaultMaxPositionSize: env.TRADESEA_DEFAULT_MAX_POSITION_SIZE,
    tradeseaMaxConsecutiveLosses: env.TRADESEA_MAX_CONSECUTIVE_LOSSES,
    tradeseaMaxDailyTrades: env.TRADESEA_MAX_DAILY_TRADES,
    geminiApiKey: env.GEMINI_API_KEY,
    assistantModel: env.ASSISTANT_MODEL,
    assistantEnabled: env.ASSISTANT_ENABLED,
    assistantActionsConfirmed: env.ASSISTANT_ACTIONS_CONFIRMED,
    assistantProvider: env.ASSISTANT_PROVIDER,
    ollamaBaseUrl: env.OLLAMA_BASE_URL,
    ollamaModel: env.OLLAMA_MODEL,
    scoutEnabled: env.SCOUT_ENABLED,
    scoutOllamaBaseUrl: env.SCOUT_OLLAMA_BASE_URL || env.OLLAMA_BASE_URL,
    scoutOllamaModel: env.SCOUT_OLLAMA_MODEL || env.OLLAMA_MODEL,
    scoutTickMinutes: env.SCOUT_TICK_MINUTES,
    scoutDigestHour: env.SCOUT_DIGEST_HOUR,
    scoutWatchPaths: env.SCOUT_WATCH_PATHS.split(",").map((s) => s.trim()).filter(Boolean),
    scoutClaudeProjectDir: env.SCOUT_CLAUDE_PROJECT_DIR,
    taylorEnabled: env.TAYLOR_ENABLED,
    taylorOllamaBaseUrl: env.TAYLOR_OLLAMA_BASE_URL || env.OLLAMA_BASE_URL,
    taylorOllamaModel: env.TAYLOR_OLLAMA_MODEL || env.OLLAMA_MODEL,
    taylorTickMinutes: env.TAYLOR_TICK_MINUTES,
    taylorApprovalMinRating: env.TAYLOR_APPROVAL_MIN_RATING,
    crossRegimeEnabled: env.CROSS_REGIME_ENABLED,
    crossRegimeTickHours: env.CROSS_REGIME_TICK_HOURS,
    crossRegimeMinSampleSize: env.CROSS_REGIME_MIN_SAMPLE_SIZE,
    crossRegimeMaxAvgR: env.CROSS_REGIME_MAX_AVG_R,
    autoProvisionerEnabled: env.AUTO_PROVISIONER_ENABLED,
    autoProvisionerOllamaBaseUrl: env.AUTO_PROVISIONER_OLLAMA_BASE_URL || env.OLLAMA_BASE_URL,
    autoProvisionerOllamaModel: env.AUTO_PROVISIONER_OLLAMA_MODEL || env.OLLAMA_MODEL,
    autoProvisionerTickHours: env.AUTO_PROVISIONER_TICK_HOURS,
    artificeEnabled: env.ARTIFICE_ENABLED,
    artificeOllamaBaseUrl: env.ARTIFICE_OLLAMA_BASE_URL || env.OLLAMA_BASE_URL,
    artificeOllamaModel: env.ARTIFICE_OLLAMA_MODEL || env.OLLAMA_MODEL,
    artificeTickMinutes: env.ARTIFICE_TICK_MINUTES,
  };
  return cached;
}
