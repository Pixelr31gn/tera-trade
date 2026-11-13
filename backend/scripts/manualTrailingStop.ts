/**
 * Operator-requested trailing stop on an already-open live trade, recorded the
 * same way engine/loop.ts's activateTrailingStop records its own: place the
 * broker-side order, then set trade.trailingStopPlaced and write the order row.
 * Marking the trade is what stops the engine arming a SECOND trailing stop at
 * 1.5R -- two resting stops on one position can close it and then open the
 * opposite side.
 *
 *   npx tsx --env-file=.env scripts/manualTrailingStop.ts <tradeId> [trailTicks]
 *
 * Goes through getBroker, so with MIRROR_EXECUTORS set the same stop is also
 * placed on every mirrored account. trailTicks defaults to the instrument's
 * band minimum (risk/stops.ts resolveTrailingStopDistanceTicks with no ATR).
 * The broker itself refuses if the position is already flat or on the other
 * side (browserControlBroker.protectiveOrderRefusal).
 */
import { getBroker } from "../src/brokers/index.js";
import { BrokerKind } from "../src/core/config.js";
import { prisma } from "../src/db/client.js";
import { getInstrument } from "../src/marketData/instruments.js";
import { resolveTrailingStopDistanceTicks } from "../src/risk/stops.js";

async function main(): Promise<void> {
  const tradeId = Number(process.argv[2]);
  if (!Number.isInteger(tradeId)) {
    console.error("usage: manualTrailingStop.ts <tradeId> [trailTicks]");
    process.exit(2);
  }
  const trade = await prisma.trade.findUnique({ where: { id: tradeId } });
  if (!trade) throw new Error(`trade #${tradeId} not found`);
  if (trade.status !== "open") throw new Error(`trade #${tradeId} is ${trade.status}, not open`);
  if (trade.trailingStopPlaced) throw new Error(`trade #${tradeId} already has a trailing stop recorded -- refusing to place a second`);
  if (trade.side !== "long" && trade.side !== "short") throw new Error(`unexpected side "${trade.side}"`);

  const instrument = getInstrument(trade.symbol);
  const ticksArg = process.argv[3] === undefined ? null : Number(process.argv[3]);
  if (ticksArg !== null && (!Number.isInteger(ticksArg) || ticksArg <= 0)) throw new Error("trailTicks must be a positive integer");
  const trailTicks = ticksArg ?? resolveTrailingStopDistanceTicks(instrument, null);

  const broker = await getBroker(trade.brokerKind as BrokerKind);
  if (!broker.placeTrailingStop) throw new Error(`${trade.brokerKind} broker does not support trailing stops`);
  await broker.connect();

  console.log(`placing ${trailTicks}-tick trailing stop on trade #${tradeId} (${trade.symbol} ${trade.side} x${trade.quantity})...`);
  const result = await broker.placeTrailingStop(trade.symbol, trade.side, trade.quantity, trailTicks);
  // FanOutBroker queues remote work behind the master; let it finish and log.
  await (broker as { settle?: () => Promise<void> }).settle?.();
  await broker.disconnect();

  if (result.status === "rejected") {
    console.error(`REJECTED on the controller: ${result.error}`);
    process.exit(1);
  }

  await prisma.trade.update({ where: { id: tradeId }, data: { trailingStopPlaced: true } });
  await prisma.orderRecord.create({
    data: {
      tradeId,
      brokerOrderId: result.brokerOrderId,
      accountId: trade.accountId,
      symbol: trade.symbol,
      orderType: "trailing_stop",
      side: trade.side === "long" ? "sell" : "buy",
      quantity: trade.quantity,
      status: "pending",
    },
  });
  console.log(`OK: trailing stop placed (${result.status}), trade #${tradeId} marked trailingStopPlaced. Mirrored accounts: see the backend log for mirror_executor_* lines.`);
  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("FAIL:", err instanceof Error ? err.message : String(err));
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
