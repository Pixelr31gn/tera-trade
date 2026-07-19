"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/api";
import { SessionPerformance, SessionLabelBreakdown } from "@/lib/types";
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

export default function SessionsPage() {
  const { data } = useSWR<Record<string, SessionPerformance>>("/api/analytics/session-performance", fetcher, {
    refreshInterval: 3600000, // backend caches this for 24h -- polling faster than that just re-requests the same cached response
  });

  return (
    <div className="space-y-6">
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
