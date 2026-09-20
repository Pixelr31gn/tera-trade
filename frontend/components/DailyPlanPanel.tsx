"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/api";
import { DailyPlanSymbolView } from "@/lib/types";
import { Panel } from "@/components/Panel";
import { Badge } from "@/components/Badge";

const STATUS_LABEL: Record<DailyPlanSymbolView["status"], string> = {
  no_plan: "No plan set",
  below_support: "Below support (breakdown)",
  testing_support: "Testing support",
  mid_range: "Mid-range",
  testing_resistance: "Testing resistance",
  above_resistance: "Above resistance (breakout)",
};

const STATUS_TONE: Record<DailyPlanSymbolView["status"], "good" | "bad" | "warn" | "neutral"> = {
  no_plan: "neutral",
  below_support: "bad",
  testing_support: "warn",
  mid_range: "neutral",
  testing_resistance: "warn",
  above_resistance: "good",
};

function fmt(n: number, decimals = 2): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function DailyPlanPanel() {
  const { data } = useSWR<Record<string, DailyPlanSymbolView>>("/api/daily-plan", fetcher, { refreshInterval: 15000 });
  const symbols = data ? Object.keys(data) : [];

  return (
    <Panel title="Daily Trading Plan">
      <div className="space-y-4">
        {symbols.map((symbol) => {
          const v = data![symbol]!;
          return (
            <div key={symbol} className="rounded-lg border border-white/10 p-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-white">{symbol}</span>
                  {v.currentPrice !== null && <span className="font-mono text-sm text-gray-300">{fmt(v.currentPrice)}</span>}
                </div>
                <Badge text={STATUS_LABEL[v.status]} tone={STATUS_TONE[v.status]} />
              </div>

              {v.support && v.resistance ? (
                <div className="mt-2 space-y-1 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-gray-400">Resistance</span>
                    <span className="font-mono text-good">
                      {fmt(v.resistance.priceLow)}&ndash;{fmt(v.resistance.priceHigh)}
                    </span>
                  </div>
                  <div className="truncate text-gray-500" title={v.resistance.label}>
                    {v.resistance.label}
                  </div>
                  <div className="flex items-center justify-between pt-1">
                    <span className="text-gray-400">Support</span>
                    <span className="font-mono text-bad">
                      {fmt(v.support.priceLow)}&ndash;{fmt(v.support.priceHigh)}
                    </span>
                  </div>
                  <div className="truncate text-gray-500" title={v.support.label}>
                    {v.support.label}
                  </div>
                </div>
              ) : (
                <p className="mt-2 text-xs text-gray-500">No support/resistance boundaries set this session.</p>
              )}

              {v.takeProfitCapPoints !== null ? (
                <div className="mt-2 border-t border-white/5 pt-2 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-gray-400">Take-profit cap</span>
                    <span className="font-mono text-gray-300">
                      {fmt(v.takeProfitCapPoints)}pt <span className="text-gray-500">(of {fmt(v.takeProfitLikelyMovePoints ?? 0, 0)}pt likely move)</span>
                    </span>
                  </div>
                  {v.takeProfitLabel && (
                    <div className="mt-0.5 truncate text-gray-500" title={v.takeProfitLabel}>
                      {v.takeProfitLabel}
                    </div>
                  )}
                </div>
              ) : (
                <p className="mt-2 border-t border-white/5 pt-2 text-xs text-gray-500">No take-profit target set this session.</p>
              )}
            </div>
          );
        })}
        {symbols.length === 0 && <p className="py-4 text-center text-sm text-gray-500">No daily plan data yet.</p>}
      </div>
    </Panel>
  );
}
