// Throwaway diagnostic (2026-08-03) -- checking whether scoring/signal
// generation has actually continued since the app was relaunched at 4:13pm
// local, or whether the dashboard is just showing a stale view.
import { prisma } from "../src/db/client.js";

async function main() {
  const scores = await prisma.score.findMany({ orderBy: { time: "desc" }, take: 10 });
  console.log("Most recent scores:");
  for (const s of scores) {
    console.log(`  ${s.time.toISOString()} ${s.symbol} ${s.strategyId} ${s.strategyVersion} ${s.side} ${s.probability.toString()} ${s.decision}`);
  }

  const bars = await prisma.bar.findFirst({ where: { symbol: "NQ" }, orderBy: { time: "desc" } });
  console.log(`\nMost recent NQ bar: ${bars?.time.toISOString()}`);

  const trades = await prisma.trade.findMany({ orderBy: { openedAt: "desc" }, take: 5 });
  console.log(`\nMost recent trades:`);
  for (const t of trades) {
    console.log(`  ${t.openedAt.toISOString()} ${t.symbol} ${t.side} status=${t.status} broker=${t.brokerKind}`);
  }

  console.log(`\nCurrent time: ${new Date().toISOString()}`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
