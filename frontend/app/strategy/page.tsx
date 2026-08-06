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
const VERSIONS = ["v1", "v2", "v3", "v5", "v6"] as const;
type Version = (typeof VERSIONS)[number];

const VERSION_DESCRIPTIONS: Record<Version, string> = {
  v1: "Baseline: trend, momentum, volatility, news, historical/opening-range, risk/reward, Fibonacci direction, and points-per-minute edge.",
  v2: "v1 + marketStructureEdge and liquidityEdge, added from real session-performance data.",
  v3: "0-100 confidence score: EMA50 trend (20), ADX strength (20), ATR volatility (15), volume vs 20-bar avg (15), RSI momentum (10), price structure (20) -- scored for both directions, requires conviction margin, adjusted by recent similar-setup performance, risk/reward shape, Fibonacci direction, and points-per-minute.",
  v5: "Built from mining real outcome data rather than intuition (2026-07-21): ADX-regime asymmetry (very strong trend favors shorts, hurts longs), weak-trend fade (fading a weak trend beat following it), and price-action normalcy (dramatic-looking candles underperformed normal ones). Shadow-scored only -- not yet a consensus voter (see engine/loop.ts's SHADOW_ONLY_VERSIONS).",
  v6: "An ensemble, not an independently mined pattern set (2026-08-02): averages v1/v2/v3/v5's own probabilities by logit, plus a confirmation bonus when its own trend-pullback-fib setup rules (rising/falling 15m trend, 40-60% Fibonacci pullback, 5m break) independently agree. Shadow-scored only -- same promotion bar as v5, not skipped for being newer.",
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
          v1, v2, v3, and v5 shadow-score every single signal in parallel -- same bars, same market conditions -- so the
          numbers below are a true apples-to-apples comparison, not different time periods. (v4, an experimental ML model,
          was tried and removed 2026-07-15 -- see the Recommendation Feed&apos;s version filter for its historical rows.)
          Execution doesn&apos;t depend on a single &quot;active&quot; version below -- the toggle is informational only.
          As of 2026-08-02, both paper and live take a trade only when{" "}
          <strong>v6 independently clears 65% AND at least one of v1/v2/v3/v5 also clears 65%</strong> -- v6 (an ensemble of
          the other four plus its own setup-rule bonus, not an independently mined model like v5) is now the mandatory
          anchor, the same role v5 held in the rule before it. v6&apos;s own weight is unvalidated -- zero resolved live
          trades exist behind it yet.
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
                          <div className="text-xs text-gray-400">{stats.totalScores} setups</div>
                          <div className="mt-1 flex items-center justify-between">
                            <span className="text-gray-400">Win rate</span>
                            <Badge text={pct(stats.winRate)} tone={stats.winRate === null ? "neutral" : stats.winRate >= 0.5 ? "good" : "bad"} />
                          </div>
                          <div className="mt-1 flex items-center justify-between text-xs text-gray-500">
                            <span>Avg R</span>
                            <span>{stats.avgRMultiple !== null ? stats.avgRMultiple.toFixed(2) : "n/a"}</span>
                          </div>
                          <div className="mt-1 flex items-center justify-between text-xs text-gray-500">
                            <span>Resolved</span>
                            <span>{stats.resolvedCount}</span>
                          </div>
                        </div>
                      ) : null
                    )}
                  </div>
                  {(() => {
                    const withRates = statsByVersion.filter((v) => v.stats?.winRate !== null) as { version: Version; stats: NonNullable<(typeof statsByVersion)[number]["stats"]> }[];
                    if (withRates.length < 2) return null;
                    const best = withRates.reduce((a, b) => ((b.stats.winRate ?? 0) > (a.stats.winRate ?? 0) ? b : a));
                    return (
                      <p className="text-xs text-gray-500">
                        {best.version.toUpperCase()} is currently the best-performing version in this session ({pct(best.stats.winRate)} win rate).
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
