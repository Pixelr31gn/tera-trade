/**
 * Points the order ticket at a contract on THIS PC and on every remote PC in
 * MIRROR_EXECUTORS, then stops. Places nothing -- never touches Buy/Sell/Close.
 *
 *   npx tsx --env-file=.env scripts/mirrorPrepare.ts ES     (-> MES on every account)
 *   npx tsx --env-file=.env scripts/mirrorPrepare.ts NQ     (-> MNQ on every account)
 *
 * Takes the ENGINE symbol (ES/NQ); each PC maps it to its own contract prefix
 * with the same instruments table the broker uses. Operator-initiated: don't
 * run it while an order is in flight (the ticket is shared across symbols).
 */
import { getInstrument } from "../src/marketData/instruments.js";
import { loadMirrorClientConfig } from "../src/multiAccount/executorConfig.js";
import { RemoteExecutorClient } from "../src/multiAccount/remoteExecutorClient.js";
import { prepareTicket, type PrepareResult } from "../src/multiAccount/ticketPrep.js";

function show(name: string, r: PrepareResult): boolean {
  if (r.ok) console.log(`  OK    ${name.padEnd(10)} ticket on ${r.contract}  (qty box ${r.quantity})  -- nothing clicked`);
  else console.log(`  FAIL  ${name.padEnd(10)} ${r.error}`);
  return r.ok;
}

async function main(): Promise<void> {
  const symbol = (process.argv[2] ?? "").toUpperCase();
  if (!symbol) {
    console.error("usage: mirrorPrepare.ts <ES|NQ>");
    process.exit(2);
  }
  const prefix = getInstrument(symbol).brokerContractPrefix;
  const cfg = loadMirrorClientConfig();

  console.log(`Switching to ${symbol} (${prefix}) on ${1 + cfg.targets.length} account(s)...`);
  const results = await Promise.all([
    prepareTicket(prefix).then((r) => show("controller", r)),
    ...cfg.targets.map((t) =>
      new RemoteExecutorClient({ name: t.name, baseUrl: t.url, secret: cfg.secret, timeoutMs: 20000 })
        .prepare(symbol)
        .then((r) => show(t.name, r))
        .catch((err) => {
          console.log(`  FAIL  ${t.name.padEnd(10)} ${err instanceof Error ? err.message : String(err)}`);
          return false;
        }),
    ),
  ]);
  process.exit(results.every(Boolean) ? 0 : 1);
}

main().catch((err) => {
  console.error("FAIL:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
