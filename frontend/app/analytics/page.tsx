"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/api";
import { OpeningRangeStats } from "@/lib/types";
import { Panel } from "@/components/Panel";
import { Badge } from "@/components/Badge";
import { ProbabilityBar } from "@/components/ProbabilityBar";

// Mirrors backend/src/scoring/ruleScorer.ts's MIN_OPENING_RANGE_SAMPLE_SIZE --
// below this, the stat is computed and shown, but the scoring engine ignores
// it entirely rather than let a handful of sessions swing a trade decision.
const MIN_SAMPLE_SIZE = 15;
const HIGH_CONFIDENCE_SAMPLE_SIZE = 40;

function confidenceLevel(sessions: number): { label: string; tone: "good" | "warn" | "bad"; usedInScoring: boolean } {
  if (sessions < MIN_SAMPLE_SIZE) return { label: "Not enough data yet", tone: "bad", usedInScoring: false };
  if (sessions < HIGH_CONFIDENCE_SAMPLE_SIZE) return { label: "Moderate confidence", tone: "warn", usedInScoring: true };
  return { label: "High confidence", tone: "good", usedInScoring: true };
}

export default function AnalyticsPage() {
  const { data } = useSWR<Record<string, OpeningRangeStats>>("/api/analytics/opening-range", fetcher, {
    refreshInterval: 30000,
  });

  return (
    <div className="space-y-6">
      <Panel title="Opening Range Breakout Statistics">
        <p className="text-sm text-gray-400">
          For each instrument: out of every historical trading session on record, how often did price break above the
          first hour&apos;s high, or below its low, later in the same session? This is a straight empirical count over
          real historical bars -- not a hand-tuned guess -- and it only influences the trade score once there are at
          least {MIN_SAMPLE_SIZE} sessions behind it.
        </p>
      </Panel>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {data &&
          Object.entries(data).map(([symbol, stats]) => {
            const confidence = confidenceLevel(stats.sessionsAnalyzed);
            return (
              <Panel
                key={symbol}
                title={symbol}
                action={<Badge text={`${stats.sessionsAnalyzed} sessions`} tone={confidence.tone} />}
              >
                <div className="space-y-4">
                  <div className="flex items-center justify-between rounded-md bg-white/5 px-3 py-2">
                    <span className="text-sm text-gray-300">{confidence.label}</span>
                    <Badge
                      text={confidence.usedInScoring ? "used in scoring" : "not used in scoring yet"}
                      tone={confidence.usedInScoring ? "good" : "neutral"}
                    />
                  </div>

                  {stats.sessionsAnalyzed === 0 ? (
                    <p className="text-sm text-gray-500">
                      No complete historical sessions yet -- this fills in as intraday price history accumulates.
                    </p>
                  ) : (
                    <div className="space-y-3">
                      <ProbabilityBar label="High broken later in session" value={stats.probHighBroken} tone="good" />
                      <ProbabilityBar label="Low broken later in session" value={stats.probLowBroken} tone="bad" />
                      <ProbabilityBar label="Both broken" value={stats.probBothBroken} tone="warn" />
                      <ProbabilityBar label="Neither broken (stayed inside the range)" value={stats.probNeitherBroken} tone="neutral" />
                    </div>
                  )}

                  <p className="text-xs text-gray-500">
                    {confidence.usedInScoring
                      ? `A long setup on ${symbol} gets credit toward its score proportional to how far "high broken" is from 50%; a short setup uses "low broken" the same way.`
                      : `Once ${symbol} has ${MIN_SAMPLE_SIZE}+ full sessions of history, this starts contributing to the score instead of being purely informational.`}
                  </p>
                </div>
              </Panel>
            );
          })}
        {!data && <p className="text-sm text-gray-500">Loading...</p>}
      </div>
    </div>
  );
}
