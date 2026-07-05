"use client";

import useSWR from "swr";
import { apiFetch, fetcher } from "@/lib/api";
import { ActionableRecommendation } from "@/lib/types";
import { Badge } from "@/components/Badge";

function relativeMinutes(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes <= 0) return "just now";
  if (minutes === 1) return "1 min ago";
  return `${minutes} min ago`;
}

export function ActionBanner() {
  const { data, mutate } = useSWR<ActionableRecommendation[]>("/api/recommendations/actionable", fetcher, {
    refreshInterval: 8000,
  });

  if (!data || data.length === 0) return null;

  async function acknowledge(id: number) {
    await apiFetch(`/api/recommendations/${id}/acknowledge`, { method: "POST" });
    mutate();
  }

  return (
    <div className="space-y-3">
      {data.map((rec) => {
        const isStale = rec.actionability === "stale";
        const isLong = rec.side === "long";
        return (
          <div
            key={rec.id}
            className={`rounded-lg border-2 px-5 py-4 ${
              isStale ? "border-warn/40 bg-warn/5" : isLong ? "border-good/50 bg-good/10" : "border-bad/50 bg-bad/10"
            }`}
          >
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <span className={`text-lg font-bold ${isLong ? "text-good" : "text-bad"}`}>
                  {isStale ? "CONSIDER" : "PLACE"} {rec.side.toUpperCase()} {rec.symbol}
                </span>
                <Badge text={`${Math.round(rec.probability * 100)}% confidence`} tone={isStale ? "warn" : isLong ? "good" : "bad"} />
                {isStale && <Badge text="stale -- recheck the market" tone="warn" />}
                <span className="text-xs text-gray-500">{relativeMinutes(rec.time)}</span>
              </div>
              <button
                onClick={() => acknowledge(rec.id)}
                className="whitespace-nowrap rounded-md bg-white/10 px-3 py-1.5 text-xs font-medium text-white hover:bg-white/20"
              >
                I placed this / dismiss
              </button>
            </div>
            <p className="mt-2 text-sm text-gray-300">{rec.explanation}</p>
          </div>
        );
      })}
    </div>
  );
}
