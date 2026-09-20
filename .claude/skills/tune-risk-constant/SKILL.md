---
name: tune-risk-constant
description: How to safely change one of Tera Trade's hand-set risk/scoring/consensus constants (e.g. MAX_ENTRY_DISTANCE_ATR) in response to a live pattern of rejections, without silently guessing a value or breaking a test that happens to sit near the boundary
---

Tera Trade is full of hand-set (not fitted) constants that gate whether a signal actually
executes -- proximity-to-level distance, directional-conviction margins, consensus thresholds,
entry-quality floors. Every one of them lives with a comment explaining the original reasoning,
and every one of them is *meant* to be revisited once real live data shows it's wrong for current
conditions -- see `diagnose-signal`'s closing section for the diagnostic side of this; this skill
is the follow-up action once you've decided a constant itself needs to change.

## Step 1: confirm this is a real, recurring pattern -- not one unlucky signal

A single rejected signal is not evidence a constant is miscalibrated; a strong trend produces
extended entries by nature, and a proximity/margin gate rejecting an occasional one is it working
correctly. Before touching anything, grep the live log for the same rejection reason recurring
across multiple signals in the current session:

```bash
grep -E "risk_rejected|consensus_not_reached" backend/backend-dev.log | tail -30
```

Confirmed live (2026-07-22): 7+ identical `risk_rejected` reasons ("entry is 6-9x ATR from the
nearest resistance level -- needs to be within 1.25x ATR") in under 3 minutes, on both ES and NQ,
during one sustained strong-trend session -- that's a real pattern, not noise. One rejection
twenty minutes ago with nothing since is not.

## Step 2: find the exact constant, read its comment before touching it

Known hand-set constants as of this build, and what they gate:

| Constant | File | Gates |
|---|---|---|
| ~~`MAX_ENTRY_DISTANCE_ATR`/`MIN_ENTRY_DISTANCE_ATR`~~ | `risk/engine.ts` | **Removed entirely 2026-07-28** (operator request) after being reactively loosened four times with no backtested basis -- `risk/engine.ts` now only requires a real, validated (2+ touch) S/R level to exist nearby, not any particular distance to it |
| `MIN_DIRECTIONAL_MARGIN_POINTS` | `scoring/gate.ts` | v3's long-vs-short conviction margin |
| `CONTINUOUS_SCAN_STANDOUT_THRESHOLD` / `CONTINUOUS_SCAN_FLOOR_THRESHOLD` | `engine/loop.ts` | Continuous-scan consensus (standout + floor across versions) |
| `MIN_LONG_TARGET_WIN_RATE` / `MIN_LONG_TARGET_SAMPLE_SIZE` | `engine/fixedTargetEdgeCache.ts` | Long-setup fixed-target historical-edge gate |
| `minScoreThreshold` | DB-persisted system state, not a source constant | Per-version taken/skipped threshold -- adjust via `/api/system`, not a code edit |

If the constant you're looking for isn't in this table, grep for it directly and read its comment
in full -- every one of these documents *why* the current value was chosen and, often, its prior
revision history.

**Different category, different caution level**: data-*quality*/corruption guards
(`TRUE_RANGE_OUTLIER_CLIP_MULTIPLE`, `OUTLIER_CONFIRMATIONS_REQUIRED`,
`MAX_REJECTION_DURATION_MS` in `marketData/minuteBarAggregator.ts` and `regime/indicators.ts`) are
**not** risk-appetite dials -- they exist to stop a bad tick from producing a real order (see the
2026-07-21 corrupted-bar incident). Loosening one of these because it "blocked a signal" risks
reopening exactly that hole. Only touch these with a specific, articulated reason tied to a false
positive you've confirmed was actually clean data, never just because something got rejected.

## Step 3: confirm the new value with the operator -- don't guess one yourself

Present the live evidence (the recurring rejection reason, with real numbers from tonight) and
either ask what value they want, or offer a concrete option if they haven't already told you
(e.g. "loosen 1.25x -> 1.9x?"). Don't silently pick a number on your own judgment -- this
directly controls how much risk the account takes on every subsequent signal.

## Step 4: edit the constant, extending its existing revision-history comment

Follow the convention already established on every one of these constants -- don't replace the
old reasoning, append to it with a dated note:

```ts
// (2026-07-20: loosened 25%, 1.0 -> 1.25, after several strong-trend setups were
// getting rejected for running slightly past this on continuous-scan signals.
// 2026-07-22: loosened again, 1.25 -> 1.9, operator request, after a sustained
// strong-trend session blocked essentially every continuous-scan signal on both
// ES and NQ -- entries were running 6-9x ATR past the nearest level, well beyond
// what the 25% bump covered.)
const MAX_ENTRY_DISTANCE_ATR = 1.9;
```

## Step 5: check for a test fixture sitting near the old *or* new boundary

This is the single most common thing that breaks here -- confirmed to have happened three times
now with `MAX_ENTRY_DISTANCE_ATR` alone (1.2x, 1.25x, and it's the reason one fixture now reads
"Pushing the whole shape away from entry removes the coincidence instead of just dodging today's
specific gate value"). A test asserting a rejection is often built with a fixture placed *just*
past the old threshold -- loosen the threshold and that same fixture can silently start passing
instead of rejecting, or a fixture meant to sit safely inside the gate can end up outside it.

```bash
grep -rn "<constant name or the number itself>" backend/tests/
```

Don't just nudge a coincidentally-placed fixture past the new value -- move it unambiguously far
from *any* reasonable threshold (as the comment above shows), so the next tuning pass doesn't hit
the same coincidence again.

## Step 6: typecheck + run the full suite

```bash
cd backend && npx tsc --noEmit && npm test
```

Test count should be unchanged (you didn't add/remove tests, just changed a value) unless a
fixture genuinely needed moving per Step 5, in which case account for that difference explicitly.

## Step 7: report back

State plainly: what changed, from what to what, why (cite the real log evidence), and confirm
typecheck/tests are clean. This is a live-risk change on a real account -- don't bury it in other
output.
