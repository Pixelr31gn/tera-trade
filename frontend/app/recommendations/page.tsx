"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/api";
import { RecommendationScore } from "@/lib/types";
import { Panel } from "@/components/Panel";
import { Badge } from "@/components/Badge";
import { DecidingVersionPanel, useDecidingVersion } from "@/components/DecidingVersionPanel";

const VERSION_FILTERS = ["all", "v1", "v2", "v3", "v4", "v5", "v6", "v7"] as const;
// v5/v6 (2026-07-21 / 2026-08-02) are deliberately NOT included here -- the
// "all three agree" completeness badge below stays v1/v2/v3 only (v6 is
// scored on every signal and, as of 2026-08-06, is what actually gates
// execution -- see the explanatory text below -- but it's still not one of
// the three grouped "real strategy" columns this badge tracks). Filter to
// the "V5"/"V6" tabs above to see their rows on their own.
const REAL_VERSIONS = ["v1", "v2", "v3"] as const;

interface SignalGroup {
  key: string;
  time: string;
  symbol: string;
  strategyId: string;
  side: string;
  quantity: number;
  entryPrice: number;
  stopPrice: number;
  takeProfitPrice: number;
  byVersion: Partial<Record<string, RecommendationScore>>;
}

// Same signal = same time/symbol/side/strategyId -- v1/v2/v3 all shadow-score
// it, so grouping them back together is what actually lets you see "did all
// three fire for this setup" at a glance, instead of a flat chronological
// list where they can land many rows apart from each other (2026-07-15
// operator request).
function groupSignals(rows: RecommendationScore[]): SignalGroup[] {
  const map = new Map<string, SignalGroup>();
  for (const s of rows) {
    const key = `${s.time}|${s.symbol}|${s.side}|${s.strategyId}`;
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        time: s.time,
        symbol: s.symbol,
        strategyId: s.strategyId,
        side: s.side,
        quantity: s.quantity,
        entryPrice: s.entryPrice,
        stopPrice: s.stopPrice,
        takeProfitPrice: s.takeProfitPrice,
        byVersion: {},
      };
      map.set(key, g);
    }
    g.byVersion[s.strategyVersion] = s;
  }
  return [...map.values()].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
}

/** A version's badge, plus a "decides" tag when that version's score is what triggers trades right now. */
function VersionBadge({ version, decides }: { version: RecommendationScore["strategyVersion"]; decides: boolean }) {
  return (
    <span className="flex items-center gap-1">
      <Badge text={version} tone={["v3", "v4", "v5", "v6", "v7"].includes(version) ? "good" : "neutral"} />
      {decides && <Badge text="decides" tone="warn" />}
    </span>
  );
}

