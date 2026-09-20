/**
 * Shared bounded, stateless tool-calling loop against Ollama's native /api/chat tool-calling --
 * used by Scout and Taylor (backend/src/scout/agentLoop.ts, backend/src/taylor/agentLoop.ts).
 * Both have identical requirements: no per-call gate to re-check, no persisted chat history (each
 * run is one fresh turn), same think:true requirement. Deliberately NOT shared with the trading
 * assistant's own assistant/ollamaLoop.ts, which has neither of those properties (it persists
 * multi-turn history and re-checks the assistantActionsEnabled gate before every tool call) --
 * unifying with a fundamentally different consumer would just make both harder to reason about.
 *
 * think:true is REQUIRED, not optional -- assistant/ollamaLoop.ts's own comment documents a real,
 * reproduced failure mode where think:false causes a model to silently stop calling tools at all
 * once a conversation contains any plain-text turn. Same model family, so the same fix applies
 * here.
 */
import { childLogger } from "../core/logger.js";

const logger = childLogger("ollamaToolLoop");

const MAX_TOOL_ITERATIONS = 10;
const MAX_OUTPUT_TOKENS = 4096;
// Explicit num_ctx -- REQUIRED, not optional. See assistant/ollamaLoop.ts's own comment on this
// exact constant for the full incident writeup: left unset, this same Ollama host silently used
// an effective 16384-token context regardless of the model's real 262144-token max, and once a
// large tool list + history nearly filled it, think:true's own reasoning consumed what little
// budget remained and every response came back with content="" -- a normal done:true response,
// not an error, so nothing ever surfaced it. Scout/Taylor's own prompts are small enough that
// this hasn't bitten them yet, but the risk is the same shared host/model -- fixed here
// preemptively rather than waiting for it to happen here too.
const CONTEXT_WINDOW_TOKENS = 65536;
const REQUEST_TIMEOUT_MS = 300_000; // a cold-loaded local model can take minutes on its first call of a session
const GENERATE_MAX_ATTEMPTS = 3;
const GENERATE_RETRY_DELAY_MS = 4_000;

export interface OllamaToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface OllamaToolResult {
  content: string;
  isError: boolean;
}

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  tool_name?: string;
}

interface OllamaApiToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}
interface OllamaApiResponse {
  message?: { role: string; content: string; tool_calls?: OllamaApiToolCall[] };
  error?: string;
}

function toOllamaTool(decl: OllamaToolDeclaration): { type: "function"; function: { name: string; description: string; parameters: unknown } } {
  return { type: "function", function: { name: decl.name, description: decl.description, parameters: decl.parameters } };
}

async function callOnce(baseUrl: string, model: string, messages: OllamaMessage[], tools: OllamaToolDeclaration[]): Promise<OllamaApiResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages, tools: tools.map(toOllamaTool), stream: false, think: true, options: { num_predict: MAX_OUTPUT_TOKENS, num_ctx: CONTEXT_WINDOW_TOKENS } }),
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

async function callWithRetry(baseUrl: string, model: string, messages: OllamaMessage[], tools: OllamaToolDeclaration[]): Promise<OllamaApiResponse> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= GENERATE_MAX_ATTEMPTS; attempt++) {
    try {
      return await callOnce(baseUrl, model, messages, tools);
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

export interface RunOllamaToolLoopParams {
  baseUrl: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  tools: OllamaToolDeclaration[];
  executeTool: (name: string, input: Record<string, unknown>) => Promise<OllamaToolResult>;
}

export interface OllamaToolLoopResult {
  reply: string;
  toolCallCount: number;
}

/** Runs one bounded, stateless tool-calling turn: `systemPrompt` + `userPrompt` as the only messages, looping until the model stops calling tools or MAX_TOOL_ITERATIONS is hit. */
export async function runOllamaToolLoop(params: RunOllamaToolLoopParams): Promise<OllamaToolLoopResult> {
  const messages: OllamaMessage[] = [
    { role: "system", content: params.systemPrompt },
    { role: "user", content: params.userPrompt },
  ];

  let finalText = "";
  let toolCallCount = 0;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const response = await callWithRetry(params.baseUrl, params.model, messages, params.tools);
    const toolCalls = response.message?.tool_calls ?? [];
    const content = response.message?.content ?? "";
    messages.push({ role: "assistant", content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    finalText = content;

    if (toolCalls.length === 0) break;

    for (const call of toolCalls) {
      toolCallCount++;
      logger.info({ tool: call.function.name }, "ollama_tool_loop_tool_call");
      const result = await params.executeTool(call.function.name, call.function.arguments ?? {});
      messages.push({ role: "tool", tool_name: call.function.name, content: result.content });
    }
  }

  return { reply: finalText, toolCallCount };
}
