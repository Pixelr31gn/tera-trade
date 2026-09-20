"use client";

import { useState } from "react";
import useSWR from "swr";
import { apiFetch, fetcher } from "@/lib/api";
import { Position, SystemState } from "@/lib/types";
import { Panel } from "@/components/Panel";
import { Badge } from "@/components/Badge";
import { useConfirm } from "@/components/ConfirmDialog";

export default function PositionsPage() {
  const { data: positions, mutate } = useSWR<Position[]>("/api/positions", fetcher, { refreshInterval: 5000 });
  const { data: systemState } = useSWR<SystemState>("/api/system/state", fetcher, { refreshInterval: 10000 });
  const confirm = useConfirm();
  const [error, setError] = useState<string | null>(null);

  async function closePosition(tradeId: number, symbol: string) {
    if (!(await confirm(`Close the open ${symbol} position? This clicks "Close Position" on your real account.`))) return;
    setError(null);
    try {
      await apiFetch(`/api/positions/${tradeId}/close`, { method: "POST" });
      mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to close position");
    }
  }

  // Short label for each brokerKind -- matters now that positions from more
  // than one live broker (TopstepX, Tradesea) can appear in the same list.
  function brokerLabel(brokerKind: string): string {
    if (brokerKind === "browser_control") return "TopstepX";
    if (brokerKind === "tradesea_browser_control") return "Tradesea";
    if (brokerKind === "simulated") return "paper";
    return brokerKind;
  }

  async function letItRide(tradeId: number, symbol: string) {
    if (
      !(await confirm(
        `Let the ${symbol} position ride past its take-profit target? This cancels the automatic take-profit close -- from then on, only the trailing stop (or a manual close) will end this trade. This can't be undone from here.`
      ))
    )
      return;
    setError(null);
    try {
      await apiFetch(`/api/positions/${tradeId}/let-it-ride`, { method: "POST" });
      mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to enable let-it-ride");
    }
  }

  return (
    <div className="space-y-6">
      <Panel
        title="Open Positions"
        action={<Badge text={`broker: ${systemState?.brokerKind ?? "..."}`} tone="neutral" />}
      >
        {error && <p className="mb-3 text-sm text-bad">{error}</p>}
        <table>
          <thead>
            <tr>
              <th>Broker</th>
              <th>Symbol</th>
              <th>Side</th>
              <th>Qty</th>
              <th>Entry</th>
              <th>Stop</th>
              <th>Target</th>
              <th>Strategy</th>
              <th>Score</th>
              <th>Protection</th>
              <th>Explanation</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {positions?.map((p) => (
              <tr key={p.tradeId}>
                <td>
                  <Badge text={brokerLabel(p.brokerKind)} tone="neutral" />
                </td>
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
                <td>
                  <div className="flex gap-1">
                    <Badge text={p.trailingStopPlaced ? "trailing" : "hard stop"} tone={p.trailingStopPlaced ? "good" : "neutral"} />
                    <Badge text={p.takeProfitOrderPlaced ? "TP order live" : "TP: software only"} tone={p.takeProfitOrderPlaced ? "good" : "warn"} />
                    {p.letItRide && <Badge text="riding" tone="warn" />}
                  </div>
                </td>
                <td className="max-w-xl text-gray-300">{p.explanation}</td>
                <td>
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => closePosition(p.tradeId, p.symbol)}
                      className="whitespace-nowrap rounded-md bg-bad/20 px-2.5 py-1 text-xs font-medium text-bad hover:bg-bad/30"
                    >
                      Close
                    </button>
                    {!p.letItRide && (
                      <button
                        onClick={() => letItRide(p.tradeId, p.symbol)}
                        className="whitespace-nowrap rounded-md bg-warn/20 px-2.5 py-1 text-xs font-medium text-warn hover:bg-warn/30"
                      >
                        Let it ride
                      </button>
                    )}
                  </div>
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
