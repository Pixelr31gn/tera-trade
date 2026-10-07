import type { FastifyInstance } from "fastify";
import { prisma } from "../../db/client.js";
import { requireApiKey } from "../../core/security.js";
import { getSettings } from "../../core/config.js";
import { sendChatMessage } from "../../assistant/client.js";
import { buildDailyPlanNow } from "../../assistant/dailyPlanScheduler.js";
import { getSystemState } from "../../execution/mode.js";
import { isDailyPlanRequest } from "../../assistant/planIntent.js";

/**
 * Saves a plan-request exchange (the operator's short request and the
 * assistant's short summary -- never the digest itself) into chat history,
 * in the active provider's own row format, so later chat turns know a plan
 * was just built. The first version (2026-10-05) always wrote Gemini's [{text}]
 * shape, which ollamaLoop's history loader skips: the Ollama chat model never
 * saw the plan being built, still saw its own earlier "please provide the
 * levels" replies, and told the operator the plan "was not updated yet"
 * minutes after it had been. The dashboard renders both shapes.
 */
async function recordChatExchange(userText: string, replyText: string): Promise<number> {
  const ollama = getSettings().assistantProvider === "ollama";
  const row = (role: "user" | "assistant", text: string) =>
    ollama ? { __provider: "ollama", messages: [{ role, content: text }] } : [{ text }];
  await prisma.assistantMessage.create({ data: { role: "user", content: row("user", userText) } });
  const saved = await prisma.assistantMessage.create({ data: { role: "assistant", content: row("assistant", replyText) } });
  return saved.id;
}

export async function assistantRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireApiKey);

  app.post<{ Body: { message: string } }>("/api/assistant/chat", async (request, reply) => {
    const settings = getSettings();
    if (!settings.assistantEnabled) return reply.code(400).send({ error: "Assistant is disabled (ASSISTANT_ENABLED=false)" });

    const message = request.body?.message;
    if (typeof message !== "string" || message.trim().length === 0) {
      return reply.code(400).send({ error: "message is required" });
    }

    // 2026-10-05, operator: "any time I prompt the assistant to do this it
    // should be provided with all that information." A plan request goes
    // through the scheduler's own path -- full market/S-R/dealer/regime/news
    // digest plus the structured prompt and tools -- instead of plain chat,
    // where the model had none of that data and asked the operator for it.
    if (isDailyPlanRequest(message)) {
      try {
        let text: string;
        if (!(await getSystemState()).assistantActionsEnabled) {
          text = "I can't set a daily plan while assistant actions are turned off -- enable them on the dashboard and ask again.";
        } else {
          const outcome = await buildDailyPlanNow();
          text = outcome.skippedInFlight
            ? "A daily-plan build is already running (the hourly refresh or another request). It'll be in place shortly -- check the daily plan again in a minute."
            : outcome.plannedSymbols.length > 0
              ? `Daily plan updated from live data for ${outcome.plannedSymbols.join(", ")}.${outcome.reply ? `\n\n${outcome.reply}` : ""}`
              : `I couldn't set the plan this time -- no zones were written.${outcome.reply ? `\n\n${outcome.reply}` : ""} The scheduler will retry automatically.`;
        }
        return { reply: text, messageId: await recordChatExchange(message, text) };
      } catch (err) {
        request.log.error({ err: String(err) }, "assistant_daily_plan_request_failed");
        return reply.code(500).send({ error: err instanceof Error ? err.message : "daily plan build failed" });
      }
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
