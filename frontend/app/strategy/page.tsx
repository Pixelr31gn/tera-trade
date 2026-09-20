"use client";

import { useState } from "react";
import useSWR from "swr";
import { apiFetch, fetcher } from "@/lib/api";
import { StrategyComparison, SystemState, VersionDivergence } from "@/lib/types";
import { Panel } from "@/components/Panel";
import { Badge } from "@/components/Badge";
import { useConfirm } from "@/components/ConfirmDialog";

const SESSION_LABELS: Record<string, string> = { new_york: "New York", london: "London", asian: "Asian" };
const SESSION_ORDER = ["new_york", "london", "asian"];
const VERSIONS = ["v1", "v2", "v3", "v5", "v6", "v7"] as const;
type Version = (typeof VERSIONS)[number];

const VERSION_DESCRIPTIONS: Record<Version, string> = {
  v1: "Baseline: trend, momentum, volatility, news, historical/opening-range, risk/reward, Fibonacci direction, and points-per-minute edge.",
  v2: "v1 + marketStructureEdge and liquidityEdge, added from real session-performance data.",
  v3: "0-100 confidence score: EMA50 trend (20), ADX strength (20), ATR volatility (15), volume vs 20-bar avg (15), RSI momentum (10), price structure (20) -- scored for both directions, requires conviction margin, adjusted by recent similar-setup performance, risk/reward shape, Fibonacci direction, and points-per-minute.",
  v5: "Built from mining real outcome data rather than intuition (2026-07-21): ADX-regime asymmetry (very strong trend favors shorts, hurts longs), weak-trend fade (fading a weak trend beat following it), and price-action normalcy (dramatic-looking candles underperformed normal ones). Shadow-scored only -- not yet a consensus voter (see engine/loop.ts's SHADOW_ONLY_VERSIONS).",
  // Description corrected 2026-08-07 -- was describing the pre-2026-08-03
  // design (an ensemble averaging v1/v2/v3/v5's logits). v6 has been a
  // complete, self-contained scorer since then -- see ruleScorerV6.ts.
  // v6/v7 descriptions corrected 2026-08-11 -- were describing v6-solo's old
  // unconditional 29.5%-alone threshold and v7 as shadow-only, both
  // superseded since (see engine/loop.ts's hasSessionBestVersionAgreement/
  // hasV7SoloAgreement).
  v6: "A complete, self-contained scorer for the trend-pullback-fib setup (2026-08-03, operator spec), not an ensemble: five weighted criteria on that one pattern (correction-leg length, retrace to a rising 20-EMA, 40-60% Fibonacci retracement, reversal-bar quality, market speed in the setup's favor). Its old standalone 29.5%-alone execution threshold was superseded 2026-08-10 by the session-best-version gate below -- v6 can still execute alone, but only once it's actually the session's best-performing version, not unconditionally.",
  v7: "Built from mining real outcome data (2026-08-07, ~160k scored setups): a 20-MA distance mean-reversion asymmetry (shorts favored moderately above the MA, longs only far below it), a confirmed ADX>=40 short-favoring regime effect, and a short-term-momentum \"grind\" pattern (mild favorable momentum beats strong; mild unfavorable momentum is the single worst bucket found). Promoted to live execution 2026-08-11 (operator request) -- v7 clearing 65% completely on its own is always enough to trade, long or short, independent of session standing or cold-start.",
};

function pct(x: number | null): string {
  return x === null ? "n/a" : `${Math.round(x * 100)}%`;
}

