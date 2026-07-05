"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/api";
import { RecommendationScore } from "@/lib/types";
import { Panel } from "@/components/Panel";
import { Badge } from "@/components/Badge";

export default function RecommendationsPage() {
  const { data } = useSWR<RecommendationScore[]>("/api/recommendations?limit=150", fetcher, { refreshInterval: 8000 });

  return (
    <Panel title="Recommendation Feed">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Symbol</th>
            <th>Strategy</th>
            <th>Side</th>
            <th>Score</th>
            <th>Decision</th>
            <th>Explanation</th>
          </tr>
        </thead>
        <tbody>
          {data?.map((s, i) => (
            <tr key={i}>
              <td className="whitespace-nowrap text-gray-400">{new Date(s.time).toLocaleString()}</td>
              <td className="font-medium text-white">{s.symbol}</td>
              <td className="text-gray-400">{s.strategyId}</td>
              <td>
                <Badge text={s.side} tone={s.side === "long" ? "good" : "bad"} />
              </td>
              <td>{(s.probability * 100).toFixed(0)}%</td>
              <td>
                <Badge text={s.decision} tone={s.decision === "taken" ? "good" : "neutral"} />
              </td>
              <td className="max-w-xl text-gray-300">{s.explanation}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {(!data || data.length === 0) && <p className="py-6 text-center text-sm text-gray-500">No scored setups yet.</p>}
    </Panel>
  );
}
