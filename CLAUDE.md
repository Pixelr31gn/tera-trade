# Tera Trade — project instructions

Automated futures trading for Topstep-funded accounts (ES/NQ). Node 20 +
TypeScript (Fastify) backend, Next.js dashboard, Prisma against hosted
Postgres. Account and price data are read off TopstepX's own web platform
through a managed Chrome tab (CDP) — there is no broker API key.

**This system places real orders against a funded account.** Treat every
change to `risk/`, `execution/`, or `brokers/` as production-critical.

## Commands

```bash
cd backend && npm run dev          # backend + auto-launches its Chrome profile
cd backend && npm test             # vitest; most tests need no database
cd frontend && npm run dev         # dashboard on :3000, needs the same API_KEY
npx prisma migrate deploy          # from backend/, after any schema change
```

`.env` lives in `backend/`, **not** the repo root — Prisma's CLI and the app's
own loader only look next to `backend/`'s files.

## Module map

| Layer | Path | Purity |
|---|---|---|
| Strategies (propose setups only) | `src/strategy/` | pure |
| Indicators / features | `src/analytics/`, `src/regime/` | pure |
| Scoring + gate | `src/scoring/` | pure except `training.ts`, `v3HistoricalAdjustment.ts` |
| Risk, sizing, stops | `src/risk/` | pure |
| Execution decisions | `src/execution/` | DB-coupled |
| Engine loop + caches | `src/engine/` | DB + wall-clock coupled |
| Brokers | `src/brokers/` | I/O |
| Browser read/control | `src/browserWatch/`, `src/browserControl/` | I/O |

Deeper detail: @docs/ARCHITECTURE.md and @docs/BUILD_HISTORY.md

## Invariants — do not violate without asking

1. **Strategies never size, never order, never see news/regime.** They return
   a `Signal` and nothing else. Keep "what pattern fired" separate from
   "should we trade it and how big."
2. **The pure layers stay pure.** No `prisma`, no `new Date()`, no `Date.now()`
   in `strategy/`, `analytics/`, `regime/`, `risk/`, or the rule scorers. Pass
   time and data in. This is what makes replay and testing possible — see
   @.claude/rules/replay-harness.md
3. **Never widen a live-trading gate.** `TRADING_MODE`, `BROKER_KIND`,
   `LIVE_TRADING_CONFIRMED`, and `KILL_SWITCH_ENABLED` are four independent
   opt-ins by design. Do not collapse, default, auto-escalate, or "simplify"
   them. Do not add a code path where paper can become live.
4. **Money math is `Decimal`, never `number`.** Every price, size, and P&L
   value uses decimal.js. Floats enter only at the boundary of pure indicator
   functions that take `OhlcBar`.
5. **ESM imports carry the `.js` extension** even for `.ts` sources.
6. **`prisma.trade` / `orderRecord` writes must reflect reality.** A row that
   claims a position exists when the broker is flat has caused a real incident
   (phantom position, 2026-07-19, trades #156/#157). When in doubt, re-read
   broker state rather than assuming.

## Conventions worth matching

Comments in this codebase record *why a number is what it is*, including the
history of changes and who asked for them — see `MAX_ENTRY_DISTANCE_ATR` in
`risk/engine.ts`. **Preserve those histories.** When you change a tuned
constant, append to the comment; never replace it. That log is the only record
of what has already been tried.

When you propose a change to a tuned parameter or a gate rule, say what
evidence supports it. "Cleaner" is not evidence. If the harness can answer it,
say so instead of guessing.

## Working style

- Read the surrounding module before editing. Most oddities here are load-bearing.
- Prefer small diffs. Do not reformat, reorder imports, or "tidy" files you
  were not asked to change.
- Run `npm test` before reporting done. Say plainly if a test fails.
- Never commit `.env`, and never write or expose secret *values* in it
  (API keys, tokens, DB credentials) — or anything under
  `src/core/license.ts`. Narrowed 2026-09-10 (explicit, repeated operator
  direction, after the operator judged the original blanket rule too costly
  given how often a plain config toggle (e.g. `BROKER_KIND`) needed a
  same-night change): non-secret configuration *values* already present in
  `.env` (a broker-kind selector, a feature flag, a numeric setting) may be
  edited directly when the operator has explicitly asked for that specific
  change. This is not a general license to edit `.env` freely — each such
  edit should still be one the operator has clearly, specifically asked for.
  Invariant 3 above still applies in full: this doesn't authorize adding code
  that flips these settings itself, only a human-directed one-line edit in
  response to an explicit request.
- Do not add new runtime dependencies without asking.
- If a request would touch live order placement, stop and confirm first.

## Known state

- Live trading works but is deliberately gated; paper mode is the norm.
- `ProjectXGatewayBroker` has never been integration-tested. The browser-attach
  path is the verified one.
- `scoring/training.ts` is dormant on purpose — an ML scorer was tried and
  pulled for being unproven. Do not re-enable it without out-of-sample
  validation.
- Historical intraday data is 5-minute Yahoo bars, ~60 days. This is currently
  the binding constraint on everything analytical.

## In flight

Building a replay harness in `src/replay/`. Read
@.claude/rules/replay-harness.md before touching `engine/loop.ts`,
`scoring/`, or anything under `src/replay/`.
