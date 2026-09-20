"use client";

import { useState } from "react";
import useSWR from "swr";
import { apiFetch, fetcher } from "@/lib/api";
import { ScoutPitchesResponse } from "@/lib/types";
import { Panel } from "@/components/Panel";
import { Badge } from "@/components/Badge";

const CATEGORY_TONE: Record<string, "good" | "warn" | "neutral"> = {
  both: "good",
  friction: "warn",
  frequency: "neutral",
};

function RatingStars({ pitchId, onRate, rating: submitting }: { pitchId: number; onRate: (rating: number, note: string) => void; rating: boolean }) {
  const [note, setNote] = useState("");
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="optional note"
        disabled={submitting}
        className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/20 px-2 py-1 text-xs text-white placeholder:text-gray-600"
      />
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            disabled={submitting}
            onClick={() => onRate(n, note)}
            title={`Rate ${n}/5`}
            className="h-6 w-6 rounded-full border border-white/10 bg-white/5 text-xs font-semibold text-gray-300 transition-colors hover:border-accent/50 hover:bg-accent/20 hover:text-white disabled:opacity-40"
          >
            {n}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ScoutPanel() {
  const { data, mutate } = useSWR<ScoutPitchesResponse>("/api/scout/pitches", fetcher, { refreshInterval: 30000 });
  const [ratingId, setRatingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function rate(id: number, rating: number, note: string) {
    setRatingId(id);
    setError(null);
    try {
      await apiFetch(`/api/scout/pitches/${id}/rate`, { method: "POST", body: JSON.stringify({ rating, note: note || undefined }) });
      await mutate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to submit rating");
    } finally {
      setRatingId(null);
    }
  }

  const pitches = data?.pitches ?? [];
  const openCount = pitches.filter((p) => p.rating === null).length;

  return (
    <Panel title="Scout Pitches" action={<Badge text={`${openCount} unrated`} tone={openCount > 0 ? "warn" : "neutral"} />}>
      {data && (
        <p className="mb-3 text-xs text-gray-500">
          Rate {data.taylorApprovalMinRating}/5 or higher to hand a pitch to Taylor for a real blueprint.
        </p>
      )}
      {error && <p className="mb-2 text-xs text-bad">{error}</p>}
      <div className="max-h-[50vh] space-y-3 overflow-y-auto">
        {pitches.map((p) => (
          <div key={p.id} className="rounded-lg border border-white/10 bg-black/20 px-3 py-2.5 text-xs">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="font-mono text-gray-500">#{p.id}</span>
              <Badge text={p.category} tone={CATEGORY_TONE[p.category] ?? "neutral"} />
              <span className="text-gray-500">seen {p.occurrenceCount}x</span>
              <span className="text-gray-500">score {p.score.toFixed(2)}</span>
              {p.status === "blueprinted" && <Badge text="blueprinted" tone="good" />}
              {p.rating !== null && <Badge text={`rated ${p.rating}/5`} tone="neutral" />}
            </div>
            <p className="font-medium text-white">{p.title}</p>
            <p className="mt-0.5 text-gray-400">{p.problem}</p>
            {p.rating === null ? (
              <RatingStars pitchId={p.id} rating={ratingId === p.id} onRate={(rating, note) => rate(p.id, rating, note)} />
            ) : (
              p.ratingNote && <p className="mt-1 italic text-gray-500">&ldquo;{p.ratingNote}&rdquo;</p>
            )}
          </div>
        ))}
        {pitches.length === 0 && <p className="py-6 text-center text-sm text-gray-500">No pitches yet.</p>}
      </div>
    </Panel>
  );
}
