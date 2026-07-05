import type { FastifyInstance } from "fastify";
import { isValidWsApiKey } from "../../core/security.js";
import { manager } from "../wsManager.js";

export async function wsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/ws/live", { websocket: true }, (socket, request) => {
    const apiKey = (request.query as Record<string, string>).api_key ?? null;
    if (!isValidWsApiKey(apiKey)) {
      socket.close(1008, "invalid api key");
      return;
    }
    manager.add(socket);
    socket.on("close", () => manager.remove(socket));
  });
}
