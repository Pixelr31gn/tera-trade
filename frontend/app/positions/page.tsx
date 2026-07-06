"use client";

import useSWR from "swr";
import { apiFetch, fetcher } from "@/lib/api";
import { Position, SystemState } from "@/lib/types";
import { Panel } from "@/components/Panel";
import { Badge } from "@/components/Badge";

export default function PositionsPage() {
  const { data: positions, mutate } = useSWR<Position[]>("/api/positions", fetcher, { refreshInterval: 5000 });
  const { data: systemState } = useSWR<SystemState>("/api/system/state", fetcher, { refreshInterval: 10000 });

  async function closePosition(tradeId: number, symbol: string) {
    if (!confirm(`Close the open ${symbol} position? This clicks "Close Position" on your real account.`)) return;
    try {
      await apiFetch(`/api/positions/${tradeId}/close`, { method: "POST" });
      mutate();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to close position");
    }
  }

  return (
    <div className="space-y-6">
      <Panel
        title="Open Positions"
        action={<Badge text={`broker: ${systemState?.brokerKind ?? "..."}`} tone="neutral" />}
      >
        <table>
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Side</th>
              <th>Qty</th>
              <th>Entry</th>
              <th>Stop</th>
              <th>Target</th>
              <th>Strategy</th>
              <th>Score</th>
              <th>Explanation</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {positions?.map((p) => (
              <tr key={p.tradeId}>
                <td className="font-medium text-white">{p.symbol}</td>
                <td>
                  <Badge text={p.side} tone={p.side === "long" ? "good" : "bad"} />
                </td>
                <td>{p.quantity}</td>
                <td>{p.entryPrice}</td>
                <td className="text-bad">{p.stopPrice}</td>
                <td className="text-good">{p.takeProfitPrice ?? "-"}</td>
                <td className="text-gray-400">{p.strategyId}</td>
                <td>{p.score !== null ? `${(p.score * 100).toFixed(0)}%` : "-"}</td>
                <td className="max-w-xl text-gray-300">{p.explanation}</td>
                <td>
                  <button
                    onClick={() => closePosition(p.tradeId, p.symbol)}
                    className="whitespace-nowrap rounded-md bg-bad/20 px-2.5 py-1 text-xs font-medium text-bad hover:bg-bad/30"
                  >
                    Close
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {(!positions || positions.length === 0) && <p className="py-6 text-center text-sm text-gray-500">No open positions.</p>}
      </Panel>
    </div>
  );
}
