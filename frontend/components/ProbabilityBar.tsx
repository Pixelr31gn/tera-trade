export function ProbabilityBar({ label, value, tone = "neutral" }: { label: string; value: number | null; tone?: "good" | "bad" | "warn" | "neutral" }) {
  const barColor = { good: "bg-good", bad: "bg-bad", warn: "bg-warn", neutral: "bg-accent" }[tone];
  const pct = value !== null ? Math.round(value * 100) : null;

  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-gray-400">{label}</span>
        <span className="font-medium text-white">{pct !== null ? `${pct}%` : "n/a"}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
        {pct !== null && <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />}
      </div>
    </div>
  );
}
