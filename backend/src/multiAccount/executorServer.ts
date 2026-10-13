/**
 * The executor HTTP service that runs on each remote PC. It receives mirrored
 * commands from the master and runs them against THIS PC's local broker (its
 * own Chrome / Topstep account). It has no engine and makes no decisions -- it
 * is the "hands," not the "brain."
 *
 * Security: every request must carry the shared secret in `x-mirror-secret`.
 * The service should only be reachable over the private Tailscale network and
 * behind the OS firewall; the secret is defence in depth, not the only wall.
 *
 * It deliberately does NOT weaken any of the broker's own live-trading gates
 * (DRY_RUN_ORDERS etc.) -- whether a command actually clicks a button is still
 * entirely the local broker's call, configured per-PC. (CLAUDE.md invariant 3.)
 */
import { timingSafeEqual } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";

import type { BrokerClient } from "../brokers/types.js";
import { childLogger } from "../core/logger.js";
import { applyMirrorCommand } from "./fanOutBroker.js";
import type { PrepareResult } from "./ticketPrep.js";
import { decodeCommand, encodeResult } from "./wireCodec.js";

const logger = childLogger("executorServer");

export interface ExecutorServerOptions {
  broker: BrokerClient;
  secret: string;
  /**
   * Points this PC's order ticket at the contract for an engine symbol ("ES",
   * "NQ") without placing anything. Optional: absent => /prepare answers 501.
   */
  prepare?: (symbol: string) => Promise<PrepareResult>;
  /** Dead-man switch refreshed by POST /heartbeat. Absent => /heartbeat answers 501. */
  deadMan?: { beat(): void; isArmed(): boolean };
}

export function buildExecutorServer(opts: ExecutorServerOptions): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });

  app.get("/health", async () => ({ ok: true }));

  app.post("/mirror", async (req, reply) => {
    if (!secretValid(req.headers["x-mirror-secret"], opts.secret)) {
      reply.code(401);
      return { error: "unauthorized" };
    }

    let command;
    try {
      command = decodeCommand(req.body);
    } catch (err) {
      reply.code(400);
      return { error: `bad command: ${String(err)}` };
    }

    try {
      const result = await applyMirrorCommand(opts.broker, command);
      logger.info({ action: command.kind, status: result.status }, "executor_applied_command");
      return encodeResult(result);
    } catch (err) {
      // A thrown broker error is reported as a 500 so the master's client
      // records it as a dispatch failure (never silently as a success).
      logger.error({ action: command.kind, err: String(err) }, "executor_command_threw");
      reply.code(500);
      return { error: String(err) };
    }
  });

  // The master's "I'm alive" ping -- arms/refreshes the dead-man switch.
  app.post("/heartbeat", async (req, reply) => {
    if (!secretValid(req.headers["x-mirror-secret"], opts.secret)) {
      reply.code(401);
      return { error: "unauthorized" };
    }
    if (!opts.deadMan) {
      reply.code(501);
      return { error: "dead-man switch is disabled on this executor" };
    }
    opts.deadMan.beat();
    return { ok: true, armed: opts.deadMan.isArmed() };
  });

  // Puts the ticket on a contract and clicks nothing -- see ticketPrep.ts.
  app.post("/prepare", async (req, reply) => {
    if (!secretValid(req.headers["x-mirror-secret"], opts.secret)) {
      reply.code(401);
      return { error: "unauthorized" };
    }
    if (!opts.prepare) {
      reply.code(501);
      return { error: "this executor does not support /prepare" };
    }
    const symbol = (req.body as { symbol?: unknown } | null)?.symbol;
    if (typeof symbol !== "string" || symbol.length === 0) {
      reply.code(400);
      return { error: "body must be {\"symbol\": \"ES\"}" };
    }
    try {
      const result = await opts.prepare(symbol);
      logger.info({ symbol, ok: result.ok, contract: result.contract }, "executor_prepared_ticket");
      return result;
    } catch (err) {
      logger.error({ symbol, err: String(err) }, "executor_prepare_threw");
      reply.code(500);
      return { error: String(err) };
    }
  });

  return app;
}

function secretValid(provided: unknown, expected: string): boolean {
  if (typeof provided !== "string" || provided.length === 0 || expected.length === 0) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
