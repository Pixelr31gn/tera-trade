"use client";

import { useState } from "react";
import useSWR from "swr";
import { apiFetch, fetcher } from "@/lib/api";
import { StrategyComparison, SystemState } from "@/lib/types";
import { Panel } from "@/components/Panel";
import { Badge } from "@/components/Badge";

const SESSION_LABELS: Record<string, string> = { new_york: "New York", london: "London", asian: "Asian" };
const SESSION_ORDER = ["new_york", "london", "asian"];

function pct(x: number | null): string {
  return x === null ? "n/a" : `${Math.round(x * 100)}%`;
}

export default function StrategyComparisonPage() {
  const { data: systemState, mutate: mutateState } = useSWR<SystemState>("/api/system/state", fetcher, { refreshInterval: 10000 });
  const { data: comparison } = useSWR<StrategyComparison>("/api/analytics/strategy-comparison", fetcher, { refreshInterval: 30000 });
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = systemState?.activeStrategyVersion;

  async function switchVersion(version: "v1" | "v2") {
    if (version === active) return;
    if (!confirm(`Switch the ACTIVE strategy to ${version.toUpperCase()}? Both versions keep shadow-scoring every signal either way -- this only changes which one is allowed to actually place trades.`)) return;
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
          v1 and v2 shadow-score every single signal in parallel -- same bars, same market conditions -- so the numbers below
          are a true apples-to-apples comparison, not two different time periods. Only the ACTIVE version&apos;s setups are
          ever allowed to actually place a trade; the other keeps quietly accumulating comparison data in the background.
        </p>
        {error && <p className="mb-3 text-sm text-bad">{error}</p>}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {(["v1", "v2"] as const).map((version) => (
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
                <div className="text-xs text-gray-400">
                  {version === "v1"
                    ? "Baseline: trend, momentum, volatility, news, historical/opening-range edge."
                    : "v1 + marketStructureEdge and liquidityEdge, added from real session-performance data."}
                </div>
              </div>
              {active === version && <Badge text="active" tone="good" />}
            </button>
          ))}
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {SESSION_ORDER.map((session) => {
          const v1 = comparison?.v1?.[session];
          const v2 = comparison?.v2?.[session];
          return (
            <Panel key={session} title={SESSION_LABELS[session]}>
              {!v1 || !v2 ? (
                <p className="text-sm text-gray-500">Loading...</p>
              ) : (
                <div className="space-y-3 text-sm">
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      { version: "v1" as const, stats: v1 },
                      { version: "v2" as const, stats: v2 },
                    ].map(({ version, stats }) => (
                      <div key={version} className={`rounded-lg border px-3 py-2 ${active === version ? "border-accent/50 bg-accent/5" : "border-white/10"}`}>
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
                    ))}
                  </div>
                  {v1.winRate !== null && v2.winRate !== null && (
                    <p className="text-xs text-gray-500">
                      {v2.winRate > v1.winRate
                        ? `v2 is currently outperforming v1 by ${Math.round((v2.winRate - v1.winRate) * 100)} points in this session.`
                        : v2.winRate < v1.winRate
                          ? `v1 is currently outperforming v2 by ${Math.round((v1.winRate - v2.winRate) * 100)} points in this session.`
                          : "v1 and v2 are performing identically so far in this session."}
                    </p>
                  )}
                </div>
              )}
            </Panel>
          );
        })}
      </div>
    </div>
  );
}
