/**
 * Direct client for Yahoo Finance's public (unofficial) chart endpoint --
 * the same data source the Python `yfinance` library wraps. No API key
 * needed, but it's an undocumented endpoint: fails soft (returns []) rather
 * than throwing, since this is best-effort free data.
 *
 * Real constraints that shape marketData/backfill.ts and marketData/live.ts:
 * - 1-minute bars: only the trailing ~7 days.
 * - Daily bars: full multi-year history.
 */
import { Decimal } from "decimal.js";
import { childLogger } from "../core/logger.js";

const logger = childLogger("yahooClient");

export interface YahooBar {
  time: Date;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  volume: Decimal;
}

interface YahooChartResponse {
  chart: {
    result: Array<{
      timestamp: number[];
      indicators: { quote: Array<{ open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[]; volume: (number | null)[] }> };
    }> | null;
    error: unknown;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseYahooChartResponse(dataSymbol: string, interval: string, range: string, data: YahooChartResponse): YahooBar[] {
  const result = data.chart.result?.[0];
  if (!result) {
    logger.warn({ dataSymbol }, "yahoo_chart_empty_result");
    return [];
  }

  const quote = result.indicators.quote[0];
  // Yahoo returns a "successful" response shape with no `timestamp` field and an
  // empty quote object when it has no data at this granularity for this symbol
  // (e.g. requesting interval=1m on a CME futures continuous contract, which the
  // free endpoint doesn't serve intraday minute bars for -- only 5m and coarser).
  if (!quote || !result.timestamp) {
    logger.warn({ dataSymbol, interval, range }, "yahoo_chart_no_data_at_this_granularity");
    return [];
  }

  const bars: YahooBar[] = [];
  for (let i = 0; i < result.timestamp.length; i++) {
    const o = quote.open[i];
    const h = quote.high[i];
    const l = quote.low[i];
    const c = quote.close[i];
    if (o == null || h == null || l == null || c == null) continue; // Yahoo pads gaps with nulls
    bars.push({
      time: new Date(result.timestamp[i]! * 1000),
      open: new Decimal(o),
      high: new Decimal(h),
      low: new Decimal(l),
      close: new Decimal(c),
      volume: new Decimal(quote.volume[i] ?? 0),
    });
  }
  return bars;
}

/**
 * Fetches one symbol's chart data, retrying on HTTP errors (Yahoo's
 * unauthenticated endpoint will occasionally rate-limit a rapid burst of
 * requests across symbols) with a short backoff. Still fails soft overall --
 * exhausting retries returns [], same as any other miss.
 */
export async function fetchYahooChart(dataSymbol: string, range: string, interval: string, maxAttempts = 3): Promise<YahooBar[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(dataSymbol)}?interval=${interval}&range=${range}`;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; TeraTrade/0.1)" } });
      if (!resp.ok) {
        logger.warn({ dataSymbol, status: resp.status, attempt }, "yahoo_chart_http_error");
        if (attempt < maxAttempts) {
          await sleep(500 * attempt);
          continue;
        }
        return [];
      }
      return parseYahooChartResponse(dataSymbol, interval, range, (await resp.json()) as YahooChartResponse);
    } catch (err) {
      logger.warn({ dataSymbol, err: String(err), attempt }, "yahoo_chart_fetch_failed");
      if (attempt < maxAttempts) {
        await sleep(500 * attempt);
        continue;
      }
      return [];
    }
  }
  return [];
}
