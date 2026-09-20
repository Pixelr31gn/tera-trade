import type { FastifyInstance } from "fastify";
import { prisma } from "../../db/client.js";
import { requireApiKey } from "../../core/security.js";
import { getSettings } from "../../core/config.js";
import { sendChatMessage } from "../../assistant/client.js";

export async function assistantRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireApiKey);

  app.post<{ Body: { message: string } }>("/api/assistant/chat", async (request, reply) => {
    const settings = getSettings();
    if (!settings.assistantEnabled) return reply.code(400).send({ error: "Assistant is disabled (ASSISTANT_ENABLED=false)" });

    const message = request.body?.message;
    if (typeof message !== "string" || message.trim().length === 0) {
      return reply.code(400).send({ error: "message is required" });
    }

    try {
      const result = await sendChatMessage(message);
      return result;
    } catch (err) {
      request.log.error({ err: String(err) }, "assistant_chat_failed");
      return reply.code(500).send({ error: err instanceof Error ? err.message : "assistant chat failed" });
    }
  });

  app.get<{ Querystring: { limit?: string } }>("/api/assistant/messages", async (request) => {
    const limit = Math.min(Number(request.query.limit ?? 50), 200);
    const rows = await prisma.assistantMessage.findMany({ orderBy: { createdAt: "desc" }, take: limit });
    return rows.reverse().map((r) => ({ id: r.id, role: r.role, content: r.content, createdAt: r.createdAt }));
  });

  app.get<{ Querystring: { limit?: string } }>("/api/assistant/actions", async (request) => {
    const limit = Math.min(Number(request.query.limit ?? 50), 200);
    const rows = await prisma.assistantAction.findMany({ orderBy: { createdAt: "desc" }, take: limit });
    return rows.map((r) => ({
      id: r.id,
      toolName: r.toolName,
      input: r.input,
      status: r.status,
      resultSummary: r.resultSummary,
      rawResult: r.rawResult,
      errorMessage: r.errorMessage,
      tradeId: r.tradeId,
      messageId: r.messageId,
      createdAt: r.createdAt,
    }));
  });
}
