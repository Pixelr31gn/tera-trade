"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/api";
import { DecidingVersionStatus } from "@/lib/types";
import { Badge } from "@/components/Badge";

const SESSION_LABELS: Record<string, string> = { new_york: "New York", london: "London", asian: "Asian" };

/** Shared SWR hook so the panel and the recommendation rows read one request. */
export function useDecidingVersion() {
  return useSWR<DecidingVersionStatus>("/api/analytics/deciding-version", fetcher, { refreshInterval: 15000 });
}

/**
 * "Deciding now" -- which version's score actually triggers trades this
 * session (2026-10-13, operator: "add some sort of indicator as to which v
 * that is so I can monitor it properly"). Mirrors the engine's own
 * session-best-version selection: one version alone once a version has
 * enough resolved setups this session, otherwise a v1/v2/v3 majority vote.
 */
export function DecidingVersionPanel() {
  const { data, error } = useDecidingVersion();

  if (error) {
    return <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-gray-400">Deciding now: unavailable</div>;
  }
  if (!data) {
    return <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-gray-500">Deciding now: loading...</div>;
  }

  const warmingUp = data.mode === "cold_start_majority";
  const leader = [...data.versions].filter((v) => v.resolvedCount > 0).sort((a, b) => b.resolvedCount - a.resolvedCount)[0];

  return (
    <div className={`rounded-2xl border px-4 py-3 backdrop-blur-xl ${warmingUp ? "border-warn/40 bg-warn/10" : "border-accent/40 bg-accent/10"}`}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs uppercase tracking-wide text-gray-400">Deciding now</span>
        {warmingUp ? (
          <span className="flex items-center gap-1">
            {data.countingVersions.map((v) => (
              <Badge key={v} text={v} tone="warn" />
            ))}
            <span className="ml-1 text-sm font-semibold text-warn">majority vote</span>
          </span>
        ) : (
          <span className="text-lg font-bold text-white">{data.decidingVersion?.toUpperCase()}</span>
        )}
        <span className="text-sm text-gray-300">{data.rule}</span>
        <span className="ml-auto text-xs text-gray-500">
          {SESSION_LABELS[data.session] ?? data.session} session since {new Date(data.sessionStart).toLocaleTimeString()}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-400">
        {data.versions.map((v) => (
          <span key={v.version} className={v.version === data.decidingVersion ? "font-semibold text-white" : ""}>
            {v.version}: {v.resolvedCount > 0 ? `${Math.round(v.winRate * 100)}% win` : "no results"} ({v.resolvedCount}/{data.minResolvedPerVersion}
            {v.eligible ? " eligible" : " needed"})
          </span>
        ))}
      </div>
      {warmingUp && leader && (
        <div className="mt-1 text-xs text-gray-500">
          Closest to taking over: {leader.version} with {leader.resolvedCount} of {data.minResolvedPerVersion} resolved setups.
        </div>
      )}
    </div>
  );
}
