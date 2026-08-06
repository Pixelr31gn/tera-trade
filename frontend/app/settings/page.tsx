"use client";

import { useState } from "react";
import useSWR from "swr";
import { apiFetch, fetcher } from "@/lib/api";
import { AccountSummary, SystemState } from "@/lib/types";
import { Panel } from "@/components/Panel";
import { Badge } from "@/components/Badge";
import { useConfirm } from "@/components/ConfirmDialog";

const MODES: Array<{ value: "analysis_only" | "paper" | "live"; label: string; description: string }> = [
  { value: "analysis_only", label: "Analysis Only", description: "Scores and regime detection run, but no orders are ever placed." },
  { value: "paper", label: "Paper Trading", description: "Qualifying setups are executed against the simulated broker. Always available -- switching here never touches the real account." },
  { value: "live", label: "Live Trading", description: "Requires a live broker to be connected right now (ProjectX Gateway or browser-control) and LIVE_TRADING_CONFIRMED set server-side. Switches instantly, no restart needed." },
];

export default function SettingsPage() {
  const { data: systemState, mutate: mutateState } = useSWR<SystemState>("/api/system/state", fetcher);
  const { data: accounts, mutate: mutateAccounts } = useSWR<AccountSummary[]>("/api/accounts", fetcher);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const account = accounts?.[0];
  const confirm = useConfirm();

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

  async function toggleExecutionDecisionEngine(enabled: boolean) {
    if (enabled) {
      const ok = await confirm(
        "Enable the Execution Decision Engine? Once live trading is active on the browser-control broker, this places real resting limit orders on TopstepX instead of immediate market orders. If you haven't watched it against a real fill yet, test with DRY_RUN_ORDERS=true first -- see docs/EXECUTION_DECISION_ENGINE.md."
      );
      if (!ok) return;
    }
    setError(null);
    try {
      await apiFetch("/api/system/execution-decision-engine", { method: "POST", body: JSON.stringify({ enabled }) });
      mutateState();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update Execution Decision Engine setting");
    }
  }

  function optionalNumber(formData: FormData, name: string): number | null {
    const raw = formData.get(name);
    if (raw === null || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  async function saveTakeProfitRMultiple(formData: FormData) {
    setSaving(true);
    setError(null);
    try {
      const value = Number(formData.get("takeProfitRMultiple"));
      await apiFetch("/api/system/take-profit-r-multiple", { method: "POST", body: JSON.stringify({ value }) });
      mutateState();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save reward:risk");
    } finally {
      setSaving(false);
    }
  }

  async function saveConfidenceTiers(formData: FormData) {
    setSaving(true);
    setError(null);
    try {
      const tiers = [1, 2, 3].map((n) => ({
        threshold: Number(formData.get(`tier${n}Threshold`)) / 100,
        quantity: Number(formData.get(`tier${n}Quantity`)),
      }));
      await apiFetch("/api/system/confidence-tiers", { method: "POST", body: JSON.stringify({ tiers }) });
      mutateState();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save confidence tiers");
    } finally {
      setSaving(false);
    }
  }

  async function saveRiskLimits(formData: FormData) {
    if (!account) return;
    setSaving(true);
    setError(null);
    try {
      const payload = {
        perTradeRiskPct: Number(formData.get("perTradeRiskPct")),
        maxDailyLossPct: Number(formData.get("maxDailyLossPct")),
        maxTrailingDrawdownPct: Number(formData.get("maxTrailingDrawdownPct")),
        maxPositionSize: Number(formData.get("maxPositionSize")),
        maxConsecutiveLosses: Number(formData.get("maxConsecutiveLosses")),
        maxDailyTrades: Number(formData.get("maxDailyTrades")),
        perTradeRiskDollars: optionalNumber(formData, "perTradeRiskDollars"),
        perTradeProfitDollars: optionalNumber(formData, "perTradeProfitDollars"),
        maxDailyLossDollars: optionalNumber(formData, "maxDailyLossDollars"),
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
        action={systemState?.killSwitch ? <Badge text="kill switch active" tone="bad" /> : undefined}
      >
        <div className="space-y-3">
          {MODES.map((m) => {
            // Deliberately always clickable (2026-08-02, operator request) --
            // NOT a widened gate: execution/mode.ts's setMode still rejects
            // the switch server-side with a clear error if no live broker is
            // actually connected or LIVE_TRADING_CONFIRMED isn't set. This
            // only changes whether the button is greyed out in advance;
            // clicking it when the prerequisites aren't met surfaces the
            // rejection as an error message instead of a disabled button.
            const disabled = false;
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
          {systemState?.killSwitch && (
            <button onClick={clearKillSwitch} className="rounded-md bg-bad px-4 py-2 text-sm font-medium text-white">
              Clear kill switch
            </button>
          )}
        </div>
      </Panel>

      <Panel
        title="Execution Decision Engine"
        action={<Badge text={systemState?.executionDecisionEngineEnabled ? "enabled" : "disabled"} tone={systemState?.executionDecisionEngineEnabled ? "good" : "bad"} />}
      >
        <p className="text-sm text-gray-300">
          Routes an approved signal through fair-value-map scoring and a resting limit order instead
          of an immediate market order. Only takes effect once the broker is browser_control (live
          mode) -- safe to leave on otherwise, since paper/analysis-only always fall back to the
          existing immediate-market-order path regardless of this toggle.
        </p>
        <button
          onClick={() => toggleExecutionDecisionEngine(!systemState?.executionDecisionEngineEnabled)}
          role="switch"
          aria-checked={systemState?.executionDecisionEngineEnabled ?? false}
          className={`mt-3 flex items-center gap-3 rounded-md border px-4 py-2 transition-colors ${
            systemState?.executionDecisionEngineEnabled ? "border-accent bg-accent/10" : "border-border"
          }`}
        >
          <span
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
              systemState?.executionDecisionEngineEnabled ? "bg-accent" : "bg-white/10"
            }`}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                systemState?.executionDecisionEngineEnabled ? "translate-x-5" : "translate-x-0.5"
              }`}
            />
          </span>
          <span className="text-sm font-medium text-white">
            {systemState?.executionDecisionEngineEnabled ? "Enabled" : "Disabled"}
          </span>
        </button>
      </Panel>

      <Panel title="Risk Limits">
        {account ? (
          <form action={saveRiskLimits} className="space-y-4">
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
              {[
                ["perTradeRiskPct", "Per-trade risk (%)", account.riskLimits.perTradeRiskPct],
                ["maxDailyLossPct", "Max daily loss (%)", account.riskLimits.maxDailyLossPct],
                ["maxTrailingDrawdownPct", "Max trailing drawdown (%)", account.riskLimits.maxTrailingDrawdownPct],
                ["maxPositionSize", "Max position size (contracts)", account.riskLimits.maxPositionSize],
                ["maxConsecutiveLosses", "Max consecutive losses", account.riskLimits.maxConsecutiveLosses],
                ["maxDailyTrades", "Max daily trades", account.riskLimits.maxDailyTrades],
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
            </div>

            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                Fixed-dollar overrides (leave blank to use the percentage fields above)
              </div>
              <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
                {[
                  ["perTradeRiskDollars", "Per-trade risk ($)", account.riskLimits.perTradeRiskDollars],
                  ["perTradeProfitDollars", "Per-trade profit target ($)", account.riskLimits.perTradeProfitDollars],
                  ["maxDailyLossDollars", "Max daily loss ($)", account.riskLimits.maxDailyLossDollars],
                ].map(([name, label, value]) => (
                  <label key={name as string} className="text-xs text-gray-400">
                    {label}
                    <input
                      name={name as string}
                      type="number"
                      step="any"
                      defaultValue={value ?? ""}
                      placeholder="unset"
                      className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5 text-sm text-white"
                    />
                  </label>
                ))}
              </div>
            </div>

            <button
              type="submit"
              disabled={saving}
              className="w-fit rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save risk limits"}
            </button>
          </form>
        ) : (
          <p className="text-sm text-gray-500">Loading account...</p>
        )}
      </Panel>

      <Panel title="Reward:Risk">
        <p className="mb-4 text-sm text-gray-300">
          The take-profit target is set at this multiple of the stop distance, for every strategy and
          scoring version (v1/v2/v3/v5/v6+) -- there is no per-strategy or per-version override. Takes
          effect immediately on the next signal, no restart needed.
        </p>
        <form action={saveTakeProfitRMultiple} className="flex items-end gap-3">
          <label className="text-xs text-gray-400">
            Reward:Risk multiple
            <input
              name="takeProfitRMultiple"
              type="number"
              step="0.1"
              min="0.1"
              defaultValue={systemState?.takeProfitRMultiple ?? 2.0}
              className="mt-1 w-32 rounded border border-border bg-background px-2 py-1.5 text-sm text-white"
            />
          </label>
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </form>
      </Panel>

      <Panel title="Confidence-Tier Position Sizing">
        <p className="mb-4 text-sm text-gray-300">
          Quantity placed is set directly by which of these three cross-version consensus average
          tiers the setup clears, lowest tier first as the floor (never sized to zero once every other
          gate has already approved the trade). Thresholds must be strictly ascending.
        </p>
        <form action={saveConfidenceTiers} className="space-y-3">
          {[1, 2, 3].map((n) => {
            const tier = systemState?.confidenceTiers?.[n - 1];
            return (
              <div key={n} className="flex items-end gap-3">
                <label className="text-xs text-gray-400">
                  Tier {n} threshold (%)
                  <input
                    name={`tier${n}Threshold`}
                    type="number"
                    step="1"
                    min="1"
                    max="99"
                    defaultValue={tier ? Math.round(tier.threshold * 100) : [65, 75, 85][n - 1]}
                    className="mt-1 w-28 rounded border border-border bg-background px-2 py-1.5 text-sm text-white"
                  />
                </label>
                <label className="text-xs text-gray-400">
                  Contracts
                  <input
                    name={`tier${n}Quantity`}
                    type="number"
                    step="1"
                    min="1"
                    defaultValue={tier?.quantity ?? n}
                    className="mt-1 w-24 rounded border border-border bg-background px-2 py-1.5 text-sm text-white"
                  />
                </label>
              </div>
            );
          })}
          <button
            type="submit"
            disabled={saving}
            className="w-fit rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save confidence tiers"}
          </button>
        </form>
      </Panel>

      <Panel title="Scoring Threshold">
        <p className="text-sm text-gray-300">
          Minimum confidence score required to take a trade:{" "}
          <span className="font-semibold text-white">{((systemState?.minScoreThreshold ?? 0.65) * 100).toFixed(0)}%</span>
        </p>
        <p className="mt-1 text-xs text-gray-500">Set via MIN_SCORE_THRESHOLD in the backend environment; not editable from the dashboard.</p>
      </Panel>
    </div>
  );
}
