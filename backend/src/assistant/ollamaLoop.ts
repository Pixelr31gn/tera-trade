/**
 * The assistant's tool-use loop against a self-hosted Ollama server
 * (ASSISTANT_PROVIDER="ollama", see core/config.ts) -- same safety
 * properties as client.ts's Gemini loop (per-tool-call re-check of the
 * assistantActionsEnabled gate and kill switch via tools.ts's
 * withAssistantAudit, a bounded MAX_TOOL_ITERATIONS, retry on transient
 * failure, a request timeout), reused via the one shared sendChatMessage
 * export in client.ts so nothing calling it (the chat route,
 * dailyPlanScheduler.ts) needs to know which provider is active.
 *
 * Ollama's /api/chat is a plain OpenAI-style messages array (system/user/
 * assistant/tool roles) with no strict turn-alternation rule the way
 * Gemini has (see client.ts's mergeConsecutiveSameRole/hasFunctionPart --
 * that machinery exists solely to work around Gemini's own rejection of
 * back-to-back same-role turns, and has no equivalent need here).
 *
 * History is persisted to the same AssistantMessage table client.ts uses,
 * but under a distinct envelope shape ({ __provider: "ollama", messages }
 * -- see toEnvelope/isOllamaEnvelope below) so a provider switch can never
 * misinterpret the other provider's rows: Gemini rows are a bare Part[]
 * array; Ollama rows are an object. Rows from before a cutover (or from
 * the other provider) are simply skipped when loading history rather than
 * translated -- chat history isn't precious enough to warrant a cross-
 * format migration, and this repo has no requirement to preserve it across
 * a provider switch.
 */
import type { FunctionDeclaration } from "@google/genai";
import type { Prisma } from "@prisma/client";
import { getSettings } from "../core/config.js";
import { getSystemState } from "../execution/mode.js";
import { prisma } from "../db/client.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";
import { executeTool, getAvailableTools } from "./tools.js";
import { childLogger } from "../core/logger.js";
import type { ChatResult } from "./client.js";

const logger = childLogger("ollamaLoop");

// Mirrors client.ts's own bounds exactly -- see that file's comments for
// why these specific values (a real multi-tool-call Gemini reply took
// ~90s; local inference on a modest host can be slower still, hence the
// longer per-request timeout below).
const MAX_TOOL_ITERATIONS = 10;
const MAX_OUTPUT_TOKENS = 4096;
// Explicit num_ctx -- REQUIRED, not optional. Confirmed live 2026-09-04 (real incident: the
// assistant chat started returning empty content on every turn, "hello" included): with num_ctx
// left unset, Ollama silently used an effective context window of only 16384 tokens regardless of
// this model's real 262144-token max (confirmed via /api/show's qwen35moe.context_length) -- once
// the 38-tool schema + accumulated history filled nearly all of it (prompt_eval_count=16192),
// there were only ~192 tokens left for think:true's own reasoning AND the actual answer combined.
// The model correctly used what little budget remained, ran out mid-thought, and Ollama returned
// a normal done:true/done_reason:"length" response with message.content="" -- NOT an error, so
// nothing here ever retried or surfaced it; it just silently persisted an empty reply every turn
// forever after, since retrying resends the same oversized prompt into the same wall. 65536 gives
// real headroom (was ~2.4x too small at the old effective 16384) without assuming the full 262144,
// which needs far more server VRAM than a 16384 default implies is available on this host -- lower
// this if the host can't hold 65536 tokens of KV cache; the failure mode is the same either way, so
// watch for message.content coming back empty with done_reason:"length" as the signal to lower it.
const CONTEXT_WINDOW_TOKENS = 65536;
// Confirmed live 2026-09-03 against the actual remote Ollama host: loading a
// 22GB model from cold took 171s before the first response of a session --
// well past a 120s timeout, which would make every post-restart first call
// fail even though the server is healthy and just busy loading. 300s covers
// that with headroom; a genuinely stuck request still fails well inside
// GENERATE_MAX_ATTEMPTS' overall budget rather than hanging indefinitely.
const REQUEST_TIMEOUT_MS = 300_000;
const HISTORY_MESSAGE_LIMIT = 40;
const GENERATE_MAX_ATTEMPTS = 3;
const GENERATE_RETRY_DELAY_MS = 4_000;

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  tool_name?: string;
}

interface OllamaEnvelope {
  __provider: "ollama";
  messages: OllamaMessage[];
}

function toEnvelope(messages: OllamaMessage[]): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify({ __provider: "ollama", messages })) as Prisma.InputJsonValue;
}

function isOllamaEnvelope(value: unknown): value is OllamaEnvelope {
  return typeof value === "object" && value !== null && (value as { __provider?: unknown }).__provider === "ollama" && Array.isArray((value as { messages?: unknown }).messages);
}

/** Ollama's native tool schema is plain JSON Schema, same shape as tools.ts's own parametersJsonSchema -- no translation needed beyond wrapping. */
function toOllamaTool(decl: FunctionDeclaration): { type: "function"; function: { name: string; description: string; parameters: unknown } } {
  return {
    type: "function",
    function: {
      name: decl.name ?? "",
      description: decl.description ?? "",
      parameters: decl.parametersJsonSchema ?? { type: "object", properties: {} },
    },
  };
}

