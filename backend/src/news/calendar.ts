/**
 * Free economic-calendar ingestion.
 *
 * Primary source: Forex Factory's public weekly JSON feed. It's an
 * unofficial, undocumented endpoint (no official ForexFactory API exists) --
 * fragile by nature, so this module fails soft: on any fetch/parse error it
 * logs and leaves existing news_events rows untouched rather than throwing.
 */
import { prisma } from "../db/client.js";
import { getSettings } from "../core/config.js";
import { childLogger } from "../core/logger.js";

const logger = childLogger("newsCalendar");

const IMPACT_MAP: Record<string, string> = {
  high: "high",
  red: "high",
  "3": "high",
  medium: "medium",
  orange: "medium",
  yellow: "medium",
  "2": "medium",
  low: "low",
  "1": "low",
  "0": "low",
};

interface RawCalendarEvent {
  date?: string | number;
  dateline?: string | number;
  country?: string;
  title?: string;
  event?: string;
  impact?: string | number;
  actual?: string | number;
  forecast?: string | number;
  previous?: string | number;
}

interface ParsedEvent {
  eventTime: Date;
  country: string;
  name: string;
  impact: string;
  actual: string | null;
  forecast: string | null;
  previous: string | null;
}

function normalizeImpact(raw: string | number | undefined): string {
  const key = String(raw ?? "").trim().toLowerCase();
  return IMPACT_MAP[key] ?? "low";
}

function parseEvents(rawItems: RawCalendarEvent[]): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  for (const item of rawItems) {
    try {
      const dateVal = item.date ?? item.dateline;
      let eventTime: Date;
      if (typeof dateVal === "number") {
        eventTime = new Date(dateVal * 1000);
      } else if (typeof dateVal === "string") {
        eventTime = new Date(dateVal);
      } else {
        continue;
      }
      if (Number.isNaN(eventTime.getTime())) continue;

      events.push({
        eventTime,
        country: String(item.country ?? "").toUpperCase().slice(0, 8),
        name: String(item.title ?? item.event ?? "Unknown event").slice(0, 256),
        impact: normalizeImpact(item.impact),
        actual: item.actual !== undefined && item.actual !== "" ? String(item.actual).slice(0, 64) : null,
        forecast: item.forecast !== undefined && item.forecast !== "" ? String(item.forecast).slice(0, 64) : null,
        previous: item.previous !== undefined && item.previous !== "" ? String(item.previous).slice(0, 64) : null,
      });
    } catch {
      logger.warn({ item }, "skip_unparseable_event");
    }
  }
  return events;
}

export async function fetchCalendarJson(): Promise<RawCalendarEvent[]> {
  const settings = getSettings();
  try {
    const resp = await fetch(settings.newsCalendarUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!resp.ok) {
      logger.warn({ status: resp.status }, "fetch_failed");
      return [];
    }
    return (await resp.json()) as RawCalendarEvent[];
  } catch (err) {
    logger.warn({ err: String(err) }, "fetch_failed");
    return [];
  }
}

export async function refreshCalendar(): Promise<number> {
  const rawItems = await fetchCalendarJson();
  const events = parseEvents(rawItems);
  if (events.length === 0) return 0;

  for (const event of events) {
    await prisma.newsEvent.upsert({
      where: { eventTime_country_name: { eventTime: event.eventTime, country: event.country, name: event.name } },
      update: { actual: event.actual, forecast: event.forecast, previous: event.previous },
      create: event,
    });
  }
  logger.info({ count: events.length }, "refreshed");
  return events.length;
}
