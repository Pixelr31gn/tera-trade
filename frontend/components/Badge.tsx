export function Badge({ text, tone = "neutral" }: { text: string; tone?: "good" | "bad" | "warn" | "neutral" }) {
  const toneClass = {
    good: "bg-good/15 text-good border-good/30",
    bad: "bg-bad/15 text-bad border-bad/30",
    warn: "bg-warn/15 text-warn border-warn/30",
    neutral: "bg-white/10 text-gray-300 border-white/10",
  }[tone];

  return <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${toneClass}`}>{text}</span>;
}
