/**
 * The assistant's tool-use loop against Anthropic's Claude (ASSISTANT_PROVIDER
 * = "claude", see core/config.ts). Added 2026-11-14, operator request: "i want
 * to use a claude agent to run ... the assistant section". Same safety
 * properties as client.ts's Gemini loop and ollamaLoop.ts:
 *   - the tool list is re-resolved from the assistantActionsEnabled gate before
 *     EVERY model call, and every write tool re-checks that gate and the kill
 *     switch inline (tools.ts's withAssistantAudit);
 *   - tool calls in one response run sequentially, never in parallel, so a gate
 *     flip mid-turn takes effect on the very next call;
 *   - MAX_TOOL_ITERATIONS bounds a turn against a real-money account.
 *
 * History is persisted to the same AssistantMessage table under its own
 * envelope ({ __provider: "claude", messages }) -- the Gemini and Ollama
 * loaders already skip shapes they don't recognize, and this loader skips
 * theirs, so switching providers never misreads the other's rows.
 *
 * Replaying history (Claude API "preserved thinking" rules): a thinking block
 * is tied to the exact conversation prefix that produced it, and the chat
 * loads a sliding window of the last HISTORY_MESSAGE_LIMIT rows, which drops
 * turns from the front -- replaying old thinking blocks would invalidate them.
 * So earlier turns are replayed as text / tool_use / tool_result only, and
 * thinking blocks are passed back unchanged only WITHIN one turn's tool loop
 * (append-only there). The tool list can still change mid-turn (the gate), so
 * requests set prefix_mismatch_behavior "drop_block" to degrade instead of 400.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { FunctionDeclaration } from "@google/genai";
import type { Prisma } from "@prisma/client";
import { getSettings } from "../core/config.js";
import { childLogger } from "../core/logger.js";
import { prisma } from "../db/client.js";
import { getSystemState } from "../execution/mode.js";
import type { ChatResult } from "./client.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";
import { executeTool, getAvailableTools, type ToolExecutionResult } from "./tools.js";

const logger = childLogger("claudeLoop");

type MessageParam = Anthropic.Beta.BetaMessageParam;
type BlockParam = Anthropic.Beta.BetaContentBlockParam;

const MAX_TOOL_ITERATIONS = 10;
const MAX_OUTPUT_TOKENS = 16_000;
const HISTORY_MESSAGE_LIMIT = 40;
// Per-request timeout; the SDK already retries 408/409/429/5xx and connection
// errors (maxRetries, default 2) -- the same job client.ts's
// generateContentWithRetry does by hand for Gemini.
const REQUEST_TIMEOUT_MS = 180_000;
// Claude Opus 5.5 defaults to "medium"; set explicitly so a model change in
// ANTHROPIC_MODEL can't silently change it.
const EFFORT = "medium";
const BETAS = [
  // thinking.block_binding.prefix_mismatch_behavior -- see header comment.
  "thinking-binding-controls-2026-08-01",
  // fallbacks: "default" -- on a safety-classifier decline the API re-runs the
  // request on a fallback model instead of returning an empty refusal.
  "server-side-fallback-2026-07-01",
];

let cachedClient: Anthropic | undefined;
function getClient(): Anthropic {
  if (cachedClient) return cachedClient;
  const settings = getSettings();
  if (!settings.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is not configured");
  cachedClient = new Anthropic({ apiKey: settings.anthropicApiKey, timeout: REQUEST_TIMEOUT_MS });
  return cachedClient;
}

/** tools.ts declares Gemini-shaped FunctionDeclarations whose parametersJsonSchema is plain JSON Schema -- Claude's input_schema takes it as-is. */
function toClaudeTools(decls: FunctionDeclaration[]): Anthropic.Beta.BetaTool[] {
  return decls.map((d) => ({
    name: d.name ?? "",
    description: d.description ?? "",
    input_schema: (d.parametersJsonSchema ?? { type: "object", properties: {} }) as Anthropic.Beta.BetaTool.InputSchema,
  }));
}

