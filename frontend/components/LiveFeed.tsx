"use client";

import { memo } from "react";
import { useLiveEvents } from "@/lib/useLiveEvents";
import { Panel } from "@/components/Panel";
import { Badge } from "@/components/Badge";

// Owns its own websocket subscription rather than receiving events as a prop
// -- ticks arrive every few seconds, and keeping that state here means only
// this panel re-renders per tick instead of the whole dashboard page.
export const LiveFeed = memo(function LiveFeed() {
  const { events, connected } = useLiveEvents(20);

  return (
    <Panel title="Live Feed" action={<Badge text={connected ? "connected" : "reconnecting..."} tone={connected ? "good" : "warn"} />}>
      <ul className="max-h-64 space-y-1.5 overflow-y-auto text-sm">
        {events.length === 0 && <li className="text-gray-500">Waiting for engine events...</li>}
        {events.map((e) => (
          <li key={e.__id as number} className="flex items-start gap-2 border-b border-white/5 pb-1.5 last:border-0">
            <Badge text={String(e.type)} tone="neutral" />
            <span className="text-gray-300">{String(e.explanation ?? e.reason ?? JSON.stringify(e))}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
});
