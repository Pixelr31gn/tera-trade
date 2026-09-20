"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { logout } from "@/lib/auth";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/assistant", label: "Assistant" },
  { href: "/recommendations", label: "Recommendations" },
  { href: "/journal", label: "Journal" },
  { href: "/analytics", label: "Analytics" },
  { href: "/sessions", label: "Sessions" },
  { href: "/strategy", label: "Strategy" },
  { href: "/performance", label: "Performance" },
  { href: "/settings", label: "Settings" },
];

export function Nav() {
  const pathname = usePathname();

  async function handleLogout() {
    await logout();
    // Full reload, not client-side state, so LoginGate re-runs its mount-time
    // session check against the now-cleared cookie.
    window.location.reload();
  }

  return (
    // Solid background instead of backdrop-blur -- a sticky element blurring
    // actively-scrolling content underneath it forces the browser to
    // recompute that blur on every scroll frame, which is one of the more
    // expensive things you can ask Chromium to paint. bg-background/95 keeps
    // the same near-opaque look without the per-frame recomposition cost.
    <nav className="sticky top-0 z-20 flex items-center gap-1 border-b border-white/10 bg-background/95 px-6 py-3">
      <span className="mr-6 flex items-center gap-2 font-semibold tracking-tight text-white">
        <svg
          viewBox="0 0 24 24"
          className="h-4 w-4 shrink-0 text-accent"
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
        Tera Trade
      </span>
      {LINKS.map((link) => {
        const active = pathname === link.href;
        return (
          <Link
            key={link.href}
            href={link.href}
            className={`rounded-lg px-3 py-1.5 text-sm transition-all duration-200 ${
              active
                ? "bg-white/[0.06] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]"
                : "text-gray-400 hover:bg-white/[0.03] hover:text-white"
            }`}
          >
            {link.label}
          </Link>
        );
      })}
      <button
        onClick={handleLogout}
        className="ml-auto rounded-lg px-3 py-1.5 text-sm text-gray-400 transition-all duration-200 hover:bg-white/[0.03] hover:text-white"
      >
        Log out
      </button>
    </nav>
  );
}
