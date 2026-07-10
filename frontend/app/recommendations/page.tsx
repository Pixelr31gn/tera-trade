"use client";

import { useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/api";
import { RecommendationScore } from "@/lib/types";
import { Panel } from "@/components/Panel";
import { Badge } from "@/components/Badge";

const VERSION_FILTERS = ["all", "v1", "v2"] as const;

export default function RecommendationsPage() {
  const { data } = useSWR<RecommendationScore[]>("/api/recommendations?limit=300", fetcher, { refreshInterval: 8000 });
  const [versionFilter, setVersionFilter] = useState<(typeof VERSION_FILTERS)[number]>("all");

  const rows = data?.filter((s) => versionFilter === "all" || s.strategyVersion === versionFilter);

  return (
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
        Every signal is shadow-scored by both strategy versions -- see the Strategy page to compare their performance and switch which one executes.
      </p>
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
          {rows?.map((s, i) => (
            <tr key={i}>
              <td className="whitespace-nowrap text-gray-400">{new Date(s.time).toLocaleString()}</td>
              <td className="font-medium text-white">{s.symbol}</td>
              <td className="text-gray-400">{s.strategyId}</td>
              <td>
                <Badge text={s.strategyVersion} tone={s.strategyVersion === "v2" ? "warn" : "neutral"} />
              </td>
              <td>
                <Badge text={s.side} tone={s.side === "long" ? "good" : "bad"} />
              </td>
              <td>{(s.probability * 100).toFixed(0)}%</td>
              <td>
                <Badge text={s.decision} tone={s.decision === "taken" ? "good" : "neutral"} />
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
      {(!rows || rows.length === 0) && <p className="py-6 text-center text-sm text-gray-500">No scored setups yet.</p>}
    </Panel>
  );
}
