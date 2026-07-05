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
  const ts = data?.trade_stats;
  const ps = data?.portfolio_stats;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Trades" value={String(ts?.trade_count ?? 0)} />
        <StatCard label="Win Rate" value={pct(ts?.win_rate)} />
        <StatCard label="Expected Value" value={`$${num(ts?.expected_value, 2)}`} tone={(ts?.expected_value ?? 0) >= 0 ? "good" : "bad"} />
        <StatCard label="Profit Factor" value={ts?.profit_factor != null ? num(ts.profit_factor) : "n/a"} />
        <StatCard label="Sharpe" value={num(ps?.sharpe)} />
        <StatCard label="Sortino" value={num(ps?.sortino)} />
        <StatCard label="Max Drawdown" value={pct(ps?.max_drawdown_pct)} tone="bad" />
        <StatCard label="Volatility (ann.)" value={pct(ps?.volatility_annualized)} />
        <StatCard label="Avg Win" value={`$${num(ts?.avg_win)}`} tone="good" />
        <StatCard label="Avg Loss" value={`$${num(ts?.avg_loss)}`} tone="bad" />
        <StatCard label="Avg MAE" value={ts?.avg_mae != null ? num(ts.avg_mae) : "-"} />
        <StatCard label="Avg MFE" value={ts?.avg_mfe != null ? num(ts.avg_mfe) : "-"} />
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
                Object.entries(data.by_strategy).map(([k, v]) => (
                  <tr key={k}>
                    <td className="text-white">{k}</td>
                    <td>{v.trade_count}</td>
                    <td>{pct(v.win_rate)}</td>
                    <td className={v.total_pnl >= 0 ? "text-good" : "text-bad"}>${v.total_pnl.toFixed(0)}</td>
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
                Object.entries(data.by_regime).map(([k, v]) => (
                  <tr key={k}>
                    <td className="text-white">{k}</td>
                    <td>{v.trade_count}</td>
                    <td>{pct(v.win_rate)}</td>
                    <td className={v.total_pnl >= 0 ? "text-good" : "text-bad"}>${v.total_pnl.toFixed(0)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </Panel>
      </div>
    </div>
  );
}
