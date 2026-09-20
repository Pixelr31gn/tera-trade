"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/api";
import { SessionPerformance, SessionLabelBreakdown, DealerLevelsBySymbol } from "@/lib/types";
import { Panel } from "@/components/Panel";
import { Badge } from "@/components/Badge";
import { ProbabilityBar } from "@/components/ProbabilityBar";

const SESSION_LABELS: Record<string, string> = {
  new_york: "New York",
  london: "London",
  asian: "Asian",
};

const SESSION_ORDER = ["new_york", "london", "asian"];

const OUTCOME_LABELS: Record<string, string> = {
  executed_win: "Executed - won",
  executed_loss: "Executed - lost",
  missed_win: "Skipped - would have won",
  missed_loss: "Skipped - would have lost",
  no_resolution: "Skipped - never resolved",
  pending: "Awaiting outcome",
};

const OUTCOME_TONE: Record<string, "good" | "bad" | "warn" | "neutral"> = {
  executed_win: "good",
  executed_loss: "bad",
  missed_win: "warn",
  missed_loss: "neutral",
  no_resolution: "neutral",
  pending: "neutral",
};

function confidenceLevel(resolvedCount: number, minRequired: number): { label: string; tone: "good" | "warn" | "bad" } {
  if (resolvedCount < minRequired * 0.25) return { label: "Very little data yet", tone: "bad" };
  if (resolvedCount < minRequired) return { label: "Building sample size", tone: "warn" };
  return { label: "Enough data to train a model", tone: "good" };
}

