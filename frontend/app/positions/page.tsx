"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/api";
import { Position, SystemState } from "@/lib/types";
import { Panel } from "@/components/Panel";
import { Badge } from "@/components/Badge";

export default function PositionsPage() {
  const { data: positions } = useSWR<Position[]>("/api/positions", fetcher, { refreshInterval: 5000 });
  const { data: systemState } = useSWR<SystemState>("/api/system/state", fetcher, { refreshInterval: 10000 });

  return (
    <div className="space-y-6">
      <Panel
        title="Open Positions"
        action={<Badge text={`broker: ${systemState?.broker_kind ?? "..."}`} tone="neutral" />}
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
            </tr>
          </thead>
          <tbody>
            {positions?.map((p) => (
              <tr key={p.trade_id}>
                <td className="font-medium text-white">{p.symbol}</td>
                <td>
                  <Badge text={p.side} tone={p.side === "long" ? "good" : "bad"} />
                </td>
                <td>{p.quantity}</td>
                <td>{p.entry_price}</td>
                <td className="text-bad">{p.stop_price}</td>
                <td className="text-good">{p.take_profit_price ?? "-"}</td>
                <td className="text-gray-400">{p.strategy_id}</td>
                <td>{p.score !== null ? `${(p.score * 100).toFixed(0)}%` : "-"}</td>
                <td className="max-w-xl text-gray-300">{p.explanation}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {(!positions || positions.length === 0) && <p className="py-6 text-center text-sm text-gray-500">No open positions.</p>}
      </Panel>
    </div>
  );
}
