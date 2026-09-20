"use client";

import { useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/api";
import { Trade } from "@/lib/types";
import { Panel } from "@/components/Panel";
import { Badge } from "@/components/Badge";

// Prisma Decimal fields come back over JSON as strings -- see
// RecentTrades.tsx's fmt() comment for the concrete 2026-08-13 crash this
// pattern guards against. entryTime/exitTime are plain ISO strings either
// way, not Decimals, but t.pnl below still needs Number() for the same reason.
function formatDuration(entryTime: string, exitTime: string | null): string {
  if (!exitTime) return "-";
  const ms = new Date(exitTime).getTime() - new Date(entryTime).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (totalMinutes > 0) return `${totalMinutes}m`;
  return `${Math.round(ms / 1000)}s`;
}

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
      <div className="space-y-3">
        {data?.map((t) => {
          const won = t.status === "closed" && t.pnl != null ? Number(t.pnl) >= 0 : null;
          return (
            <div key={t.id} className="rounded-lg border border-white/10 overflow-hidden">
              <div className="flex flex-wrap items-start justify-between gap-4 bg-white/5 px-3 py-2 text-xs">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="whitespace-nowrap text-gray-400">{new Date(t.entryTime).toLocaleString()}</span>
                  <span className="font-medium text-white">{t.symbol}</span>
                  <Badge text={t.side} tone={t.side === "long" ? "good" : "bad"} />
                  <span className="font-mono text-gray-300">
                    qty {t.quantity} @ {t.entryPrice}
                  </span>
                  <span className="font-mono text-bad">SL {t.stopPrice}</span>
                  <span className="font-mono text-good">TP {t.takeProfitPrice ?? "-"}</span>
                  <span className="font-mono text-gray-300">exit {t.exitPrice ?? "-"}</span>
                  <span className="whitespace-nowrap text-gray-400">{formatDuration(t.entryTime, t.exitTime)}</span>
                  <span className="text-gray-400">{t.exitReason ?? "-"}</span>
                  {won !== null && <Badge text={won ? "WIN" : "LOSS"} tone={won ? "good" : "bad"} />}
                  {t.pnl != null && (
                    <span className={`font-mono ${won ? "text-good" : "text-bad"}`}>${Number(t.pnl).toFixed(2)}</span>
                  )}
                  <span className="text-gray-400">
                    MAE/MFE {t.mae != null ? Number(t.mae).toFixed(2) : "-"}/{t.mfe != null ? Number(t.mfe).toFixed(2) : "-"}
                  </span>
                  <span className="text-gray-400">
                    {t.regimeTrendAtEntry}/{t.regimeVolAtEntry}
                  </span>
                </div>
                <div className="max-w-md text-right text-gray-300">{t.explanation}</div>
              </div>
            </div>
          );
        })}
      </div>
      {(!data || data.length === 0) && <p className="py-6 text-center text-sm text-gray-500">No trades yet.</p>}
    </Panel>
  );
}
