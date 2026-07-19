"use client";

import { useEffect, useRef, useState } from "react";
import { wsUrl } from "./api";

export interface LiveEvent {
  type: string;
  [key: string]: unknown;
}

/** Connects to /ws/live and keeps the most recent N events, reconnecting on drop. */
export function useLiveEvents(maxEvents = 50) {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  const nextId = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout>;

    function connect() {
      const ws = new WebSocket(wsUrl());
      wsRef.current = ws;

      ws.onopen = () => !cancelled && setConnected(true);
      ws.onclose = () => {
        if (cancelled) return;
        setConnected(false);
        retryTimer = setTimeout(connect, 3000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data) as LiveEvent;
          // A stable id at receipt time -- events prepend, so every visible
          // row's array index shifts on each new tick; keying by index there
          // makes React mutate existing DOM nodes instead of inserting one.
          setEvents((prev) => [{ ...parsed, __id: nextId.current++ }, ...prev].slice(0, maxEvents));
        } catch {
          // ignore malformed frames
        }
      };
    }

    connect();
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      wsRef.current?.close();
    };
  }, [maxEvents]);

  return { events, connected };
}
