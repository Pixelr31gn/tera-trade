import cors from "@fastify/cors";
import websocketPlugin from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { getSettings } from "../core/config.js";
import { accountsRoutes } from "./routes/accounts.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { backfillRoutes } from "./routes/backfill.js";
import { executionRoutes } from "./routes/execution.js";
import { marketRoutes } from "./routes/market.js";
import { newsRoutes } from "./routes/news.js";
import { performanceRoutes } from "./routes/performance.js";
import { positionsRoutes } from "./routes/positions.js";
import { regimeRoutes } from "./routes/regime.js";
import { scoresRoutes } from "./routes/scores.js";
import { systemRoutes } from "./routes/system.js";
import { tradesRoutes } from "./routes/trades.js";
import { wsRoutes } from "./routes/ws.js";

export async function buildServer(): Promise<FastifyInstance> {
  const settings = getSettings();
  const app = Fastify({ logger: { level: settings.logLevel } });

  await app.register(cors, { origin: ["http://localhost:3000", "http://localhost:3001", "http://localhost:3002"] });
  await app.register(websocketPlugin);

  await app.register(systemRoutes);
  await app.register(accountsRoutes);
  await app.register(positionsRoutes);
  await app.register(scoresRoutes);
  await app.register(tradesRoutes);
  await app.register(performanceRoutes);
  await app.register(regimeRoutes);
  await app.register(newsRoutes);
  await app.register(analyticsRoutes);
  await app.register(backfillRoutes);
  await app.register(marketRoutes);
  await app.register(executionRoutes);
  await app.register(wsRoutes);

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}