export default function RecommendationsPage() {
  const { data } = useSWR<RecommendationScore[]>("/api/recommendations?limit=300", fetcher, { refreshInterval: 8000 });
  const { data: deciding } = useDecidingVersion();
  const decides = (version: RecommendationScore["strategyVersion"]) => deciding?.countingVersions.includes(version) ?? false;
  const [versionFilter, setVersionFilter] = useState<(typeof VERSION_FILTERS)[number]>("all");

  // Rebuilds the Map/sort only when the underlying data or filter actually
  // changes, not on every 8s poll tick that returns identical rows.
  const filtered = useMemo(
    () => data?.filter((s) => versionFilter === "all" || s.strategyVersion === versionFilter),
    [data, versionFilter]
  );
  const groups = useMemo(() => (versionFilter === "all" ? groupSignals(filtered ?? []) : null), [versionFilter, filtered]);
  const flatRows = versionFilter !== "all" ? filtered : null;

  return (
    <div className="space-y-6">
      <DecidingVersionPanel />
      <Panel
        title="Recommendation Feed"
        action={
          <div className="flex gap-1">
            {VERSION_FILTERS.map((v) => (
              <button
                key={v}
                onClick={() => setVersionFilter(v)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  versionFilter === v ? "bg-accent/20 text-accent" : "text-gray-400 hover:text-white"
                }`}
              >
                {v === "all" ? "All" : v.toUpperCase()}
              </button>
            ))}
          </div>
        }
      >
        <p className="mb-3 text-xs text-gray-500">
          Every signal is scored by v1/v2/v3/v5/v6/v7, but only the version(s) tagged <strong>decides</strong> can
          trigger a trade -- see <strong>Deciding now</strong> above: this session&apos;s best-performing version alone
          at 65%+, or a v1/v2/v3 majority vote while the session is still warming up. &quot;Taken&quot; means that
          version&apos;s own score cleared its threshold, not that a trade happened. A deciding score still has to pass
          the Tilt, your chart box, the daily plan and the risk checks; a row only links to a trade # once all of that
          clears.
        </p>

        {groups && (
          <div className="space-y-3">
            {groups.map((g) => {
              return (
                <div key={g.key} className="rounded-lg border border-white/10 overflow-hidden">
                  <div className="flex flex-wrap items-center justify-between gap-2 bg-white/5 px-3 py-2 text-xs">
                    <div className="flex items-center gap-3">
                      <span className="whitespace-nowrap text-gray-400">{new Date(g.time).toLocaleString()}</span>
                      <span className="font-medium text-white">{g.symbol}</span>
                      <span className="text-gray-400">{g.strategyId}</span>
                      <Badge text={g.side} tone={g.side === "long" ? "good" : "bad"} />
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-gray-300">
                        qty {g.quantity} @ {g.entryPrice.toFixed(2)}
                      </span>
                      <span className="font-mono text-bad">SL {g.stopPrice.toFixed(2)}</span>
                      <span className="font-mono text-good">TP {g.takeProfitPrice.toFixed(2)}</span>
                      <div className="flex gap-1">
                        {REAL_VERSIONS.map((v) => (
                          <Badge key={v} text={v} tone={g.byVersion[v] ? "good" : "bad"} />
                        ))}
                      </div>
                    </div>
                  </div>
                  <table>
                    <tbody>
                      {Object.values(g.byVersion)
                        .filter((s): s is RecommendationScore => !!s)
                        .sort((a, b) => a.strategyVersion.localeCompare(b.strategyVersion))
                        .map((s) => (
                          <tr key={s.id}>
                            <td className="w-28">
                              <VersionBadge version={s.strategyVersion} decides={decides(s.strategyVersion)} />
                            </td>
                            <td className="w-16">{(s.probability * 100).toFixed(1)}%</td>
                            <td className="w-40">
                              {s.decision !== "taken" ? (
                                <Badge text="skipped" tone="neutral" />
                              ) : s.tradeId !== null ? (
                                <Badge text={`trade #${s.tradeId}`} tone="good" />
                              ) : (
                                <Badge text="taken, not executed" tone="warn" />
                              )}
                            </td>
                            <td className="text-gray-300">{s.explanation}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              );
            })}
            {groups.length === 0 && <p className="py-6 text-center text-sm text-gray-500">No scored setups yet.</p>}
          </div>
        )}

        {flatRows && (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Symbol</th>
                <th>Strategy</th>
                <th>Ver</th>
                <th>Side</th>
                <th>Score</th>
                <th>Decision</th>
                <th>Qty</th>
                <th>Entry</th>
                <th>Stop</th>
                <th>Target</th>
                <th>Explanation</th>
              </tr>
            </thead>
            <tbody>
              {flatRows.map((s) => (
                <tr key={s.id}>
                  <td className="whitespace-nowrap text-gray-400">{new Date(s.time).toLocaleString()}</td>
                  <td className="font-medium text-white">{s.symbol}</td>
                  <td className="text-gray-400">{s.strategyId}</td>
                  <td>
                    <VersionBadge version={s.strategyVersion} decides={decides(s.strategyVersion)} />
                  </td>
                  <td>
                    <Badge text={s.side} tone={s.side === "long" ? "good" : "bad"} />
                  </td>
                  <td>{(s.probability * 100).toFixed(1)}%</td>
                  <td>
                    {s.decision !== "taken" ? (
                      <Badge text="skipped" tone="neutral" />
                    ) : s.tradeId !== null ? (
                      <Badge text={`trade #${s.tradeId}`} tone="good" />
                    ) : (
                      <Badge text="taken, not executed" tone="warn" />
                    )}
                  </td>
                  <td className="font-mono text-gray-300">{s.quantity}</td>
                  <td className="font-mono text-gray-300">{s.entryPrice.toFixed(2)}</td>
                  <td className="font-mono text-bad">{s.stopPrice.toFixed(2)}</td>
                  <td className="font-mono text-good">{s.takeProfitPrice.toFixed(2)}</td>
                  <td className="max-w-xl text-gray-300">{s.explanation}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {flatRows && flatRows.length === 0 && <p className="py-6 text-center text-sm text-gray-500">No scored setups yet.</p>}
      </Panel>
    </div>
  );
}
