/**
 * CME Globex futures electronic trading week: opens Sunday 6:00pm ET,
 * closes Friday 5:00pm ET. Outside that window (the Friday-evening through
 * Sunday-evening weekend gap) there's no real trading activity -- if the
 * browser tab stays open over the weekend, TopstepX can keep rendering a
 * frozen last price, and ticks from that would get written as fake
 * zero-volatility bars that corrupt ATR/regime/support-resistance detection
 * with data that was never a real market move.
 */
function etWeekdayAndHour(time: Date): { weekday: number; hour: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(time);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  // hour12:false renders midnight as "24", not "00" -- normalize back to 0.
  const hour = parseInt(get("hour"), 10) % 24;
  return { weekday: weekdayMap[get("weekday")] ?? 0, hour };
}

export function isInTradingWeek(time: Date): boolean {
  const { weekday, hour } = etWeekdayAndHour(time);
  if (weekday === 6) return false; // Saturday: always closed
  if (weekday === 0) return hour >= 18; // Sunday: opens 6pm ET
  if (weekday === 5) return hour < 17; // Friday: closes 5pm ET
  return true; // Mon-Thu: open (the ~1hr daily maintenance break isn't modeled here)
}
