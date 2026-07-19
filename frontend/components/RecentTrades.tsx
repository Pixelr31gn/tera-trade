"use client";

import { memo } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/api";
import { Trade } from "@/lib/types";
import { Panel } from "@/components/Panel";
import { Badge } from "@/components/Badge";

function fmt(value: number, decimals = 2): string {
  return value.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export const RecentTrades = memo(function RecentTrades() {
  const { data } = useSWR<Trade[]>("/api/trades?status=closed&limit=8", fetcher, { refreshInterval: 15000 });

  return (
    <Panel title="Recent Trades">
      <table>
        <thead>
          <tr>
            <th>Closed</th>
            <th>Symbol</th>
            <th>Side</th>
            <th>Result</th>
            <th>P&L</th>
            <th>Exit</th>
          </tr>
        </thead>
        <tbody>
          {data?.map((t) => {
            const won = (t.pnl ?? 0) >= 0;
            return (
              <tr key={t.id}>
                <td className="whitespace-nowrap text-gray-400">{t.exitTime ? new Date(t.exitTime).toLocaleString() : "-"}</td>
                <td className="font-medium text-white">{t.symbol}</td>
                <td>
                  <Badge text={t.side} tone={t.side === "long" ? "good" : "bad"} />
                </td>
                <td>
                  <Badge text={won ? "WIN" : "LOSS"} tone={won ? "good" : "bad"} />
                </td>
                <td className={`font-mono ${won ? "text-good" : "text-bad"}`}>{t.pnl != null ? `${won ? "+" : ""}$${fmt(t.pnl, 0)}` : "-"}</td>
                <td className="text-gray-400">{t.exitReason ?? "-"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {(!data || data.length === 0) && <p className="py-4 text-center text-sm text-gray-500">No closed trades yet.</p>}
    </Panel>
  );
});
