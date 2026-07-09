"use client";

import { useState } from "react";
import useSWR from "swr";
import { apiFetch, fetcher } from "@/lib/api";
import { MarketSnapshot, Position, SystemState } from "@/lib/types";
import { Panel } from "@/components/Panel";
import { Badge } from "@/components/Badge";

const SYMBOLS = ["ES", "NQ", "CL", "GC"];

function fmt(value: number, decimals = 2): string {
  return value.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function QuickOrderPanel() {
  const { data: snapshot } = useSWR<MarketSnapshot[]>("/api/market/snapshot", fetcher, { refreshInterval: 5000 });
  const { data: positions, mutate: mutatePositions } = useSWR<Position[]>("/api/positions", fetcher, { refreshInterval: 5000 });
  const { data: systemState } = useSWR<SystemState>("/api/system/state", fetcher, { refreshInterval: 10000 });

  const [symbol, setSymbol] = useState("NQ");
  const [quantity, setQuantity] = useState(1);
  const [stopPoints, setStopPoints] = useState(10);
  const [targetPoints, setTargetPoints] = useState(20);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const row = snapshot?.find((s) => s.symbol === symbol);
  const lastPrice = row?.lastPrice !== null && row?.lastPrice !== undefined ? Number(row.lastPrice) : null;
  const pointValue = row ? Number(row.pointValue) : null;
  const openPosition = positions?.find((p) => p.symbol === symbol);

  const canPreview = lastPrice !== null && pointValue !== null && stopPoints > 0 && quantity > 0;
  const riskDollars = canPreview ? stopPoints * pointValue! * quantity : null;
  const profitDollars = canPreview && targetPoints > 0 ? targetPoints * pointValue! * quantity : null;
  const riskReward = targetPoints > 0 && stopPoints > 0 ? targetPoints / stopPoints : null;

  const tradingBlocked = !systemState || systemState.mode === "analysis_only" || systemState.killSwitch;

  async function submit(side: "long" | "short") {
    if (!lastPrice) return;
    const stopPrice = side === "long" ? lastPrice - stopPoints : lastPrice + stopPoints;
    const takeProfitPrice = targetPoints > 0 ? (side === "long" ? lastPrice + targetPoints : lastPrice - targetPoints) : undefined;

    const confirmMsg =
      `Place ${side.toUpperCase()} ${quantity} ${symbol} @ ~${fmt(lastPrice)}?\n` +
      `Stop ${fmt(stopPrice)} (~$${riskDollars?.toFixed(0)} risk)` +
      (takeProfitPrice ? `, target ${fmt(takeProfitPrice)}` : "") +
      (systemState?.brokerKind === "browser_control" ? "\n\nThis clicks a real order on your TopstepX account." : "");
    if (!confirm(confirmMsg)) return;

    setSubmitting(true);
    setError(null);
    try {
      await apiFetch("/api/trades/manual", {
        method: "POST",
        body: JSON.stringify({ symbol, side, quantity, stopPrice, takeProfitPrice }),
      });
      mutatePositions();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to place order");
    } finally {
      setSubmitting(false);
    }
  }

  async function closePosition() {
    if (!openPosition) return;
    if (!confirm(`Close the open ${symbol} position? This clicks "Close Position" on your real account.`)) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch(`/api/positions/${openPosition.tradeId}/close`, { method: "POST" });
      mutatePositions();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to close position");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Panel
      title="Quick Order"
      action={
        systemState && (
          <Badge
            text={`${systemState.mode} / ${systemState.brokerKind}`}
            tone={systemState.mode === "live" ? "bad" : systemState.mode === "paper" ? "warn" : "neutral"}
          />
        )
      }
    >
      <div className="space-y-4">
        <div className="flex gap-1.5">
          {SYMBOLS.map((s) => (
            <button
              key={s}
              onClick={() => setSymbol(s)}
              className={`flex-1 rounded-lg border px-2 py-1.5 text-sm font-medium transition-colors ${
                symbol === s ? "border-accent bg-accent/10 text-white" : "border-white/10 text-gray-400 hover:text-white"
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-400">Last price</span>
          <span className="font-mono font-semibold text-white">{lastPrice !== null ? fmt(lastPrice) : "..."}</span>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <label className="text-xs text-gray-400">
            Qty
            <input
              type="number"
              min={1}
              value={quantity}
              onChange={(e) => setQuantity(Math.max(1, Number(e.target.value)))}
              className="mt-1 w-full rounded-lg border border-white/10 bg-black/20 px-2 py-1.5 text-sm text-white"
            />
          </label>
          <label className="text-xs text-gray-400">
            Stop (pts)
            <input
              type="number"
              min={0.25}
              step={0.25}
              value={stopPoints}
              onChange={(e) => setStopPoints(Math.max(0, Number(e.target.value)))}
              className="mt-1 w-full rounded-lg border border-white/10 bg-black/20 px-2 py-1.5 text-sm text-white"
            />
          </label>
          <label className="text-xs text-gray-400">
            Target (pts)
            <input
              type="number"
              min={0}
              step={0.25}
              value={targetPoints}
              onChange={(e) => setTargetPoints(Math.max(0, Number(e.target.value)))}
              className="mt-1 w-full rounded-lg border border-white/10 bg-black/20 px-2 py-1.5 text-sm text-white"
            />
          </label>
        </div>

        <div className="space-y-1.5 rounded-lg border border-white/10 bg-black/20 px-3 py-2.5 text-xs">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">Live Trade Preview</div>
          <div className="flex justify-between">
            <span className="text-gray-400">Entry</span>
            <span className="font-mono text-white">{lastPrice !== null ? fmt(lastPrice) : "n/a"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Est. $ risk</span>
            <span className="font-mono text-bad">{riskDollars !== null ? `$${riskDollars.toFixed(0)}` : "n/a"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Est. $ profit (target)</span>
            <span className="font-mono text-good">{profitDollars !== null ? `$${profitDollars.toFixed(0)}` : "n/a"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">R:R</span>
            <span className="font-mono text-white">{riskReward !== null ? riskReward.toFixed(2) : "n/a"}</span>
          </div>
        </div>

        {error && <p className="text-xs text-bad">{error}</p>}

        {tradingBlocked && (
          <p className="text-xs text-warn">
            {systemState?.killSwitch ? "Kill switch is active." : "System is in analysis_only mode."} No orders can be placed.
          </p>
        )}

        {openPosition ? (
          <button
            onClick={closePosition}
            disabled={submitting}
            className="w-full rounded-lg bg-bad/20 px-4 py-2 text-sm font-semibold text-bad transition-colors hover:bg-bad/30 disabled:opacity-50"
          >
            Close open {symbol} position
          </button>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => submit("long")}
              disabled={submitting || tradingBlocked || !canPreview}
              className="rounded-lg bg-good/90 px-4 py-2 text-sm font-semibold text-black shadow-glow-good transition-colors hover:bg-good disabled:opacity-40"
            >
              Buy
            </button>
            <button
              onClick={() => submit("short")}
              disabled={submitting || tradingBlocked || !canPreview}
              className="rounded-lg bg-bad/90 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-bad disabled:opacity-40"
            >
              Sell
            </button>
          </div>
        )}
      </div>
    </Panel>
  );
}
