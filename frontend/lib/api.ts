const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";
const API_KEY = process.env.NEXT_PUBLIC_API_KEY || "";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      "X-API-Key": API_KEY,
      ...(init?.headers || {}),
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(text || res.statusText, res.status);
  }
  return res.json() as Promise<T>;
}

export function wsUrl(): string {
  const base = API_BASE.replace(/^http/, "ws");
  return `${base}/ws/live?api_key=${encodeURIComponent(API_KEY)}`;
}

export const fetcher = <T>(path: string) => apiFetch<T>(path);
