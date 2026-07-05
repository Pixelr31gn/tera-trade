"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/api";
import { PerformanceSummary } from "@/lib/types";
import { StatCard } from "@/components/StatCard";
import { Panel } from "@/components/Panel";

function pct(x: number | null | undefined, digits = 1): string {
  return x === null || x === undefined ? "-" : `${(x * 100).toFixed(digits)}%`;
}

function num(x: number | null | undefined, digits = 2): string {
  return x === null || x === undefined ? "-" : x.toFixed(digits);
}

export default function PerformancePage() {
  const { data } = useSWR<PerformanceSummary>("/api/performance/summary", fetcher, { refreshInterval: 20000 });
  const ts = data?.tradeStats;
  const ps = data?.portfolioStats;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Trades" value={String(ts?.tradeCount ?? 0)} />
        <StatCard label="Win Rate" value={pct(ts?.winRate)} />
        <StatCard label="Expected Value" value={`$${num(ts?.expectedValue, 2)}`} tone={(ts?.expectedValue ?? 0) >= 0 ? "good" : "bad"} />
        <StatCard label="Profit Factor" value={ts?.profitFactor != null ? num(ts.profitFactor) : "n/a"} />
        <StatCard label="Sharpe" value={num(ps?.sharpe)} />
        <StatCard label="Sortino" value={num(ps?.sortino)} />
        <StatCard label="Max Drawdown" value={pct(ps?.maxDrawdownPct)} tone="bad" />
        <StatCard label="Volatility (ann.)" value={pct(ps?.volatilityAnnualized)} />
        <StatCard label="Avg Win" value={`$${num(ts?.avgWin)}`} tone="good" />
        <StatCard label="Avg Loss" value={`$${num(ts?.avgLoss)}`} tone="bad" />
        <StatCard label="Avg MAE" value={ts?.avgMae != null ? num(ts.avgMae) : "-"} />
        <StatCard label="Avg MFE" value={ts?.avgMfe != null ? num(ts.avgMfe) : "-"} />
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <Panel title="By Strategy">
          <table>
            <thead>
              <tr>
                <th>Strategy</th>
                <th>Trades</th>
                <th>Win Rate</th>
                <th>Total P&L</th>
              </tr>
            </thead>
            <tbody>
              {data &&
                Object.entries(data.byStrategy).map(([k, v]) => (
                  <tr key={k}>
                    <td className="text-white">{k}</td>
                    <td>{v.tradeCount}</td>
                    <td>{pct(v.winRate)}</td>
                    <td className={v.totalPnl >= 0 ? "text-good" : "text-bad"}>${v.totalPnl.toFixed(0)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="By Regime (trend/vol at entry)">
          <table>
            <thead>
              <tr>
                <th>Regime</th>
                <th>Trades</th>
                <th>Win Rate</th>
                <th>Total P&L</th>
              </tr>
            </thead>
            <tbody>
              {data &&
                Object.entries(data.byRegime).map(([k, v]) => (
                  <tr key={k}>
                    <td className="text-white">{k}</td>
                    <td>{v.tradeCount}</td>
                    <td>{pct(v.winRate)}</td>
                    <td className={v.totalPnl >= 0 ? "text-good" : "text-bad"}>${v.totalPnl.toFixed(0)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </Panel>
      </div>
    </div>
  );
}
