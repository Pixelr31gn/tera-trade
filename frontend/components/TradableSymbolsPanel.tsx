"use client";

import { useState } from "react";
import useSWR from "swr";
import { apiFetch, fetcher } from "@/lib/api";
import { SystemState } from "@/lib/types";
import { Panel } from "@/components/Panel";
import { Badge } from "@/components/Badge";
import { useConfirm } from "@/components/ConfirmDialog";

/**
 * Per-instrument executable toggle (2026-09-03, operator request: "add a
 * toggle so i can turn off which markets are executable like nd es or gc").
 * Turning a symbol off stops new trades from opening on it -- see
 * engine/loop.ts's evaluateNewSignals/scanSymbolContinuously and
 * replay/decisionCore.ts's decideOnBar -- but does NOT touch an
 * already-open position on that symbol, which keeps being managed normally.
 */
export function TradableSymbolsPanel() {
  const { data: systemState, mutate } = useSWR<SystemState>("/api/system/state", fetcher, { refreshInterval: 10000 });
  const confirm = useConfirm();
  const [togglingSymbol, setTogglingSymbol] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const symbols = systemState?.tradableSymbols ?? [];

  async function toggle(symbol: string, turningOn: boolean) {
    const msg = turningOn
      ? `Re-enable ${symbol} for live trading? New signals can start executing on it again immediately.`
      : `Disable ${symbol}? No new trades will open on it (an already-open position, if any, keeps being managed normally).`;
    if (!(await confirm(msg))) return;
    setTogglingSymbol(symbol);
    setError(null);
    try {
      await apiFetch(`/api/system/symbols/${symbol}/executable`, { method: "POST", body: JSON.stringify({ enabled: turningOn }) });
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : `Failed to change ${symbol}'s executable toggle`);
    } finally {
      setTogglingSymbol(null);
    }
  }

  return (
    <Panel title="Tradable Markets">
      {error && <p className="mb-3 text-sm text-bad">{error}</p>}
      <div className="space-y-2">
        {symbols.length === 0 && <p className="py-4 text-center text-sm text-gray-500">No active instruments.</p>}
        {symbols.map(({ symbol, enabled }) => (
          <div key={symbol} className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{symbol}</span>
              <Badge text={enabled ? "executable" : "disabled"} tone={enabled ? "good" : "neutral"} />
            </div>
            <button
              onClick={() => toggle(symbol, !enabled)}
              disabled={togglingSymbol === symbol}
              className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors disabled:opacity-40 ${
                enabled ? "border-bad/30 bg-bad/15 text-bad hover:bg-bad/25" : "border-white/10 bg-white/10 text-gray-300 hover:bg-white/15"
              }`}
            >
              {togglingSymbol === symbol ? "..." : enabled ? "Disable" : "Enable"}
            </button>
          </div>
        ))}
      </div>
    </Panel>
  );
}
