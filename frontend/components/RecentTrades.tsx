"use client";

import { memo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { fetcher } from "@/lib/api";
import { Trade } from "@/lib/types";
import { Panel } from "@/components/Panel";
import { Badge } from "@/components/Badge";

// Prisma Decimal fields (entryPrice, stopPrice, takeProfitPrice, pnl) come
// back over JSON as strings, not numbers, despite lib/types.ts's Trade
// interface claiming `number` -- confirmed live 2026-08-13 via a hard crash
// in journal/page.tsx's equivalent t.pnl.toFixed(2) call ("toFixed is not a
// function" on a string). Number.prototype.toLocaleString would have thrown
// the same way here, except String.prototype ALSO has a toLocaleString
// (basically toString(), silently ignoring the formatting options) -- so
// this one didn't crash, it just silently rendered raw unformatted strings
// like "7780.52528925" instead of "7,780.53". Number(value) coerces either
// shape correctly.
function fmt(value: number | string, decimals = 2): string {
  return Number(value).toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

const LIMIT_OPTIONS = [8, 25, 50, 100] as const;

export const RecentTrades = memo(function RecentTrades() {
  const [limit, setLimit] = useState<(typeof LIMIT_OPTIONS)[number]>(8);
  const { data } = useSWR<Trade[]>(`/api/trades?status=closed&limit=${limit}`, fetcher, { refreshInterval: 15000 });

  return (
    <Panel
      title="Recent Trades"
      action={
        <div className="flex items-center gap-3">
          <select
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value) as (typeof LIMIT_OPTIONS)[number])}
            className="rounded border border-border bg-background px-2 py-1 text-xs text-gray-300"
          >
            {LIMIT_OPTIONS.map((n) => (
              <option key={n} value={n}>
                Last {n}
              </option>
            ))}
          </select>
          <Link href="/journal" className="text-xs text-accent hover:underline">
            View all &rarr;
          </Link>
        </div>
      }
    >
      <table>
        <thead>
          <tr>
            <th>Closed</th>
            <th>Symbol</th>
            <th>Side</th>
            <th>Entry</th>
            <th>Stop</th>
            <th>Target</th>
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
                <td className="font-mono text-gray-300">{fmt(t.entryPrice)}</td>
                <td className="font-mono text-bad">{fmt(t.stopPrice)}</td>
                <td className="font-mono text-good">{t.takeProfitPrice != null ? fmt(t.takeProfitPrice) : "-"}</td>
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
