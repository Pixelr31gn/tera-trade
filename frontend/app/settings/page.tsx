"use client";

import { useState } from "react";
import useSWR from "swr";
import { apiFetch, fetcher } from "@/lib/api";
import { AccountSummary, SystemState } from "@/lib/types";
import { Panel } from "@/components/Panel";
import { Badge } from "@/components/Badge";

const MODES: Array<{ value: "analysis_only" | "paper" | "live"; label: string; description: string }> = [
  { value: "analysis_only", label: "Analysis Only", description: "Scores and regime detection run, but no orders are ever placed." },
  { value: "paper", label: "Paper Trading", description: "Qualifying setups are executed against the simulated broker." },
  { value: "live", label: "Live Trading", description: "Requires a configured ProjectX Gateway broker and an explicit server-side confirmation flag." },
];

export default function SettingsPage() {
  const { data: systemState, mutate: mutateState } = useSWR<SystemState>("/api/system/state", fetcher);
  const { data: accounts, mutate: mutateAccounts } = useSWR<AccountSummary[]>("/api/accounts", fetcher);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const account = accounts?.[0];

  async function changeMode(mode: string) {
    setError(null);
    try {
      await apiFetch("/api/system/mode", { method: "POST", body: JSON.stringify({ mode }) });
      mutateState();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to change mode");
    }
  }

  async function clearKillSwitch() {
    await apiFetch("/api/system/kill-switch/clear", { method: "POST" });
    mutateState();
  }

  async function saveRiskLimits(formData: FormData) {
    if (!account) return;
    setSaving(true);
    setError(null);
    try {
      const payload = {
        per_trade_risk_pct: Number(formData.get("per_trade_risk_pct")),
        max_daily_loss_pct: Number(formData.get("max_daily_loss_pct")),
        max_trailing_drawdown_pct: Number(formData.get("max_trailing_drawdown_pct")),
        max_position_size: Number(formData.get("max_position_size")),
        max_consecutive_losses: Number(formData.get("max_consecutive_losses")),
        max_daily_trades: Number(formData.get("max_daily_trades")),
      };
      await apiFetch(`/api/accounts/${account.id}/risk-limits`, { method: "PATCH", body: JSON.stringify(payload) });
      mutateAccounts();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save risk limits");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      {error && <div className="rounded-lg border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">{error}</div>}

      <Panel
        title="Trading Mode"
        action={systemState?.kill_switch ? <Badge text="kill switch active" tone="bad" /> : undefined}
      >
        <div className="space-y-3">
          {MODES.map((m) => {
            const disabled = m.value === "live" && systemState?.broker_kind !== "projectx";
            return (
              <button
                key={m.value}
                disabled={disabled}
                onClick={() => changeMode(m.value)}
                className={`flex w-full items-center justify-between rounded-md border px-4 py-3 text-left transition-colors ${
                  systemState?.mode === m.value ? "border-accent bg-accent/10" : "border-border"
                } ${disabled ? "cursor-not-allowed opacity-40" : "hover:border-accent/60"}`}
              >
                <div>
                  <div className="font-medium text-white">{m.label}</div>
                  <div className="text-xs text-gray-400">{m.description}</div>
                </div>
                {systemState?.mode === m.value && <Badge text="active" tone="good" />}
              </button>
            );
          })}
          {systemState?.kill_switch && (
            <button onClick={clearKillSwitch} className="rounded-md bg-bad px-4 py-2 text-sm font-medium text-white">
              Clear kill switch
            </button>
          )}
        </div>
      </Panel>

      <Panel title="Risk Limits">
        {account ? (
          <form action={saveRiskLimits} className="grid grid-cols-2 gap-4 md:grid-cols-3">
            {[
              ["per_trade_risk_pct", "Per-trade risk (%)", account.risk_limits.per_trade_risk_pct],
              ["max_daily_loss_pct", "Max daily loss (%)", account.risk_limits.max_daily_loss_pct],
              ["max_trailing_drawdown_pct", "Max trailing drawdown (%)", account.risk_limits.max_trailing_drawdown_pct],
              ["max_position_size", "Max position size (contracts)", account.risk_limits.max_position_size],
              ["max_consecutive_losses", "Max consecutive losses", account.risk_limits.max_consecutive_losses],
              ["max_daily_trades", "Max daily trades", account.risk_limits.max_daily_trades],
            ].map(([name, label, value]) => (
              <label key={name as string} className="text-xs text-gray-400">
                {label}
                <input
                  name={name as string}
                  type="number"
                  step="any"
                  defaultValue={value as number}
                  className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5 text-sm text-white"
                />
              </label>
            ))}
            <button
              type="submit"
              disabled={saving}
              className="col-span-full mt-2 w-fit rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save risk limits"}
            </button>
          </form>
        ) : (
          <p className="text-sm text-gray-500">Loading account...</p>
        )}
      </Panel>

      <Panel title="Scoring Threshold">
        <p className="text-sm text-gray-300">
          Minimum confidence score required to take a trade:{" "}
          <span className="font-semibold text-white">{((systemState?.min_score_threshold ?? 0.65) * 100).toFixed(0)}%</span>
        </p>
        <p className="mt-1 text-xs text-gray-500">Set via MIN_SCORE_THRESHOLD in the backend environment; not editable from the dashboard.</p>
      </Panel>
    </div>
  );
}
