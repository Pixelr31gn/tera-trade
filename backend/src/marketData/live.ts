/**
 * Live bar pipeline for the free-data path.
 *
 * Yahoo Finance has no real push/streaming API, so "live" here means polling
 * for the latest completed 1-minute bar on an interval and treating each new
 * bar as a tick for the engine loop. This is what "real-time" honestly means
 * without a paid market-data vendor or a connected ProjectX Gateway account;
 * once the user has ProjectX credentials, `ProjectXGatewayBroker.startMarketStream()`
 * should be used instead for true push-based quotes.
 */
import { Decimal } from "decimal.js";
import { prisma } from "../db/client.js";
import { childLogger } from "../core/logger.js";
import { DEFAULT_INSTRUMENTS, type InstrumentSpec } from "./instruments.js";
import { fetchYahooChart } from "./yahooClient.js";

const logger = childLogger("liveBarPoller");

export type NewBarHandler = (
  symbol: string,
  time: Date,
  open: Decimal,
  high: Decimal,
  low: Decimal,
  close: Decimal,
  volume: Decimal
) => Promise<void>;

export class LiveBarPoller {
  private lastSeen = new Map<string, number>();
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private onNewBar: NewBarHandler,
    private pollSeconds = 30,
    private instruments: InstrumentSpec[] = DEFAULT_INSTRUMENTS
  ) {}

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  async run(): Promise<void> {
    logger.info({ symbols: this.instruments.map((i) => i.symbol), pollSeconds: this.pollSeconds }, "start");
    while (!this.stopped) {
      for (const spec of this.instruments) {
        try {
          await this.pollOnce(spec);
        } catch (err) {
          logger.error({ symbol: spec.symbol, err: String(err) }, "poll_failed");
        }
      }
      await this.sleep(this.pollSeconds * 1000);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.timer = setTimeout(resolve, ms);
    });
  }

  private async pollOnce(spec: InstrumentSpec): Promise<void> {
    const bars = await fetchYahooChart(spec.dataSymbol, "1d", "1m");
    if (bars.length === 0) return;
    const last = bars[bars.length - 1]!;
    const lastTime = last.time.getTime();
    if (this.lastSeen.get(spec.symbol) === lastTime) return; // no new completed bar yet
    this.lastSeen.set(spec.symbol, lastTime);

    await prisma.bar.upsert({
      where: { time_symbol: { time: last.time, symbol: spec.symbol } },
      update: {
        open: last.open.toString(),
        high: last.high.toString(),
        low: last.low.toString(),
        close: last.close.toString(),
        volume: last.volume.toString(),
      },
      create: {
        time: last.time,
        symbol: spec.symbol,
        open: last.open.toString(),
        high: last.high.toString(),
        low: last.low.toString(),
        close: last.close.toString(),
        volume: last.volume.toString(),
      },
    });

    await this.onNewBar(spec.symbol, last.time, last.open, last.high, last.low, last.close, last.volume);
  }
}
