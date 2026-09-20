"use client";

import { useState } from "react";
import useSWR from "swr";
import { apiFetch, fetcher } from "@/lib/api";
import { TailorBlueprint } from "@/lib/types";
import { Panel } from "@/components/Panel";
import { Badge } from "@/components/Badge";

export function TaylorPanel() {
  const { data: blueprints } = useSWR<TailorBlueprint[]>("/api/taylor/blueprints", fetcher, { refreshInterval: 30000 });
  const [openId, setOpenId] = useState<number | null>(null);
  const [content, setContent] = useState<Record<number, string>>({});
  const [loadingId, setLoadingId] = useState<number | null>(null);

  async function toggle(pitchId: number) {
    if (openId === pitchId) {
      setOpenId(null);
      return;
    }
    setOpenId(pitchId);
    if (!content[pitchId]) {
      setLoadingId(pitchId);
      try {
        const res = await apiFetch<{ pitchId: number; content: string }>(`/api/taylor/blueprints/${pitchId}`);
        setContent((c) => ({ ...c, [pitchId]: res.content }));
      } catch {
        setContent((c) => ({ ...c, [pitchId]: "Failed to load blueprint." }));
      } finally {
        setLoadingId(null);
      }
    }
  }

  return (
    <Panel title="Taylor Blueprints" action={<Badge text={`${blueprints?.length ?? 0}`} tone="neutral" />}>
      <div className="max-h-[50vh] space-y-2 overflow-y-auto">
        {blueprints?.map((b) => (
          <div key={b.pitchId} className="rounded-lg border border-white/10 bg-black/20 text-xs">
            <button onClick={() => toggle(b.pitchId)} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-white/[0.02]">
              <div>
                <span className="font-mono text-gray-500">pitch #{b.pitchId}</span>{" "}
                <span className="font-medium text-white">{b.pitchTitle}</span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge text={`rated ${b.pitchRatingAtGeneration}/5`} tone="neutral" />
                <span className="text-gray-600">{new Date(b.createdAt).toLocaleDateString()}</span>
              </div>
            </button>
            {openId === b.pitchId && (
              <div className="border-t border-white/10 px-3 py-2 text-gray-300">
                {loadingId === b.pitchId ? (
                  <p className="text-gray-500">Loading...</p>
                ) : (
                  <pre className="max-h-[40vh] overflow-y-auto whitespace-pre-wrap font-sans">{content[b.pitchId]}</pre>
                )}
              </div>
            )}
          </div>
        ))}
        {(!blueprints || blueprints.length === 0) && (
          <p className="py-6 text-center text-sm text-gray-500">No blueprints yet -- rate a Scout pitch 4/5 or higher to generate one.</p>
        )}
      </div>
    </Panel>
  );
}