function LabelBreakdownTable({ title, breakdown }: { title: string; breakdown: Record<string, SessionLabelBreakdown> }) {
  const entries = Object.entries(breakdown).sort((a, b) => b[1].sampleSize - a[1].sampleSize);
  if (entries.length === 0) return null;

  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">{title}</h3>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-gray-500">
            <th className="pb-1 font-medium">Label</th>
            <th className="pb-1 font-medium">Samples</th>
            <th className="pb-1 font-medium">Win rate</th>
            <th className="pb-1 font-medium">Avg R</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([label, stats]) => (
            <tr key={label} className="border-t border-white/5">
              <td className="py-1 text-gray-300">{label.replace(/_/g, " ")}</td>
              <td className="py-1 text-gray-400">{stats.sampleSize}</td>
              <td className="py-1 text-gray-400">
                {stats.winRate !== null ? `${Math.round(stats.winRate * 100)}% (${stats.resolvedCount} resolved)` : "n/a"}
              </td>
              <td className="py-1 text-gray-400">{stats.avgRMultiple !== null ? stats.avgRMultiple.toFixed(2) : "n/a"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DealerLevelReportPanel() {
  const { data } = useSWR<Record<string, string>>("/api/dealer-levels/report", fetcher, {
    refreshInterval: 60000,
  });

  const symbols = data ? Object.keys(data).sort() : [];

  return (
    <Panel title="Session Report">
      <p className="mb-4 text-sm text-gray-400">
        Generated from real, currently-known data only -- dealer GEX levels, 10Y yield, VIX, and regime state. No
        invented scenario odds: Tera Trade is accumulating its own real historical hold-rate data (see the hold-rate
        lines below) rather than guessing at percentages the way a paid vendor report would.
      </p>
      {symbols.length === 0 ? (
        <p className="text-sm text-gray-500">No report available yet -- dealer levels haven&apos;t been computed for any symbol this session.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {symbols.map((symbol) => (
            <pre key={symbol} className="whitespace-pre-wrap rounded-xl border border-white/10 bg-white/[0.02] p-4 font-mono text-xs text-gray-300">
              {data![symbol]}
            </pre>
          ))}
        </div>
      )}
    </Panel>
  );
}

function DealerLevelsPanel() {
  const { data } = useSWR<DealerLevelsBySymbol>("/api/dealer-levels", fetcher, {
    refreshInterval: 60000, // levels only change once per session -- a minute is plenty responsive without hammering the endpoint
  });

  const symbols = data ? Object.keys(data).sort() : [];

  return (
    <Panel title="Dealer GEX Levels">
      <p className="mb-4 text-sm text-gray-400">
        Options-derived dealer positioning (call wall, put wall, gamma flip) computed each session from CBOE&apos;s free
        delayed options chain -- ES from SPX options, NQ from NDX options (see backend/src/analytics/dealerGex.ts). Live
        entries are gated to within 1.0x ATR of one of these levels; &quot;confirmed&quot; means that wall also lines up
        with a real price-action support/resistance pivot right now.
      </p>
      {symbols.length === 0 ? (
        <p className="text-sm text-gray-500">No dealer levels computed yet this session.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {symbols.map((symbol) => {
            const levels = data![symbol]!;
            return (
              <div key={symbol} className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-sm font-semibold text-white">{symbol}</span>
                  <Badge text={SESSION_LABELS[levels.session] ?? levels.session} tone="neutral" />
                </div>
                <dl className="space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <dt className="text-gray-400">Spot</dt>
                    <dd className="text-gray-200">{Number(levels.spotPrice).toFixed(2)}</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-gray-400">Call wall (ceiling)</dt>
                    <dd className="flex items-center gap-2">
                      <span className="text-gray-200">{levels.callWall ? Number(levels.callWall).toFixed(2) : "n/a"}</span>
                      {levels.callWall && (
                        <Badge
                          text={levels.callWallConfirmedByPriceAction ? "confirmed" : "unconfirmed"}
                          tone={levels.callWallConfirmedByPriceAction ? "good" : "neutral"}
                        />
                      )}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-gray-400">Put wall (floor)</dt>
                    <dd className="flex items-center gap-2">
                      <span className="text-gray-200">{levels.putWall ? Number(levels.putWall).toFixed(2) : "n/a"}</span>
                      {levels.putWall && (
                        <Badge
                          text={levels.putWallConfirmedByPriceAction ? "confirmed" : "unconfirmed"}
                          tone={levels.putWallConfirmedByPriceAction ? "good" : "neutral"}
                        />
                      )}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-gray-400">Gamma flip (pivot)</dt>
                    <dd className="text-gray-200">{levels.gammaFlip ? Number(levels.gammaFlip).toFixed(2) : "n/a"}</dd>
                  </div>
                </dl>
                <p className="mt-3 text-xs text-gray-500">as of {new Date(levels.time).toLocaleString()}</p>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

export default function SessionsPage() {
  const { data } = useSWR<Record<string, SessionPerformance>>("/api/analytics/session-performance", fetcher, {
    refreshInterval: 3600000, // backend caches this for 24h -- polling faster than that just re-requests the same cached response
  });

  return (
    <div className="space-y-6">
      <DealerLevelReportPanel />
      <DealerLevelsPanel />

      <Panel title="Session-Segmented Trade Data">
        <p className="text-sm text-gray-400">
          New York, London, and Asian sessions are never blended together -- each has its own dataset of every setup the
          system has scored (taken or skipped), its own retrospective win/loss labeling for setups that were skipped,
          and once enough labeled setups accumulate, its own independently trained scoring model. This page shows how
          much data backs each session and how it has actually performed.
        </p>
      </Panel>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {SESSION_ORDER.map((session) => {
          const stats = data?.[session];
          if (!stats) {
            return (
              <Panel key={session} title={SESSION_LABELS[session]}>
                <p className="text-sm text-gray-500">Loading...</p>
              </Panel>
            );
          }

          const confidence = confidenceLevel(stats.resolvedCount, stats.minRowsRequiredForModel);

          return (
            <Panel
              key={session}
              title={SESSION_LABELS[session]}
              action={<Badge text={stats.modelTrained ? "ML model active" : "rule-based scoring"} tone={stats.modelTrained ? "good" : "neutral"} />}
            >
              <div className="space-y-4">
                <div className="flex items-center justify-between rounded-md bg-white/5 px-3 py-2">
                  <span className="text-sm text-gray-300">{confidence.label}</span>
                  <Badge text={`${stats.resolvedCount}/${stats.minRowsRequiredForModel} resolved`} tone={confidence.tone} />
                </div>

                {stats.totalScores === 0 ? (
                  <p className="text-sm text-gray-500">No setups scored in this session yet.</p>
                ) : (
                  <>
                    <ProbabilityBar
                      label="Win rate (executed + would-have-been)"
                      value={stats.winRate}
                      tone={stats.winRate === null ? "neutral" : stats.winRate >= 0.5 ? "good" : "bad"}
                    />
                    <p className="text-xs text-gray-500">
                      Avg R multiple across resolved setups: {stats.avgRMultiple !== null ? stats.avgRMultiple.toFixed(2) : "n/a"}
                    </p>

                    <div className="space-y-1">
                      {Object.entries(stats.outcomeCounts).map(([label, count]) => (
                        <div key={label} className="flex items-center justify-between text-xs">
                          <span className="text-gray-400">{OUTCOME_LABELS[label] ?? label}</span>
                          <Badge text={String(count)} tone={OUTCOME_TONE[label] ?? "neutral"} />
                        </div>
                      ))}
                    </div>

                    <div className="space-y-3 border-t border-white/5 pt-3">
                      <LabelBreakdownTable title="By market structure" breakdown={stats.byMarketStructure} />
                      <LabelBreakdownTable title="By liquidity" breakdown={stats.byLiquidity} />
                      <LabelBreakdownTable title="By price action" breakdown={stats.byPriceAction} />
                    </div>
                  </>
                )}
              </div>
            </Panel>
          );
        })}
      </div>
    </div>
  );
}