async function callClaude(messages: MessageParam[], tools: Anthropic.Beta.BetaTool[]): Promise<Anthropic.Beta.BetaMessage> {
  const settings = getSettings();
  // block_binding and fallbacks are newer than some SDK type definitions; the
  // cast keeps the request shape exactly as the API documents it.
  const params = {
    model: settings.anthropicModel,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: SYSTEM_PROMPT,
    tools,
    messages,
    thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
    output_config: { effort: EFFORT },
    cache_control: { type: "ephemeral" },
    fallbacks: "default",
    betas: BETAS,
  } as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming;
  return await getClient().beta.messages.create(params);
}

function textOf(content: Anthropic.Beta.BetaContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

interface LoopHooks {
  /** Called with each assistant message as it lands; returns its row id (or null when nothing is persisted). */
  onAssistant: (message: MessageParam) => Promise<number | null>;
  onToolResults: (message: MessageParam) => Promise<void>;
  execute: (name: string, input: Record<string, unknown>, assistantRowId: number | null) => Promise<ToolExecutionResult>;
  toolNames?: string[];
}

interface LoopResult {
  reply: string;
  toolCallCount: number;
  lastAssistantId: number | null;
}

/** The shared tool loop. `messages` is appended to in place (append-only within a turn). */
async function runLoop(messages: MessageParam[], hooks: LoopHooks): Promise<LoopResult> {
  const settings = getSettings();
  let reply = "";
  let toolCallCount = 0;
  let lastAssistantId: number | null = null;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const systemState = await getSystemState();
    const actionsEnabled = settings.assistantEnabled && systemState.assistantActionsEnabled;
    let decls = getAvailableTools(actionsEnabled);
    if (hooks.toolNames) decls = decls.filter((d) => hooks.toolNames!.includes(d.name ?? ""));

    const response = await callClaude(messages, toClaudeTools(decls));

    if (response.stop_reason === "refusal") {
      const category = response.stop_details?.category ?? "unspecified";
      reply = `Claude declined this request (category: ${category}).`;
      logger.warn({ category }, "claude_refusal");
      lastAssistantId = await hooks.onAssistant({ role: "assistant", content: [{ type: "text", text: reply }] });
      break;
    }

    const assistantMessage: MessageParam = { role: "assistant", content: response.content as BlockParam[] };
    messages.push(assistantMessage);
    lastAssistantId = await hooks.onAssistant(assistantMessage);
    reply = textOf(response.content);
    if (response.stop_reason === "max_tokens") reply = `${reply}\n\n[reply cut off at the output limit]`.trim();

    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) break;

    // Sequential on purpose -- see the header comment.
    const results: BlockParam[] = [];
    for (const use of toolUses) {
      logger.info({ tool: use.name }, "assistant_tool_call");
      const input = use.input && typeof use.input === "object" ? (use.input as Record<string, unknown>) : {};
      const result = await hooks.execute(use.name, input, lastAssistantId);
      toolCallCount++;
      results.push({ type: "tool_result", tool_use_id: use.id, content: result.content, is_error: result.isError });
    }
    const resultsMessage: MessageParam = { role: "user", content: results };
    messages.push(resultsMessage);
    await hooks.onToolResults(resultsMessage);
  }

  return { reply, toolCallCount, lastAssistantId };
}

// ---- persisted history ------------------------------------------------------

interface ClaudeEnvelope {
  __provider: "claude";
  messages: MessageParam[];
}

function toEnvelope(messages: MessageParam[]): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify({ __provider: "claude", messages })) as Prisma.InputJsonValue;
}

function isClaudeEnvelope(value: unknown): value is ClaudeEnvelope {
  return typeof value === "object" && value !== null && (value as { __provider?: unknown }).__provider === "claude" && Array.isArray((value as { messages?: unknown }).messages);
}

function blocksOf(message: MessageParam): BlockParam[] {
  const content = message.content as unknown;
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  return Array.isArray(content) ? (content as BlockParam[]) : [];
}

