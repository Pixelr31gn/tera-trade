/**
 * The assistant's Gemini tool-use loop, and the shared sendChatMessage
 * entry point that routes to it or to ollamaLoop.ts's Ollama/Qwen
 * equivalent based on ASSISTANT_PROVIDER (core/config.ts) -- see that
 * file's comment for why this exists (removing Gemini free-tier caps).
 *
 * This half is deliberately NOT automatic function calling (see the
 * generateContent call's
 * automaticFunctionCalling: { disable: true }), because the assistant's own
 * actions-enabled gate and the trading kill switch both need to be
 * re-checked between every single tool call (see tools.ts's
 * withAssistantAudit), not just once per turn. A multi-tool-call turn
 * (several functionCall parts in one response) is executed sequentially so
 * an operator flipping a gate mid-turn takes effect on the very next call,
 * not just the next turn.
 *
 * Gemini's `finishReason` has no dedicated "made a tool call" value (unlike
 * Anthropic's stop_reason: "tool_use") -- a function-calling turn still
 * reports "STOP". Whether to keep looping is decided by checking
 * response.functionCalls directly, not finishReason.
 *
 * v1 is non-streaming: the full loop runs server-side and POST
 * /api/assistant/chat returns once, after every tool call has resolved.
 */
import { GoogleGenAI, type Content, type Part } from "@google/genai";
import type { Prisma } from "@prisma/client";
import { getSettings } from "../core/config.js";
import { getSystemState } from "../execution/mode.js";
import { prisma } from "../db/client.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";
import { executeTool, getAvailableTools } from "./tools.js";
import { sendOllamaChatMessageUnserialized } from "./ollamaLoop.js";
import { childLogger } from "../core/logger.js";

const logger = childLogger("assistantClient");

let cachedClient: GoogleGenAI | undefined;
function getClient(): GoogleGenAI {
  if (cachedClient) return cachedClient;
  const settings = getSettings();
  if (!settings.geminiApiKey) throw new Error("GEMINI_API_KEY is not configured");
  cachedClient = new GoogleGenAI({ apiKey: settings.geminiApiKey });
  return cachedClient;
}

// A single turn can legitimately involve several tool calls in sequence
// (e.g. look up positions, then close one) -- bounded so a model stuck in a
// call/no-progress loop can't run forever against a real-money account.
const MAX_TOOL_ITERATIONS = 10;
const MAX_OUTPUT_TOKENS = 4096;
// Per-call request timeout (2026-08-30, see the actual generateContent call
// site's own comment) -- generous enough for a legitimately slow multi-part
// response (confirmed live: a real multi-tool-call reply took ~90s), but
// bounded so a stuck request fails fast enough for generateContentWithRetry
// to actually retry instead of blocking for many minutes on one attempt.
const REQUEST_TIMEOUT_MS = 90_000;
// Recent AssistantMessage rows loaded as conversation context -- generous
// enough for a real back-and-forth without unboundedly growing every
// request's token cost as the table grows.
const HISTORY_MESSAGE_LIMIT = 40;

