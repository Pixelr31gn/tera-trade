export function StatCard({
  label,
  value,
  tone = "neutral",
  sub,
}: {
  label: string;
  value: string;
  tone?: "good" | "bad" | "warn" | "neutral";
  sub?: string;
}) {
  const toneClass = {
    good: "text-good",
    bad: "text-bad",
    warn: "text-warn",
    neutral: "text-white",
  }[tone];

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 shadow-glass backdrop-blur-xl">
      <div className="text-xs uppercase tracking-wide text-gray-400">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${toneClass}`}>{value}</div>
      {sub && <div className="mt-1 text-xs text-gray-500">{sub}</div>}
    </div>
  );
}