/**
 * Earlier turns as text / tool_use / tool_result only (see header comment),
 * with every tool_use paired to its tool_result -- a crash mid-turn, or the
 * window's front edge cutting a pair in half, would otherwise leave an
 * unpaired block the API rejects.
 */
export function sanitizeClaudeHistory(raw: MessageParam[]): MessageParam[] {
  const keep = (b: BlockParam) => (b.type === "text" && typeof b.text === "string" && b.text.trim() !== "") || b.type === "tool_use" || b.type === "tool_result";
  const msgs = raw
    .filter((m): m is MessageParam & { role: "user" | "assistant" } => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: blocksOf(m).filter(keep) }));
  const out: { role: "user" | "assistant"; content: BlockParam[] }[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]!;
    let content = m.content;
    if (m.role === "assistant") {
      const uses = content.filter((b) => b.type === "tool_use") as Anthropic.Beta.BetaToolUseBlockParam[];
      if (uses.length > 0) {
        const next = msgs[i + 1];
        const answered = new Set(
          next && next.role === "user" ? (next.content.filter((b) => b.type === "tool_result") as Anthropic.Beta.BetaToolResultBlockParam[]).map((b) => b.tool_use_id) : [],
        );
        if (!uses.every((u) => answered.has(u.id))) content = content.filter((b) => b.type === "text");
      }
    } else {
      const prev = out.at(-1);
      const asked = new Set(prev && prev.role === "assistant" ? (prev.content.filter((b) => b.type === "tool_use") as Anthropic.Beta.BetaToolUseBlockParam[]).map((b) => b.id) : []);
      content = content.filter((b) => b.type !== "tool_result" || asked.has((b as Anthropic.Beta.BetaToolResultBlockParam).tool_use_id));
    }
    if (content.length > 0) out.push({ role: m.role, content });
  }
  while (out.length > 0 && out[0]!.role !== "user") out.shift();
  return out;
}

export async function sendClaudeChatMessageUnserialized(userText: string): Promise<ChatResult> {
  const settings = getSettings();
  if (!settings.assistantEnabled) throw new Error("Assistant is disabled (ASSISTANT_ENABLED=false)");
  getClient(); // fail fast on a missing key, before anything is persisted

  const historyRows = await prisma.assistantMessage.findMany({ orderBy: { createdAt: "desc" }, take: HISTORY_MESSAGE_LIMIT });
  const history = sanitizeClaudeHistory(
    historyRows
      .reverse()
      .map((r) => r.content as unknown)
      .filter(isClaudeEnvelope)
      .flatMap((env) => env.messages),
  );

  const userMessage: MessageParam = { role: "user", content: userText };
  await prisma.assistantMessage.create({ data: { role: "user", content: toEnvelope([userMessage]) } });
  const messages: MessageParam[] = [...history, userMessage];

  const result = await runLoop(messages, {
    onAssistant: async (message) => (await prisma.assistantMessage.create({ data: { role: "assistant", content: toEnvelope([message]) } })).id,
    // Stored under DB role "user", matching client.ts/ollamaLoop.ts's convention for tool-result turns.
    onToolResults: async (message) => void (await prisma.assistantMessage.create({ data: { role: "user", content: toEnvelope([message]) } })),
    execute: (name, input, rowId) => executeTool(name, input, rowId),
  });

  if (result.lastAssistantId === null) throw new Error("assistant produced no response");
  return { reply: result.reply, messageId: result.lastAssistantId };
}

/** One unattended turn with no persisted history -- see statelessTurn.ts for why the daily-plan scheduler needs this shape. */
export async function runClaudeStatelessTurn(userPrompt: string, toolNames?: string[]): Promise<{ reply: string; toolCallCount: number }> {
  const result = await runLoop([{ role: "user", content: userPrompt }], {
    onAssistant: async () => null,
    onToolResults: async () => undefined,
    // Null messageId: there is no AssistantMessage row for a stateless turn.
    execute: (name, input) => executeTool(name, input, null),
    toolNames,
  });
  return { reply: result.reply, toolCallCount: result.toolCallCount };
}
