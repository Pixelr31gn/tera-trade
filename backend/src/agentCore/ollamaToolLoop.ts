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

/**
 * stream: true (2026-10-05). With stream: false, Ollama sends nothing -- not
 * even response headers -- until generation is finished, and Node's built-in
 * fetch (undici) gives up on a response whose headers haven't arrived within
 * its own fixed 300s headersTimeout, independent of any AbortController. A
 * plan build on the local model (~4 tokens/s, thousands of reasoning tokens)
 * therefore died with "TypeError: fetch failed" at exactly 5:00 even after
 * its own timeout was raised to 15 minutes. Streaming sends headers at once
 * and a chunk every few tokens, so neither undici limit is reached; the
 * chunks are reassembled here into the same single response shape the rest
 * of this file already handles.
 */
async function callOnce(baseUrl: string, model: string, messages: OllamaMessage[], tools: OllamaToolDeclaration[], timeoutMs: number, contextTokens: number): Promise<OllamaApiResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages, tools: tools.map(toOllamaTool), stream: true, think: true, options: { num_predict: MAX_OUTPUT_TOKENS, num_ctx: contextTokens } }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Ollama chat request failed: HTTP ${res.status} ${await res.text()}`);
    return await readOllamaChatStream(res);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Reassembles a streamed (stream: true) /api/chat response into the single
 * {message: {role, content, tool_calls?}} shape a non-streamed call returns.
 * Shared with assistant/ollamaLoop.ts -- see callOnce above for why both
 * paths stream.
 */
export async function readOllamaChatStream(res: Response): Promise<{ message: { role: string; content: string; tool_calls?: OllamaApiToolCall[] } }> {
  if (!res.body) throw new Error("Ollama chat response had no body");
  let content = "";
  const toolCalls: OllamaApiToolCall[] = [];
  let buffered = "";
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  const handleLine = (line: string): void => {
    if (!line.trim()) return;
    const chunk = JSON.parse(line) as { message?: { content?: string; tool_calls?: OllamaApiToolCall[] }; error?: string };
    if (chunk.error) throw new Error(`Ollama chat error: ${chunk.error}`);
    content += chunk.message?.content ?? "";
    if (chunk.message?.tool_calls) toolCalls.push(...chunk.message.tool_calls);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  }
  handleLine(buffered + decoder.decode());
  return { message: { role: "assistant", content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } };
}

async function callWithRetry(baseUrl: string, model: string, messages: OllamaMessage[], tools: OllamaToolDeclaration[], timeoutMs: number, contextTokens: number): Promise<OllamaApiResponse> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= GENERATE_MAX_ATTEMPTS; attempt++) {
    try {
      return await callOnce(baseUrl, model, messages, tools, timeoutMs, contextTokens);
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
  /**
   * Per-call timeout override; REQUEST_TIMEOUT_MS when omitted. The daily-plan
   * turn passes a longer one (2026-10-05): on a partly CPU-bound local model
   * it spends minutes generating its reasoning, and every plan attempt that
   * night was aborted at exactly 5:00.
   */
  requestTimeoutMs?: number;
  /**
   * num_ctx override; CONTEXT_WINDOW_TOKENS when omitted. The KV cache for
   * 65,536 tokens pushes qwen3:8b ~38% onto the CPU of an 8 GB GPU (measured
   * 2026-10-05: ~4 tokens/s). The daily-plan turn needs ~20k, so it asks for
   * less -- see dailyPlanScheduler.ts's PLAN_TURN_CONTEXT_TOKENS.
   */
  contextTokens?: number;
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
    const response = await callWithRetry(params.baseUrl, params.model, messages, params.tools, params.requestTimeoutMs ?? REQUEST_TIMEOUT_MS, params.contextTokens ?? CONTEXT_WINDOW_TOKENS);
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