/** JSON round-trip so the persisted row and the Gemini content parts are both plain, storage-safe JSON. */
function toJsonSafe(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

/**
 * Normalizes a stored AssistantMessage row's `content` into Gemini's own
 * Part[] shape. This file's own writes below always persist a proper Part[]
 * array, but ollamaLoop.ts (ASSISTANT_PROVIDER="ollama") persists a totally
 * different envelope -- {"messages": [{role, content: <string>}],
 * "__provider": "ollama"} -- and real history can legitimately contain both
 * shapes mixed together once the operator has switched providers even once.
 * Casting an Ollama-shaped row straight to Part[] left `parts` as that whole
 * non-array envelope object, which crashed hasFunctionPart's `.some()` call
 * on the very next request regardless of which provider was asked for
 * (confirmed live 2026-09-03: "(content.parts ?? []).some is not a
 * function"). Falls back to an empty parts array for any other
 * unrecognized shape rather than throwing -- same "fail closed" posture as
 * every other extractor in this codebase.
 */
function normalizeStoredContent(content: unknown): Part[] {
  if (Array.isArray(content)) return content as Part[];
  if (content && typeof content === "object" && (content as { __provider?: unknown }).__provider === "ollama") {
    const messages = (content as { messages?: unknown }).messages;
    if (Array.isArray(messages)) {
      return messages
        .filter((m): m is { content: string } => typeof (m as { content?: unknown })?.content === "string")
        .map((m) => ({ text: m.content }));
    }
  }
  return [];
}

// AssistantMessage.role stays "user" | "assistant" (provider-agnostic, see
// the schema's own comment) -- only translated to Gemini's "user" | "model"
// vocabulary here, at the API boundary. A tool-result turn is persisted with
// role "user" too (matching how Gemini itself treats functionResponse parts
// -- there is no separate "tool" role in its Content type), so this mapping
// is a plain 1:1 rename, not a lossy collapse.
function toGeminiContent(row: { role: string; content: unknown }): Content {
  return { role: row.role === "assistant" ? "model" : "user", parts: normalizeStoredContent(row.content) };
}

function hasFunctionPart(content: Content): boolean {
  return (content.parts ?? []).some((p) => p.functionCall !== undefined || p.functionResponse !== undefined);
}

// Gemini strictly rejects two consecutive same-role turns (confirmed live,
// 2026-08-29: "Please ensure that function call turn comes immediately
// after a user turn or after a function response turn") -- unlike some
// other providers, it does NOT auto-merge them for you. This can happen
// even from otherwise-correct data: a prior turn errored out after its user
// message was persisted but before an assistant reply followed, leaving
// back-to-back "user" rows in real history -- confirmed live twice the same
// day, from two different causes (a Gemini outage leaving several duplicate
// user turns queued with no reply between them, and a client-side request
// timeout that retried while the first attempt was still being processed
// server-side).
//
// Only merges consecutive same-role turns when NEITHER has a
// functionCall/functionResponse part -- i.e. only genuine duplicate/queued
// human text gets concatenated. The first version of this fix merged
// unconditionally and broke a DIFFERENT way (confirmed live, same day):
// gluing a functionResponse turn together with an unrelated freeform-text
// turn that happened to queue up next produced one incoherent hybrid
// "user" turn, which Gemini also rejects ("function response turn comes
// immediately after a function call turn"). A function-call/response pair
// is a structurally distinct kind of turn from ordinary conversation, even
// though both are stored under the DB's generic role "user" -- merging
// across that boundary is never correct, only merging within it is.
function mergeConsecutiveSameRole(contents: Content[]): Content[] {
  const merged: Content[] = [];
  for (const content of contents) {
    const last = merged[merged.length - 1];
    if (last && last.role === content.role && !hasFunctionPart(last) && !hasFunctionPart(content)) {
      last.parts = [...(last.parts ?? []), ...(content.parts ?? [])];
    } else {
      merged.push({ role: content.role, parts: [...(content.parts ?? [])] });
    }
  }
  return merged;
}

export interface ChatResult {
  reply: string;
  messageId: number;
}

// Two overlapping sendChatMessage calls (confirmed live, 2026-08-29: a
// client-side request timeout retried while the first attempt was still
// running server-side) each read a slightly different snapshot of history
// and then interleave their writes -- the AssistantMessage table ends up
// with a genuinely corrupted sequence (e.g. a functionResponse row from one
// call's turn immediately followed by an unrelated fresh user row from the
// other call), which Gemini's strict turn-alternation validation then
// rejects on every future request until manually cleaned up. Serializing
// every call onto one shared promise chain -- so a second call only starts
// once the first has fully finished, success or failure -- makes this
// structurally impossible instead of trying to detect/repair it after the
// fact. The chat is not a high-throughput path (one operator, one
// assistant, occasional scheduler ticks), so strict serialization costs
// nothing real in practice.
let chatQueue: Promise<unknown> = Promise.resolve();

// Retries transient Gemini failures (confirmed live, 2026-08-29: repeated
// 503 "high demand" errors that cleared on the very next attempt, no code
// change needed -- just a retry) AT THE POINT they happen, mid-loop, rather
// than letting them bubble all the way up. This matters beyond user
// experience: once a turn has persisted a functionCall/functionResponse
// pair, the conversation is mid-turn -- if the call that was supposed to
// close it out (produce the final text, or the next tool call) fails and
// the whole function throws, that functionResponse row is left dangling
// with no reply, and the very next chat request's history load starts from
// a broken alternation state Gemini's strict validation then rejects
// (confirmed live -- this is exactly how the conversation history got
// corrupted earlier the same day, unrelated to the concurrency issue
// chatQueue above fixes). Retrying here keeps a single transient failure
// from ever reaching that state in the first place.
const GENERATE_CONTENT_MAX_ATTEMPTS = 3;
const GENERATE_CONTENT_RETRY_DELAY_MS = 4_000;

async function generateContentWithRetry(
  client: GoogleGenAI,
  params: Parameters<GoogleGenAI["models"]["generateContent"]>[0]
): ReturnType<GoogleGenAI["models"]["generateContent"]> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= GENERATE_CONTENT_MAX_ATTEMPTS; attempt++) {
    try {
      return await client.models.generateContent(params);
    } catch (err) {
      lastErr = err;
      if (attempt < GENERATE_CONTENT_MAX_ATTEMPTS) {
        logger.warn({ attempt, err: String(err) }, "assistant_generate_content_failed_retrying");
        await new Promise((resolve) => setTimeout(resolve, GENERATE_CONTENT_RETRY_DELAY_MS));
      }
    }
  }
  throw lastErr;
}

