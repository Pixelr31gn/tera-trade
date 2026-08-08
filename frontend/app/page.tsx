"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { fetcher } from "@/lib/api";
import {
  AccountSummary,
  EquityAccountOption,
  EquityPoint,
  NewsRiskStatus,
  PerformanceSummary,
  Position,
  RegimeInfo,
  SessionPerformance,
  SystemState,
} from "@/lib/types";
import { StatCard } from "@/components/StatCard";
import { Panel } from "@/components/Panel";
import { Badge } from "@/components/Badge";
import { ActionBanner } from "@/components/ActionBanner";
import { QuickOrderPanel } from "@/components/QuickOrderPanel";
import { PpmSpeedGauge } from "@/components/PpmSpeedGauge";
import { LiveFeed } from "@/components/LiveFeed";
import { RecentTrades } from "@/components/RecentTrades";

const SESSION_LABELS: Record<string, string> = { new_york: "New York", london: "London", asian: "Asian" };
const SESSION_ORDER = ["new_york", "london", "asian"];

export default function DashboardPage() {
  const { data: accounts } = useSWR<AccountSummary[]>("/api/accounts", fetcher, { refreshInterval: 15000 });
  const account = accounts?.[0];
  // Equity-curve history is tracked per real TopstepX account (2026-07-21
  // fix) -- an operator switching between several funded accounts in the
  // browser must not see their histories blended into one curve. Defaults
  // to whichever account is live right now, but only on first load --
  // otherwise every 15s refetch of equityAccounts would silently yank the
  // chart back to "currently active" out from under a manual selection.
  const { data: equityAccounts } = useSWR<EquityAccountOption[]>("/api/accounts/equity-accounts", fetcher, { refreshInterval: 15000 });
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);
  useEffect(() => {
    if (selectedAccountId !== null || !equityAccounts || equityAccounts.length === 0) return;
    setSelectedAccountId(equityAccounts.find((a) => a.isCurrentlyActive)?.id ?? equityAccounts[0]!.id);
  }, [equityAccounts, selectedAccountId]);
  const selectedEquityAccount = equityAccounts?.find((a) => a.id === selectedAccountId);
  const { data: equityCurve } = useSWR<EquityPoint[]>(
    selectedAccountId !== null ? `/api/accounts/${selectedAccountId}/equity-curve?days=30` : null,
    fetcher,
    { refreshInterval: 15000 }
  );
  const { data: positions } = useSWR<Position[]>("/api/positions", fetcher, { refreshInterval: 10000 });
  const { data: regimes } = useSWR<Record<string, RegimeInfo>>("/api/regime/current", fetcher, { refreshInterval: 15000 });
  const { data: newsStatus } = useSWR<NewsRiskStatus>("/api/news/risk-status", fetcher, { refreshInterval: 15000 });
  const { data: systemState } = useSWR<SystemState>("/api/system/state", fetcher, { refreshInterval: 10000 });
  const { data: performance } = useSWR<PerformanceSummary>("/api/performance/summary", fetcher, { refreshInterval: 20000 });
  const { data: sessionPerf } = useSWR<Record<string, SessionPerformance>>("/api/analytics/session-performance", fetcher, {
    refreshInterval: 3600000, // backend caches this for 24h -- polling faster than that just re-requests the same cached response
  });
  const latestEquity = equityCurve?.at(-1)?.equity ?? selectedEquityAccount?.startingBalance ?? account?.startingBalance ?? 0;
  const startingBalance = selectedEquityAccount?.startingBalance ?? account?.startingBalance ?? 0;
  const pnl = latestEquity - startingBalance;
  const openRisk = positions?.reduce((sum, p) => sum + Math.abs((p.entryPrice - p.stopPrice) * p.quantity), 0) ?? 0;

  // Only a new reference when the 15s-polled equity data actually changes --
  // otherwise Recharts repaints the SVG on every unrelated re-render.
  const chartData = useMemo(
    () => (equityCurve ?? []).map((p) => ({ time: new Date(p.time).toLocaleString(), equity: p.equity })),
    [equityCurve]
  );

  return (
    <div className="space-y-6">
      {systemState?.killSwitch && (
        <div className="rounded-2xl border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad backdrop-blur-xl">
          Kill switch engaged: {systemState.killSwitchReason}. New entries are blocked until cleared in Settings.
        </div>
      )}
      {newsStatus?.inRiskWindow && (
        <div className="rounded-2xl border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-warn backdrop-blur-xl">
          News risk window active: &quot;{newsStatus.nearestEventName}&quot; ({newsStatus.impact} impact){" "}
          {newsStatus.minutesToEvent !== null &&
            (newsStatus.minutesToEvent > 0
              ? `in ${Math.round(newsStatus.minutesToEvent)} min`
              : `${Math.abs(Math.round(newsStatus.minutesToEvent))} min ago`)}
          . New entries are paused.
        </div>
      )}

      <ActionBanner />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4 lg:grid-cols-6">
        <StatCard label="Account Equity" value={`$${latestEquity.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} />
        <StatCard label="Open P&L" value={`${pnl >= 0 ? "+" : ""}$${pnl.toFixed(0)}`} tone={pnl >= 0 ? "good" : "bad"} />
        <StatCard label="Open Risk ($)" value={`$${openRisk.toFixed(0)}`} sub={`${positions?.length ?? 0} open position(s)`} />
        <StatCard
          label="Mode"
          value={systemState?.mode ?? "..."}
          tone={systemState?.mode === "live" ? "bad" : systemState?.mode === "paper" ? "warn" : "neutral"}
        />
        <StatCard label="Win Rate" value={performance ? `${(performance.tradeStats.winRate * 100).toFixed(0)}%` : "..."} />
        <StatCard
          label="Profit Factor"
          value={performance?.tradeStats.profitFactor != null ? performance.tradeStats.profitFactor.toFixed(2) : "n/a"}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Panel
            title="Equity Curve (30d)"
            action={
              equityAccounts && equityAccounts.length > 1 ? (
                <select
                  value={selectedAccountId ?? ""}
                  onChange={(e) => setSelectedAccountId(Number(e.target.value))}
                  className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-gray-300"
                >
                  {equityAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                      {a.isCurrentlyActive ? " (active)" : ""}
                    </option>
                  ))}
                </select>
              ) : undefined
            }
          >
            <div style={{ width: "100%", height: 240 }}>
              <ResponsiveContainer>
                <LineChart data={chartData}>
                  <defs>
                    {/* Soft icy glow behind the line -- matches the accent
                        color's shadow-glow-accent treatment used elsewhere
                        in the UI, so the chart reads as part of the same
                        "snow leopard" glacier-blue identity. */}
                    <filter id="equityGlow" x="-50%" y="-50%" width="200%" height="200%">
                      <feGaussianBlur stdDeviation="4" result="blur" />
                      <feMerge>
                        <feMergeNode in="blur" />
                        <feMergeNode in="SourceGraphic" />
                      </feMerge>
                    </filter>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#28323f" />
                  <XAxis dataKey="time" hide />
                  <YAxis stroke="#8b96a5" tick={{ fontSize: 11 }} domain={["auto", "auto"]} />
                  <Tooltip contentStyle={{ background: "#131a23", border: "1px solid #28323f", borderRadius: 12 }} />
                  <Line
                    type="monotone"
                    dataKey="equity"
                    stroke="#7dd3fc"
                    dot={false}
                    strokeWidth={2}
                    style={{ filter: "url(#equityGlow)" }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Panel>

          <Panel
            title="Open Positions"
            action={
              <Link href="/positions" className="text-xs text-accent hover:underline">
                View all &rarr;
              </Link>
            }
          >
            <table>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Side</th>
                  <th>Qty</th>
                  <th>Entry</th>
                  <th>Stop</th>
                  <th>Target</th>
                </tr>
              </thead>
              <tbody>
                {positions?.slice(0, 5).map((p) => (
                  <tr key={p.tradeId}>
                    <td className="font-medium text-white">{p.symbol}</td>
                    <td>
                      <Badge text={p.side} tone={p.side === "long" ? "good" : "bad"} />
                    </td>
                    <td>{p.quantity}</td>
                    <td className="font-mono">{p.entryPrice}</td>
                    <td className="font-mono text-bad">{p.stopPrice}</td>
                    <td className="font-mono text-good">{p.takeProfitPrice ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(!positions || positions.length === 0) && <p className="py-4 text-center text-sm text-gray-500">No open positions.</p>}
          </Panel>

          <RecentTrades />

          <LiveFeed />
        </div>

        <div className="space-y-6">
          <PpmSpeedGauge />

          <QuickOrderPanel />

          <Panel title="Current Regime">
            <div className="space-y-2">
              {regimes &&
                Object.entries(regimes).map(([symbol, r]) => (
                  <div key={symbol} className="flex items-center justify-between text-sm">
                    <span className="font-medium text-white">{symbol}</span>
                    <div className="flex gap-1.5">
                      <Badge
                        text={r.trendLabel}
                        tone={r.trendLabel === "up" ? "good" : r.trendLabel === "down" ? "bad" : "neutral"}
                      />
                      <Badge text={r.volLabel} tone={r.volLabel === "high" ? "warn" : "neutral"} />
                    </div>
                  </div>
                ))}
              {(!regimes || Object.keys(regimes).length === 0) && <p className="text-sm text-gray-500">No regime data yet.</p>}
            </div>
          </Panel>

          <Panel
            title="Session Intelligence"
            action={
              <Link href="/sessions" className="text-xs text-accent hover:underline">
                Full view &rarr;
              </Link>
            }
          >
            <div className="space-y-2">
              {SESSION_ORDER.map((session) => {
                const stats = sessionPerf?.[session];
                return (
                  <div key={session} className="flex items-center justify-between rounded-lg bg-white/[0.03] px-3 py-2 text-sm">
                    <span className="font-medium text-white">{SESSION_LABELS[session]}</span>
                    {stats ? (
                      <div className="flex items-center gap-2 text-xs text-gray-400">
                        <span>{stats.totalScores} setups</span>
                        {stats.winRate !== null && (
                          <Badge text={`${Math.round(stats.winRate * 100)}% win`} tone={stats.winRate >= 0.5 ? "good" : "bad"} />
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-gray-500">...</span>
                    )}
                  </div>
                );
              })}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