export default function StrategyComparisonPage() {
  const { data: systemState, mutate: mutateState } = useSWR<SystemState>("/api/system/state", fetcher, { refreshInterval: 10000 });
  const { data: comparison } = useSWR<StrategyComparison>("/api/analytics/strategy-comparison", fetcher, { refreshInterval: 30000 });
  const { data: divergence } = useSWR<VersionDivergence>("/api/analytics/version-divergence", fetcher, { refreshInterval: 30000 });
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();

  const active = systemState?.activeStrategyVersion;

  async function switchVersion(version: Version) {
    if (version === active) return;
    if (!(await confirm(`Switch the ACTIVE strategy to ${version.toUpperCase()}? All versions keep shadow-scoring every signal either way -- this only changes which one is allowed to actually place trades.`))) return;
    setSwitching(true);
    setError(null);
    try {
      await apiFetch("/api/system/strategy-version", { method: "POST", body: JSON.stringify({ version }) });
      mutateState();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to switch strategy version");
    } finally {
      setSwitching(false);
    }
  }

  return (
    <div className="space-y-6">
      <Panel title="Strategy Version">
        <p className="mb-4 text-sm text-gray-400">
          v1, v2, v3, v5, v6, and v7 shadow-score every single signal in parallel -- same bars, same market conditions.
          (v4, an experimental ML model, was tried and removed 2026-07-15 -- see the Recommendation Feed&apos;s version
          filter for its historical rows.) Execution doesn&apos;t depend on the single &quot;active&quot; version below --
          that toggle is informational only and hasn&apos;t affected real trades since 2026-07-14.
        </p>
        <p className="mb-4 text-sm text-gray-400">
          Each card&apos;s <strong>Win rate</strong> is restricted to that version&apos;s own <em>decision === taken</em>{" "}
          setups -- the population where versions actually diverge. The &quot;All-setups win rate&quot; line underneath
          blends in every setup this version <em>skipped</em> too; that number converges across v1..v7 almost regardless
          of real judgment quality, since a skipped setup&apos;s hypothetical stop/target is recomputed identically no
          matter which version&apos;s row it&apos;s attached to (see engine/outcomeEvaluator.ts) -- kept only for
          comparison against the session dashboard, not as a measure of version quality.
        </p>
        <p className="mb-4 text-sm text-gray-400">
          As of 2026-08-11, real execution is two rules OR&apos;d together. <strong>(1) Session-best-version gate:</strong>{" "}
          whichever of v1/v2/v3/v6/v7 has the best realized win rate for the <em>current trading session</em> (once it has
          at least 3 resolved outcomes this session) clears 65% alone to trade -- no confirmation from any other version
          needed, and a single new resolved outcome can flip which version is &quot;best,&quot; and therefore which one
          gates, immediately. Before a session has that much evidence yet, this falls back to a plain 2-of-3 majority vote
          among v1/v2/v3 only. <strong>(2) v7-solo:</strong> v7 clearing 65% completely on its own is always enough to
          trade, regardless of session standing or cold-start -- layered on top of rule (1), not a replacement for it. v5
          remains shadow-only, excluded from both rules, pending its own promotion.
        </p>
        {error && <p className="mb-3 text-sm text-bad">{error}</p>}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
          {VERSIONS.map((version) => (
            <button
              key={version}
              onClick={() => switchVersion(version)}
              disabled={switching || version === active}
              className={`flex items-center justify-between rounded-lg border px-4 py-3 text-left transition-colors ${
                active === version ? "border-accent bg-accent/10" : "border-white/10 hover:border-accent/60"
              } disabled:cursor-not-allowed`}
            >
              <div>
                <div className="font-medium text-white">{version.toUpperCase()}</div>
                <div className="text-xs text-gray-400">{VERSION_DESCRIPTIONS[version]}</div>
              </div>
              {active === version && <Badge text="active" tone="good" />}
            </button>
          ))}
        </div>
      </Panel>

      <Panel title="Version Divergence -- the actual head-to-head evidence">
        <p className="mb-4 text-sm text-gray-400">
          v1/v2/v3 score the exact same signal, so when they <em>agree</em> on taken/skipped, a skipped setup&apos;s outcome is
          the same hypothetical trade regardless of version -- not independent evidence. The only real test of &quot;which
          version&apos;s judgment is better&quot; is in the signals where they <em>disagree</em>: one version&apos;s extra
          factors pushed it over the threshold the other one didn&apos;t clear. This shows how those incremental,
          disagreement-only picks actually resolved.
        </p>
        <div className="space-y-3">
          {Object.entries(divergence ?? {}).map(([pairKey, d]) => {
            const [a, b] = pairKey.split("_vs_") as [Version, Version];
            return (
              <div key={pairKey} className="rounded-lg border border-white/10 px-4 py-3 text-sm">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-medium text-white">
                    {a.toUpperCase()} vs {b.toUpperCase()}
                  </span>
                  <span className="text-xs text-gray-500">{d.agreedPairs} signals where both agreed (not counted below)</span>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { label: `${a.toUpperCase()}-only took`, bucket: d.onlyATook },
                    { label: `${b.toUpperCase()}-only took`, bucket: d.onlyBTook },
                  ].map(({ label, bucket }) => (
                    <div key={label} className="rounded border border-white/5 bg-white/5 px-3 py-2">
                      <div className="text-xs text-gray-400">{label}</div>
                      {bucket.n === 0 ? (
                        <div className="mt-1 text-xs text-gray-600">no divergent picks yet</div>
                      ) : (
                        <>
                          <div className="mt-1 flex items-center justify-between">
                            <span className="text-gray-400">Win rate</span>
                            <Badge text={pct(bucket.winRate)} tone={bucket.winRate === null ? "neutral" : bucket.winRate >= 0.5 ? "good" : "bad"} />
                          </div>
                          <div className="mt-1 text-xs text-gray-500">
                            {bucket.win}W / {bucket.loss}L{bucket.pending > 0 ? ` / ${bucket.pending} pending` : ""} (n={bucket.n})
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {SESSION_ORDER.map((session) => {
          const statsByVersion = VERSIONS.map((version) => ({ version, stats: comparison?.[version]?.[session] }));
          const allLoaded = statsByVersion.every((v) => v.stats);
          return (
            <Panel key={session} title={SESSION_LABELS[session]}>
              {!allLoaded ? (
                <p className="text-sm text-gray-500">Loading...</p>
              ) : (
                <div className="space-y-3 text-sm">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {statsByVersion.map(({ version, stats }) =>
                      stats ? (
                        <div key={version} className={`rounded-lg border px-2 py-2 ${active === version ? "border-accent/50 bg-accent/5" : "border-white/10"}`}>
                          <div className="mb-1 flex items-center justify-between">
                            <span className="text-xs font-semibold text-white">{version.toUpperCase()}</span>
                            {active === version && <Badge text="active" tone="good" />}
                          </div>
                          <div className="text-xs text-gray-400">{stats.totalScores} setups scored, {stats.takenCount} taken</div>
                          <div className="mt-1 flex items-center justify-between">
                            <span className="text-gray-400">Win rate (taken)</span>
                            <Badge
                              text={pct(stats.takenWinRate)}
                              tone={stats.takenWinRate === null ? "neutral" : stats.takenWinRate >= 0.5 ? "good" : "bad"}
                            />
                          </div>
                          <div className="mt-1 flex items-center justify-between text-xs text-gray-500">
                            <span>Avg R (taken)</span>
                            <span>{stats.takenAvgRMultiple !== null ? stats.takenAvgRMultiple.toFixed(2) : "n/a"}</span>
                          </div>
                          <div className="mt-1 flex items-center justify-between text-xs text-gray-500">
                            <span>Resolved (taken)</span>
                            <span>{stats.takenResolvedCount}</span>
                          </div>
                          <div className="mt-2 border-t border-white/5 pt-1 text-xs text-gray-600" title="Blended across every scored setup, taken or skipped -- converges across versions almost regardless of judgment quality since the skipped-setup simulation doesn't vary by version.">
                            All-setups win rate: {pct(stats.winRate)} ({stats.resolvedCount} resolved)
                          </div>
                        </div>
                      ) : null
                    )}
                  </div>
                  {(() => {
                    const withRates = statsByVersion.filter((v) => v.stats?.takenWinRate !== null) as { version: Version; stats: NonNullable<(typeof statsByVersion)[number]["stats"]> }[];
                    if (withRates.length < 2) return null;
                    const best = withRates.reduce((a, b) => ((b.stats.takenWinRate ?? 0) > (a.stats.takenWinRate ?? 0) ? b : a));
                    return (
                      <p className="text-xs text-gray-500">
                        {best.version.toUpperCase()} is currently the best-performing version in this session ({pct(best.stats.takenWinRate)} win rate on its own taken setups).
                      </p>
                    );
                  })()}
                </div>
              )}
            </Panel>
          );
        })}
      </div>
    </div>
  );
}