interface OllamaApiToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

interface OllamaApiResponse {
  message?: { role: string; content: string; tool_calls?: OllamaApiToolCall[] };
  error?: string;
}

async function callOllamaChatOnce(params: { messages: OllamaMessage[]; tools: FunctionDeclaration[] }): Promise<OllamaApiResponse> {
  const settings = getSettings();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${settings.ollamaBaseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: settings.ollamaModel,
        messages: params.messages,
        tools: params.tools.map(toOllamaTool),
        stream: false,
        // MUST be true -- confirmed live 2026-09-03 via a real smoke test
        // that this actually broke tool-calling: with think:false, once a
        // conversation contains even one turn the model answered in plain
        // text, every later turn -- even one that explicitly says "use your
        // tool" -- stayed in plain-text mode and fabricated a confident,
        // wrong answer (asked for the exact current ES price; got 4125.00
        // against a real 7748.25) instead of calling the tool. Reproduced
        // outside the app with a raw request replaying the exact same
        // history, so it's a genuine model/serving behavior, not an app
        // bug. With think:true the identical request correctly calls the
        // tool. The original reasoning for false (avoiding a ~47s
        // reasoning pass per call) doesn't hold up either -- Ollama's
        // context caching (prompt_eval_cached_count) makes repeat calls in
        // the same conversation fast (~1-2s) regardless of this setting.
        think: true,
        options: { num_predict: MAX_OUTPUT_TOKENS, num_ctx: CONTEXT_WINDOW_TOKENS },
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Ollama chat request failed: HTTP ${res.status} ${await res.text()}`);
    const json = (await res.json()) as OllamaApiResponse;
    if (json.error) throw new Error(`Ollama chat error: ${json.error}`);
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

async function callOllamaChatWithRetry(params: { messages: OllamaMessage[]; tools: FunctionDeclaration[] }): Promise<OllamaApiResponse> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= GENERATE_MAX_ATTEMPTS; attempt++) {
    try {
      return await callOllamaChatOnce(params);
    } catch (err) {
      lastErr = err;
      if (attempt < GENERATE_MAX_ATTEMPTS) {
        logger.warn({ attempt, err: String(err) }, "ollama_chat_failed_retrying");
        await new Promise((resolve) => setTimeout(resolve, GENERATE_RETRY_DELAY_MS));
      }
    }
  }
  throw lastErr;
}

export async function sendOllamaChatMessageUnserialized(userText: string): Promise<ChatResult> {
  const settings = getSettings();
  if (!settings.assistantEnabled) throw new Error("Assistant is disabled (ASSISTANT_ENABLED=false)");

  const historyRows = await prisma.assistantMessage.findMany({ orderBy: { createdAt: "desc" }, take: HISTORY_MESSAGE_LIMIT });
  const priorMessages: OllamaMessage[] = historyRows
    .reverse()
    .map((r) => r.content as unknown)
    .filter(isOllamaEnvelope)
    .flatMap((env) => env.messages);

  await prisma.assistantMessage.create({ data: { role: "user", content: toEnvelope([{ role: "user", content: userText }]) } });

  const messages: OllamaMessage[] = [{ role: "system", content: SYSTEM_PROMPT }, ...priorMessages, { role: "user", content: userText }];

  let finalText = "";
  let finalMessageId: number | null = null;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    // Re-resolved every iteration, matching client.ts's Gemini loop -- a
    // gate flip mid-conversation changes which tools are offered on the
    // very next call, not just the next chat request.
    const systemState = await getSystemState();
    const actionsEnabled = settings.assistantEnabled && systemState.assistantActionsEnabled;
    const tools = getAvailableTools(actionsEnabled);

    const response = await callOllamaChatWithRetry({ messages, tools });
    const toolCalls = response.message?.tool_calls ?? [];
    const content = response.message?.content ?? "";

    const assistantMessage: OllamaMessage = { role: "assistant", content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
    const assistantRow = await prisma.assistantMessage.create({ data: { role: "assistant", content: toEnvelope([assistantMessage]) } });
    finalMessageId = assistantRow.id;
    messages.push(assistantMessage);
    finalText = content;

    if (toolCalls.length === 0) break;

    const toolResultMessages: OllamaMessage[] = [];
    for (const call of toolCalls) {
      logger.info({ tool: call.function.name }, "assistant_tool_call");
      const result = await executeTool(call.function.name, call.function.arguments ?? {}, assistantRow.id);
      toolResultMessages.push({ role: "tool", tool_name: call.function.name, content: result.content });
    }

    // Persisted under DB role "user", matching client.ts's own convention
    // for tool-result turns (see that file's toGeminiContent comment) --
    // AssistantMessage.role is deliberately just "user" | "assistant" at
    // the schema level, provider details live entirely inside content.
    await prisma.assistantMessage.create({ data: { role: "user", content: toEnvelope(toolResultMessages) } });
    messages.push(...toolResultMessages);
  }

  if (finalMessageId === null) throw new Error("assistant produced no response");
  return { reply: finalText, messageId: finalMessageId };
}
