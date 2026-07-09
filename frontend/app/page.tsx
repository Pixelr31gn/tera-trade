"use client";

import Link from "next/link";
import useSWR from "swr";
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { fetcher } from "@/lib/api";
import {
  AccountSummary,
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
import { useLiveEvents } from "@/lib/useLiveEvents";

const SESSION_LABELS: Record<string, string> = { new_york: "New York", london: "London", asian: "Asian" };
const SESSION_ORDER = ["new_york", "london", "asian"];

export default function DashboardPage() {
  const { data: accounts } = useSWR<AccountSummary[]>("/api/accounts", fetcher, { refreshInterval: 15000 });
  const account = accounts?.[0];
  const { data: equityCurve } = useSWR<EquityPoint[]>(
    account ? `/api/accounts/${account.id}/equity-curve?days=30` : null,
    fetcher,
    { refreshInterval: 15000 }
  );
  const { data: positions } = useSWR<Position[]>("/api/positions", fetcher, { refreshInterval: 10000 });
  const { data: regimes } = useSWR<Record<string, RegimeInfo>>("/api/regime/current", fetcher, { refreshInterval: 15000 });
  const { data: newsStatus } = useSWR<NewsRiskStatus>("/api/news/risk-status", fetcher, { refreshInterval: 15000 });
  const { data: systemState } = useSWR<SystemState>("/api/system/state", fetcher, { refreshInterval: 10000 });
  const { data: performance } = useSWR<PerformanceSummary>("/api/performance/summary", fetcher, { refreshInterval: 20000 });
  const { data: sessionPerf } = useSWR<Record<string, SessionPerformance>>("/api/analytics/session-performance", fetcher, {
    refreshInterval: 30000,
  });
  const { events, connected } = useLiveEvents(20);

  const latestEquity = equityCurve?.at(-1)?.equity ?? account?.startingBalance ?? 0;
  const startingBalance = account?.startingBalance ?? 0;
  const pnl = latestEquity - startingBalance;
  const openRisk = positions?.reduce((sum, p) => sum + Math.abs((p.entryPrice - p.stopPrice) * p.quantity), 0) ?? 0;

  const chartData = (equityCurve ?? []).map((p) => ({ time: new Date(p.time).toLocaleString(), equity: p.equity }));

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
          <Panel title="Equity Curve (30d)">
            <div style={{ width: "100%", height: 240 }}>
              <ResponsiveContainer>
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#232a35" />
                  <XAxis dataKey="time" hide />
                  <YAxis stroke="#8b96a5" tick={{ fontSize: 11 }} domain={["auto", "auto"]} />
                  <Tooltip contentStyle={{ background: "#12151b", border: "1px solid #232a35", borderRadius: 12 }} />
                  <Line type="monotone" dataKey="equity" stroke="#3b9dff" dot={false} strokeWidth={2} />
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

          <Panel
            title="Live Feed"
            action={<Badge text={connected ? "connected" : "reconnecting..."} tone={connected ? "good" : "warn"} />}
          >
            <ul className="max-h-64 space-y-1.5 overflow-y-auto text-sm">
              {events.length === 0 && <li className="text-gray-500">Waiting for engine events...</li>}
              {events.map((e, i) => (
                <li key={i} className="flex items-start gap-2 border-b border-white/5 pb-1.5 last:border-0">
                  <Badge text={String(e.type)} tone="neutral" />
                  <span className="text-gray-300">{String(e.explanation ?? e.reason ?? JSON.stringify(e))}</span>
                </li>
              ))}
            </ul>
          </Panel>
        </div>

        <div className="space-y-6">
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
