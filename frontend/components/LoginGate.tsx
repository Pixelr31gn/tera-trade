"use client";

import { FormEvent, useEffect, useState } from "react";
import { checkSession, login } from "@/lib/auth";

// Gates the whole dashboard behind the shared password (see backend's
// api/routes/auth.ts) -- checked client-side, on mount, since the packaged
// .exe build serves this app as a plain static export with no server of its
// own to gate at the routing layer (see frontend/next.config.mjs's
// "output: export" comment). A future TOTP second factor adds a second
// screen here (code entry after a successful password) without touching how
// this wraps its children.
export function LoginGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<"checking" | "authenticated" | "unauthenticated">("checking");

  useEffect(() => {
    let cancelled = false;
    checkSession().then((authenticated) => {
      if (!cancelled) setStatus(authenticated ? "authenticated" : "unauthenticated");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (status === "checking") return null;
  if (status === "unauthenticated") {
    return <LoginScreen onSuccess={() => setStatus("authenticated")} />;
  }
  return <>{children}</>;
}

function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const failure = await login(password);
    setSubmitting(false);
    if (failure) {
      setError(failure);
      return;
    }
    onSuccess();
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-2xl border border-white/10 bg-surface p-6 shadow-glass"
      >
        <div className="mb-6 flex items-center gap-2 font-semibold tracking-tight text-white">
          <svg
            viewBox="0 0 24 24"
            className="h-5 w-5 shrink-0 text-accent"
            style={{ filter: "drop-shadow(0 0 5px rgba(125,211,252,0.55))" }}
            fill="currentColor"
            aria-hidden="true"
          >
            <ellipse cx="12" cy="16.5" rx="6.2" ry="5" />
            <ellipse cx="4" cy="10" rx="2" ry="2.6" />
            <ellipse cx="8.5" cy="5.5" rx="2.1" ry="2.8" />
            <ellipse cx="15.5" cy="5.5" rx="2.1" ry="2.8" />
            <ellipse cx="20" cy="10" rx="2" ry="2.6" />
          </svg>
          <span className="text-lg">Tera Trade</span>
        </div>

        <label htmlFor="password" className="mb-1.5 block text-sm text-gray-400">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-lg border border-white/10 bg-background px-3 py-2 text-sm text-gray-100 outline-none focus:border-accent/50"
        />

        {error && <p className="mt-2 text-sm text-bad">{error}</p>}

        <button
          type="submit"
          disabled={submitting || password.length === 0}
          className="mt-4 w-full rounded-lg bg-accent/90 px-3 py-2 text-sm font-semibold text-background transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </div>
  );
}
