const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// credentials: "include" sends the httpOnly session cookie set by
// POST /api/auth/login (see lib/auth.ts) across the :3000 -> :8000 port
// split. Replaces the API key that used to be baked into this file's public
// JS bundle (NEXT_PUBLIC_API_KEY, readable by anyone via view-source) --
// that never actually gated a human from using the dashboard, only other
// programmatic callers; the login screen (components/LoginGate.tsx) is what
// gates the dashboard now.
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers || {}),
    },
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(text || res.statusText, res.status);
  }
  return res.json() as Promise<T>;
}

// No api_key query param needed -- the browser attaches the session cookie
// to the WS handshake request automatically (same as any other request to
// this host), since native WebSocket can't set custom headers.
export function wsUrl(): string {
  const base = API_BASE.replace(/^http/, "ws");
  return `${base}/ws/live`;
}

export const fetcher = <T>(path: string) => apiFetch<T>(path);