// Falls back to Gemini when the Ollama host itself is unreachable (2026-09-09
// operator request, after a real incident: the remote Ollama box
// (OLLAMA_BASE_URL) went dark for hours -- confirmed via repeated
// "TypeError: fetch failed" on every call -- and silently zeroed out the
// daily-plan scheduler with no visible fallback). Only triggers on the
// OUTER failure of sendOllamaChatMessageUnserialized, i.e. after its own
// internal callOllamaChatWithRetry has already exhausted GENERATE_MAX_ATTEMPTS
// -- this is the "the host is genuinely unreachable/down" signal, not a
// single transient blip that its own retry already absorbs. Requires
// GEMINI_API_KEY to be configured (getClient() throws its own clear error
// otherwise, same as the forced-Gemini path always has) -- if it's not set,
// the original Ollama error is what the caller sees, not a confusing
// "Gemini not configured" one.
async function sendChatMessageWithFallback(userText: string, provider: "gemini" | "ollama"): Promise<ChatResult> {
  if (provider !== "ollama") return sendGeminiChatMessageUnserialized(userText);
  try {
    return await sendOllamaChatMessageUnserialized(userText);
  } catch (err) {
    if (!getSettings().geminiApiKey) throw err;
    logger.warn({ err: String(err) }, "assistant_ollama_unreachable_falling_back_to_gemini");
    return await sendGeminiChatMessageUnserialized(userText);
  }
}

// Routes to whichever provider ASSISTANT_PROVIDER selects (core/config.ts)
// by default -- callers (the chat route) never need to know which one is
// active. `forceProvider` lets a specific caller override that (see
// sendGeminiChatMessage below) when the flow's own requirements (must
// reliably call a tool, not just chat) rule out whichever provider is
// currently configured -- ollamaLoop.ts's /api/chat has no tool_choice/
// forcing mechanism at all (confirmed against Ollama's own API docs,
// 2026-09-03), and reproducibly failed to call any tool for
// dailyPlanScheduler.ts's prompt three separate times (a plain retry, an
// explicit "do not reply with only text" instruction, and a real worked
// few-shot example all failed identically) even though the exact same
// prompt reliably worked via Gemini every time. Both providers share this
// one chatQueue regardless of which is selected: only one call is ever
// active at a time, and the queue's real job (preventing overlapping calls
// from corrupting interleaved history writes -- see the comment above
// chatQueue's declaration) applies identically to either provider's history
// table rows.
export function sendChatMessage(userText: string, forceProvider?: "gemini" | "ollama"): Promise<ChatResult> {
  const result = chatQueue.then(() => {
    const provider = forceProvider ?? getSettings().assistantProvider;
    return sendChatMessageWithFallback(userText, provider);
  });
  // Swallow the rejection on the QUEUE's own chain (not on `result`, which
  // still rejects normally for this call's own caller) so one failed call
  // doesn't permanently wedge every later call behind a rejected promise.
  chatQueue = result.catch(() => undefined);
  return result;
}

