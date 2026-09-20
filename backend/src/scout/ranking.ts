/**
 * Scout's pitch ranking -- a rough sort key, not a precise utility score. Three inputs, all
 * already on ScoutPitch: how often the underlying friction has actually recurred
 * (occurrenceCount), how recently (lastSeenAt), and what the operator thought of it (rating).
 *
 * Recency uses exponential decay rather than a hard cutoff so a pitch that goes quiet just sinks
 * gradually -- never disappears (rows are never deleted, see schema.prisma's ScoutPitch header
 * comment) -- and can climb back on its own the moment the same friction is observed again and
 * write_pitch bumps occurrenceCount/lastSeenAt.
 */

const RECENCY_HALF_LIFE_DAYS = 14;

// occurrenceCount is unbounded (a pitch seen 40 times keeps incrementing forever) -- log2 keeps
// one very hot pitch from permanently burying everything else instead of ranking purely on raw
// repetition count.
function frequencyComponent(occurrenceCount: number): number {
  return Math.log2(Math.max(1, occurrenceCount) + 1) * 10;
}

function recencyWeight(lastSeenAt: Date, now: Date): number {
  const daysSince = Math.max(0, (now.getTime() - lastSeenAt.getTime()) / 86_400_000);
  return Math.pow(0.5, daysSince / RECENCY_HALF_LIFE_DAYS);
}

// A 1-star pitch should rank well below an unrated one, a 5-star well above -- but an unrated
// pitch (the common case for anything Scout just drafted) should neither get a free boost nor be
// penalized for not having been reviewed yet. Table, not a formula, so the exact tuning is
// legible at a glance rather than backed out of an equation.
const RATING_MULTIPLIER: Record<number, number> = { 1: 0.25, 2: 0.6, 3: 1.0, 4: 1.5, 5: 2.25 };

function ratingMultiplier(rating: number | null): number {
  if (rating === null) return 1;
  return RATING_MULTIPLIER[rating] ?? 1;
}

export function computeScore(input: { occurrenceCount: number; lastSeenAt: Date; rating: number | null }, now: Date = new Date()): number {
  return frequencyComponent(input.occurrenceCount) * recencyWeight(input.lastSeenAt, now) * ratingMultiplier(input.rating);
}
