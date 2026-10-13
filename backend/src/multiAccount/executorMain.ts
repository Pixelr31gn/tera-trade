/**
 * Standalone executor entrypoint -- run this on each remote PC:
 *
 *   EXECUTOR_SECRET=... npm run executor
 *
 * It connects a local BrowserControlBroker to THIS PC's own Chrome (the usual
 * localhost:9222 debug profile, logged into this PC's Topstep account) and
 * starts the command service. No engine, no strategy -- it only executes the
 * commands the master sends.
 *
 * Whether a command actually places a real order is still governed entirely by
 * this PC's own broker settings (DRY_RUN_ORDERS and the live-trading gates in
 * core/config.ts) -- this entrypoint does not touch them.
 */
import { getBroker } from "../brokers/index.js";
import { BrokerKind } from "../core/config.js";
import { childLogger } from "../core/logger.js";
import { ACTIVE_INSTRUMENTS, getInstrument } from "../marketData/instruments.js";
import { DeadManSwitch, flattenAllPositions } from "./deadMan.js";
import { loadExecutorServerConfig } from "./executorConfig.js";
import { buildExecutorServer } from "./executorServer.js";
import { prepareTicket } from "./ticketPrep.js";

const logger = childLogger("executorMain");

async function main(): Promise<void> {
  const cfg = loadExecutorServerConfig();

  logger.info("connecting local browser-control broker to this PC's Chrome...");
  // mirror:false -- an executor runs commands, it must never fan them out again.
  const broker = await getBroker(BrokerKind.BROWSER_CONTROL, { mirror: false });
  await broker.connect();

  const deadMan =
    cfg.deadManSeconds > 0
      ? new DeadManSwitch({
          timeoutMs: cfg.deadManSeconds * 1000,
          onTrip: async () => {
            const report = await flattenAllPositions(broker, ACTIVE_INSTRUMENTS.map((i) => i.symbol));
            logger.warn(report, "dead_man_flatten_finished");
          },
        })
      : undefined;
  deadMan?.start();
  logger.info({ deadManSeconds: cfg.deadManSeconds }, deadMan ? "dead_man_switch_enabled" : "dead_man_switch_DISABLED");

  const app = buildExecutorServer({
    broker,
    secret: cfg.secret,
    deadMan,
    // engine symbol ("ES") -> this PC's contract prefix ("MES"), same table the broker uses
    prepare: (symbol) => prepareTicket(getInstrument(symbol).brokerContractPrefix),
  });
  await app.listen({ host: cfg.host, port: cfg.port });
  logger.info({ host: cfg.host, port: cfg.port }, "executor_service_listening");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "executor_shutting_down");
    deadMan?.stop();
    await app.close().catch(() => {});
    await broker.disconnect().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  // Never print the secret; this only ever carries the failure reason.
  console.error("executor failed to start:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
