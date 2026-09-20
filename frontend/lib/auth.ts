const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

export async function checkSession(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/api/auth/session`, { credentials: "include", cache: "no-store" });
    if (!res.ok) return false;
    const body = (await res.json()) as { authenticated: boolean };
    return body.authenticated;
  } catch {
    return false;
  }
}

// Returns an error message on failure, null on success -- avoids a custom
// error class for what's just displayed directly under the password field.
export async function login(password: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ password }),
    });
    if (res.ok) return null;
    const body = await res.json().catch(() => null);
    return (body?.error as string | undefined) ?? "Login failed";
  } catch {
    return "Could not reach the backend -- is it running?";
  }
}

export async function logout(): Promise<void> {
  await fetch(`${API_BASE}/api/auth/logout`, { method: "POST", credentials: "include" }).catch(() => {});
}
