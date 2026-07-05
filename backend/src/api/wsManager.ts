/**
 * Broadcasts engine events (scores, executions, equity updates, kill-switch
 * trips) to every connected dashboard websocket client.
 */
import type { WebSocket } from "ws";
import { childLogger } from "../core/logger.js";

const logger = childLogger("wsManager");

class ConnectionManager {
  private connections = new Set<WebSocket>();

  add(ws: WebSocket): void {
    this.connections.add(ws);
  }

  remove(ws: WebSocket): void {
    this.connections.delete(ws);
  }

  async broadcast(event: Record<string, unknown>): Promise<void> {
    const message = JSON.stringify(event);
    for (const ws of this.connections) {
      try {
        ws.send(message);
      } catch (err) {
        logger.warn({ err: String(err) }, "send_failed");
        this.connections.delete(ws);
      }
    }
  }
}

export const manager = new ConnectionManager();