/**
 * Forces Gemini regardless of ASSISTANT_PROVIDER. dailyPlanScheduler.ts used
 * to need this specifically (see sendChatMessage's own comment on why it was
 * hardcoded there) but was switched back to the provider-routed default
 * 2026-09-04 (operator request, see that file's header comment for the full
 * history). Kept here, unused by anything in this repo right now, as the
 * one-line revert if Qwen 3.6 ever turns out not to reliably tool-call for
 * that specific prompt the way the original Ollama test found. Still
 * requires GEMINI_API_KEY/assistantEnabled the same as the default path
 * (sendGeminiChatMessageUnserialized throws the same way either way) -- this
 * only changes provider SELECTION, not any other gate.
 */
export function sendGeminiChatMessage(userText: string): Promise<ChatResult> {
  return sendChatMessage(userText, "gemini");
}

async function sendGeminiChatMessageUnserialized(userText: string): Promise<ChatResult> {
  const settings = getSettings();
  if (!settings.assistantEnabled) throw new Error("Assistant is disabled (ASSISTANT_ENABLED=false)");

  const client = getClient();

  const historyRows = await prisma.assistantMessage.findMany({ orderBy: { createdAt: "desc" }, take: HISTORY_MESSAGE_LIMIT });
  const contents: Content[] = mergeConsecutiveSameRole(historyRows.reverse().map(toGeminiContent));

  await prisma.assistantMessage.create({ data: { role: "user", content: toJsonSafe([{ text: userText }]) } });
  contents.push({ role: "user", parts: [{ text: userText }] });

  let finalText = "";
  let finalMessageId: number | null = null;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    // Re-resolved every iteration (not hoisted above the loop) so a gate
    // flip mid-conversation changes which tools are even offered on the
    // very next model call, not just the next chat request.
    const systemState = await getSystemState();
    const actionsEnabled = settings.assistantEnabled && systemState.assistantActionsEnabled;
    const functionDeclarations = getAvailableTools(actionsEnabled);

    const response = await generateContentWithRetry(client, {
      model: settings.assistantModel,
      contents,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        tools: [{ functionDeclarations }],
        // See this file's header comment -- the manual loop below is the
        // only thing allowed to execute a tool call.
        automaticFunctionCalling: { disable: true },
        // Confirmed live, 2026-08-30: a single call sat for ~14 minutes
        // before finally failing on its own -- no client-side timeout meant
        // generateContentWithRetry's own retry logic never even got a
        // chance to kick in until Google's own (apparently very long)
        // server-side limit gave up first. A bounded request timeout makes
        // a stuck call fail fast enough for the retry loop to actually do
        // its job.
        httpOptions: { timeout: REQUEST_TIMEOUT_MS },
      },
    });

    const parts = response.candidates?.[0]?.content?.parts ?? [];
    const assistantRow = await prisma.assistantMessage.create({ data: { role: "assistant", content: toJsonSafe(parts) } });
    finalMessageId = assistantRow.id;
    contents.push({ role: "model", parts });

    finalText = response.text ?? "";

    const functionCalls = response.functionCalls ?? [];
    if (functionCalls.length === 0) break;

    const responseParts: Part[] = [];
    for (const call of functionCalls) {
      logger.info({ tool: call.name }, "assistant_tool_call");
      const result = await executeTool(call.name ?? "", call.args ?? {}, assistantRow.id);
      responseParts.push({
        functionResponse: {
          id: call.id,
          name: call.name,
          response: result.isError ? { error: result.content } : { output: result.content },
        },
      });
    }

    await prisma.assistantMessage.create({ data: { role: "user", content: toJsonSafe(responseParts) } });
    contents.push({ role: "user", parts: responseParts });
  }

  if (finalMessageId === null) throw new Error("assistant produced no response");
  return { reply: finalText, messageId: finalMessageId };
}
