"use client";

import { memo, useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/api";
import { PpmSnapshot } from "@/lib/types";
import { Panel } from "@/components/Panel";
import { Badge } from "@/components/Badge";

const SYMBOLS = ["ES", "NQ", "CL", "GC"];

// Plain width-percentage bars, not a custom SVG arc -- the previous
// speedometer gauge computed needle/arc positions from scratch (angle,
// radius, viewBox math) and kept breaking in small, hard-to-spot ways
// (a viewBox/rendered-size mismatch silently rescaled every point on it).
// A bar's fill is just `width: X%`; there's no coordinate system to get
// wrong.
function SpeedBar({ label, value, maxValue, color }: { label: string; value: number; maxValue: number; color: string }) {
  const pct = maxValue > 0 ? Math.max(0, Math.min(100, (value / maxValue) * 100)) : 0;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="font-semibold tracking-wide" style={{ color }}>
          {label}
        </span>
        <span className="font-mono text-gray-300">{value.toFixed(1)} pts/min</span>
      </div>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-white/5">
        <div className="h-full rounded-full transition-[width]" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
    </div>
  );
}

export const PpmSpeedGauge = memo(function PpmSpeedGauge() {
  const { data } = useSWR<PpmSnapshot[]>("/api/market/ppm", fetcher, { refreshInterval: 3000 });
  const [symbol, setSymbol] = useState("NQ");

  const snapshot = data?.find((s) => s.symbol === symbol);
  const up = snapshot?.upPointsPerMinute ?? 0;
  const down = snapshot?.downPointsPerMinute ?? 0;
  const net = snapshot?.netPointsPerMinute ?? 0;
  // Shared scale between both bars so "which bar is more filled" is a real
  // comparison, not two independently auto-scaled numbers.
  const scaleMax = Math.max(up, down, 5) * 1.2;
  const hasData = (snapshot?.sampleCount ?? 0) >= 2;

  return (
    <Panel
      title="Market Speed"
      action={
        <div className="flex gap-1">
          {SYMBOLS.map((s) => (
            <button
              key={s}
              onClick={() => setSymbol(s)}
              className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                symbol === s ? "bg-accent/20 text-accent" : "text-gray-500 hover:text-gray-300"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      }
    >
      <p className="mb-3 text-xs text-gray-500">
        Upward vs. downward speed over the trailing 15 minutes -- how many points {symbol} is covering per minute in each direction, not
        just its net drift.
      </p>
      {!hasData ? (
        <p className="py-8 text-center text-sm text-gray-500">No live price ticks for {symbol} yet.</p>
      ) : (
        <>
          <div className="space-y-3">
            <SpeedBar label="BUY SPEED" value={up} maxValue={scaleMax} color="#10b981" />
            <SpeedBar label="SELL SPEED" value={down} maxValue={scaleMax} color="#ef4444" />
          </div>
          <div className="mt-3 flex items-center justify-center gap-3 text-xs text-gray-500">
            <Badge text={`net ${net >= 0 ? "+" : ""}${net.toFixed(1)} pts/min`} tone={net > 0 ? "good" : net < 0 ? "bad" : "neutral"} />
            <span>
              {snapshot!.windowMinutes.toFixed(1)}m window &middot; {snapshot!.sampleCount} ticks
            </span>
          </div>
        </>
      )}
    </Panel>
  );
});
