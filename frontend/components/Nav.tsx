"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Overview" },
  { href: "/recommendations", label: "Recommendations" },
  { href: "/analytics", label: "Analytics" },
  { href: "/positions", label: "Positions" },
  { href: "/performance", label: "Performance" },
  { href: "/journal", label: "Journal" },
  { href: "/settings", label: "Settings" },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 border-b border-border px-6 py-3">
      <span className="mr-6 font-semibold tracking-tight text-white">Tera Trade</span>
      {LINKS.map((link) => {
        const active = pathname === link.href;
        return (
          <Link
            key={link.href}
            href={link.href}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
              active ? "bg-surface text-white" : "text-gray-400 hover:text-white"
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
