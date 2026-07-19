"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/recommendations", label: "Recommendations" },
  { href: "/analytics", label: "Analytics" },
  { href: "/sessions", label: "Sessions" },
  { href: "/strategy", label: "Strategy" },
  { href: "/positions", label: "Positions" },
  { href: "/performance", label: "Performance" },
  { href: "/journal", label: "Journal" },
  { href: "/settings", label: "Settings" },
];

export function Nav() {
  const pathname = usePathname();
  return (
    // Solid background instead of backdrop-blur -- a sticky element blurring
    // actively-scrolling content underneath it forces the browser to
    // recompute that blur on every scroll frame, which is one of the more
    // expensive things you can ask Chromium to paint. bg-background/95 keeps
    // the same near-opaque look without the per-frame recomposition cost.
    <nav className="sticky top-0 z-20 flex items-center gap-1 border-b border-white/10 bg-background/95 px-6 py-3">
      <span className="mr-6 flex items-center gap-2 font-semibold tracking-tight text-white">
        <span className="h-2 w-2 rounded-full bg-accent shadow-glow-accent" />
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
    </nav>
  );
}
