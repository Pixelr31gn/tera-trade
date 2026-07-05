"use client";

import useSWR from "swr";
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { fetcher } from "@/lib/api";
import { AccountSummary, EquityPoint, NewsRiskStatus, Position, RegimeInfo, SystemState } from "@/lib/types";
import { StatCard } from "@/components/StatCard";
import { Panel } from "@/components/Panel";
import { Badge } from "@/components/Badge";
import { useLiveEvents } from "@/lib/useLiveEvents";

export default function OverviewPage() {
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
  const { events, connected } = useLiveEvents(20);

  const latestEquity = equityCurve?.at(-1)?.equity ?? account?.startingBalance ?? 0;
  const startingBalance = account?.startingBalance ?? 0;
  const pnl = latestEquity - startingBalance;
  const openRisk = positions?.reduce((sum, p) => sum + Math.abs((p.entryPrice - p.stopPrice) * p.quantity), 0) ?? 0;

  const chartData = (equityCurve ?? []).map((p) => ({ time: new Date(p.time).toLocaleString(), equity: p.equity }));

  return (
    <div className="space-y-6">
      {systemState?.killSwitch && (
        <div className="rounded-lg border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">
          Kill switch engaged: {systemState.killSwitchReason}. New entries are blocked until cleared in Settings.
        </div>
      )}
      {newsStatus?.inRiskWindow && (
        <div className="rounded-lg border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-warn">
          News risk window active: &quot;{newsStatus.nearestEventName}&quot; ({newsStatus.impact} impact){" "}
          {newsStatus.minutesToEvent !== null &&
            (newsStatus.minutesToEvent > 0
              ? `in ${Math.round(newsStatus.minutesToEvent)} min`
              : `${Math.abs(Math.round(newsStatus.minutesToEvent))} min ago`)}
          . New entries are paused.
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Account Equity" value={`$${latestEquity.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} />
        <StatCard label="Open P&L" value={`${pnl >= 0 ? "+" : ""}$${pnl.toFixed(0)}`} tone={pnl >= 0 ? "good" : "bad"} />
        <StatCard label="Open Risk ($)" value={`$${openRisk.toFixed(0)}`} sub={`${positions?.length ?? 0} open position(s)`} />
        <StatCard
          label="Mode"
          value={systemState?.mode ?? "..."}
          tone={systemState?.mode === "live" ? "bad" : systemState?.mode === "paper" ? "warn" : "neutral"}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Panel title="Equity Curve (30d)">
            <div style={{ width: "100%", height: 260 }}>
              <ResponsiveContainer>
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#232c38" />
                  <XAxis dataKey="time" hide />
                  <YAxis stroke="#8b96a5" tick={{ fontSize: 11 }} domain={["auto", "auto"]} />
                  <Tooltip contentStyle={{ background: "#121820", border: "1px solid #232c38" }} />
                  <Line type="monotone" dataKey="equity" stroke="#4f9cff" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Panel>
        </div>

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
      </div>

      <Panel
        title="Live Feed"
        action={<Badge text={connected ? "connected" : "reconnecting..."} tone={connected ? "good" : "warn"} />}
      >
        <ul className="space-y-1.5 text-sm">
          {events.length === 0 && <li className="text-gray-500">Waiting for engine events...</li>}
          {events.map((e, i) => (
            <li key={i} className="flex items-start gap-2 border-b border-border/60 pb-1.5 last:border-0">
              <Badge text={String(e.type)} tone="neutral" />
              <span className="text-gray-300">{String(e.explanation ?? e.reason ?? JSON.stringify(e))}</span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
