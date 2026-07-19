"use client";

import { useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/api";
import { Trade } from "@/lib/types";
import { Panel } from "@/components/Panel";
import { Badge } from "@/components/Badge";

export default function JournalPage() {
  const [status, setStatus] = useState<"all" | "open" | "closed">("closed");
  const query = status === "all" ? "" : `&status=${status}`;
  const { data } = useSWR<Trade[]>(`/api/trades?limit=300${query}`, fetcher, { refreshInterval: 15000 });

  return (
    <Panel
      title="Trade Journal"
      action={
        <div className="flex gap-1">
          {(["closed", "open", "all"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={`rounded px-2 py-1 text-xs ${status === s ? "bg-accent text-white" : "text-gray-400 hover:text-white"}`}
            >
              {s}
            </button>
          ))}
        </div>
      }
    >
      <table>
        <thead>
          <tr>
            <th>Entry</th>
            <th>Symbol</th>
            <th>Side</th>
            <th>Qty</th>
            <th>Entry Px</th>
            <th>Exit Px</th>
            <th>Exit Reason</th>
            <th>Result</th>
            <th>P&L</th>
            <th>MAE/MFE</th>
            <th>Regime</th>
            <th>Explanation</th>
          </tr>
        </thead>
        <tbody>
          {data?.map((t) => (
            <tr key={t.id}>
              <td className="whitespace-nowrap text-gray-400">{new Date(t.entryTime).toLocaleString()}</td>
              <td className="font-medium text-white">{t.symbol}</td>
              <td>
                <Badge text={t.side} tone={t.side === "long" ? "good" : "bad"} />
              </td>
              <td>{t.quantity}</td>
              <td>{t.entryPrice}</td>
              <td>{t.exitPrice ?? "-"}</td>
              <td className="text-gray-400">{t.exitReason ?? "-"}</td>
              <td>
                {t.status === "closed" && t.pnl != null && (
                  <Badge text={t.pnl >= 0 ? "WIN" : "LOSS"} tone={t.pnl >= 0 ? "good" : "bad"} />
                )}
              </td>
              <td className={(t.pnl ?? 0) >= 0 ? "text-good" : "text-bad"}>{t.pnl != null ? `$${t.pnl.toFixed(2)}` : "-"}</td>
              <td className="text-gray-400">
                {t.mfe != null ? t.mfe.toFixed(2) : "-"} / {t.mae != null ? t.mae.toFixed(2) : "-"}
              </td>
              <td className="text-gray-400">
                {t.regimeTrendAtEntry}/{t.regimeVolAtEntry}
              </td>
              <td className="max-w-xl text-gray-300">{t.explanation}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {(!data || data.length === 0) && <p className="py-6 text-center text-sm text-gray-500">No trades yet.</p>}
    </Panel>
  );
}
