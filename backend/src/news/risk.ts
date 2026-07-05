/**
 * News-driven risk windows: is `now` close enough to a high-impact release
 * that the risk engine should block new entries or shrink size?
 */
import { prisma } from "../db/client.js";
import { getSettings } from "../core/config.js";

export interface NewsRiskStatus {
  inRiskWindow: boolean;
  nearestEventName: string | null;
  nearestEventTime: Date | null;
  minutesToEvent: number | null;
  impact: string | null;
}

export async function getNewsRiskStatus(now: Date = new Date()): Promise<NewsRiskStatus> {
  const settings = getSettings();
  const windowMs = settings.newsRiskWindowMinutes * 60_000;

  const events = await prisma.newsEvent.findMany({
    where: {
      eventTime: { gte: new Date(now.getTime() - windowMs), lte: new Date(now.getTime() + windowMs) },
      ...(settings.newsHighImpactOnly ? { impact: "high" } : {}),
    },
    orderBy: { eventTime: "asc" },
  });

  if (events.length === 0) {
    return { inRiskWindow: false, nearestEventName: null, nearestEventTime: null, minutesToEvent: null, impact: null };
  }

  const nearest = events.reduce((closest, e) =>
    Math.abs(e.eventTime.getTime() - now.getTime()) < Math.abs(closest.eventTime.getTime() - now.getTime()) ? e : closest
  );
  const minutesToEvent = (nearest.eventTime.getTime() - now.getTime()) / 60_000;

  return {
    inRiskWindow: true,
    nearestEventName: nearest.name,
    nearestEventTime: nearest.eventTime,
    minutesToEvent,
    impact: nearest.impact,
  };
}
