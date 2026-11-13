"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/api";
import { MaProximityStatus } from "@/lib/types";

/**
 * 20 MA entry checklist (2026-11-11, operator: "add that checklist to the
 * dashboard"). Shows, per symbol, the same multi-timeframe check the entry
 * gate runs (backend engine/maProximity.ts): price must be within N ticks of
 * the 20 MA on at least 2 of 1m/5m/15m/30m/1h. Refreshes every 10s.
 */
export function MaProximityPanel() {
  const { data, error } = useSWR<MaProximityStatus>("/api/analytics/ma-proximity", fetcher, { refreshInterval: 10000 });

  if (error) {
    return <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-gray-400">20 MA checklist: unavailable</div>;
  }
  if (!data) {
    return <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-gray-500">20 MA checklist: loading...</div>;
  }

  const first = data.symbols[0];
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 backdrop-blur-xl">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs uppercase tracking-wide text-gray-400">20 MA checklist</span>
        {first && (
          <span className="text-sm text-gray-300">
            Entry needs price within {data.symbols.map((s) => `${s.symbol} ${s.maxTicks}`).join(" / ")} ticks of {first.minNear}+ of these 20 MAs
          </span>
        )}
        <span className="ml-auto text-xs text-gray-500">as of {new Date(data.at).toLocaleTimeString()}</span>
      </div>
      <div className="mt-2 grid gap-2 md:grid-cols-3">
        {data.symbols.map((s) => (
          <div key={s.symbol} className={`rounded-xl border px-3 py-2 ${s.allowed ? "border-good/40 bg-good/10" : "border-white/10 bg-black/20"}`}>
            <div className="flex items-baseline justify-between">
              <span className="font-semibold text-white">{s.symbol}</span>
              <span className={`text-xs font-semibold ${s.allowed ? "text-good" : "text-gray-400"}`}>
                {s.rows.length === 0 ? "no data" : `${s.nearCount}/${s.rows.length} in range ${s.allowed ? "-- entry allowed" : "-- blocked"}`}
              </span>
            </div>
            {s.price !== null && <div className="text-xs text-gray-500">price {s.price.toFixed(2)}</div>}
            {s.rows.length === 0 ? (
              <div className="mt-1 text-xs text-warn">{s.reason.replace(/^20 MA proximity: /, "")}</div>
            ) : (
              <ul className="mt-1 space-y-0.5 text-sm">
                {s.rows.map((r) => (
                  <li key={r.minutes} className="flex items-center gap-2">
                    <span className={`w-4 text-center ${r.near ? "text-good" : "text-gray-600"}`}>{r.near ? "✓" : "✗"}</span>
                    <span className="w-8 text-gray-300">{r.label}</span>
                    <span className="w-20 text-right tabular-nums text-gray-400">{r.ma === null ? "n/a" : r.ma.toFixed(2)}</span>
                    <span className={`w-16 text-right tabular-nums ${r.near ? "text-good" : "text-gray-500"}`}>
                      {r.ticks === null ? "" : `${Math.round(r.ticks)} ticks`}
                    </span>
                    {r.source === "chart" && <span className="text-xs text-accent">TopstepX</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
