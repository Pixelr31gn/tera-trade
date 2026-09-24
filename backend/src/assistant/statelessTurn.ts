/**
 * One unattended assistant turn with NO persisted conversation history.
 *
 * 2026-09-24. assistant/client.ts's sendChatMessage exists for the operator's
 * interactive chat, where multi-turn history is the point: it loads the last
 * HISTORY_MESSAGE_LIMIT (40) AssistantMessage rows as context and persists the
 * user message BEFORE calling the model. Both properties are actively harmful
 * for a machine-generated, unattended turn, and the daily-plan scheduler --
 * which has no conversation to continue -- had been going through it anyway.
 *
 * The failure that forced this, measured live:
 *
 *   - dailyPlanScheduler's prompt embeds buildContextDigest, ~29 KB of market
 *     JSON. client.ts persists that user row before the API call, so every
 *     FAILED attempt leaves an orphan with no assistant reply.
 *   - Orphans accumulate in the recent-40 window. At 101 user rows against 23
 *     assistant rows, a call was loading 40 x ~29 KB ~= 1.17 MB ~= 290k input
 *     tokens -- past Gemini's 250k-per-minute free-tier input cap before the
 *     new digest was even appended.
 *   - So every call failed on input tokens, which persisted another digest,
 *     which guaranteed the next failure. A deadlock, not a quota to wait out:
 *     three consecutive sessions (2026-09-23 NY through 2026-09-24 NY) got no
 *     daily plan at all, an ~18-hour gap.
 *   - The 2026-09-22 POLL_INTERVAL_MS change from 5min to 1min (made so the
 *     pre-trigger would land 10 minutes out) accelerated this 5x: the
 *     catch-up path retries on the same tick, so a session with no plan
 *     re-attempted every minute, each attempt writing another 29 KB row.
 *
 * A stateless turn cannot do any of that: nothing is read from history,
 * nothing is written to it, so a failed refresh leaves no residue and the next
 * attempt starts exactly as small as the first. This is the same shape
 * Scout/Taylor/Artifice already use (agentCore/*ToolLoop.ts) and the same call
 * the tera/assistant.ts extraction made for the same reason.
 *
 * Tool EXECUTION is unchanged -- same assistant/tools.ts handlers, same
 * withAssistantAudit gate re-check before every write, same AssistantAction
 * audit rows. Only the conversation transcript is dropped. Audit rows get a
 * null messageId (the column is already nullable, and executeTool already
 * takes `number | null`) because there is no message row to point at.
 */
import { runGeminiToolLoop } from "../agentCore/geminiToolLoop.js";
import { runOllamaToolLoop, type OllamaToolDeclaration } from "../agentCore/ollamaToolLoop.js";
import { getSettings } from "../core/config.js";
import { childLogger } from "../core/logger.js";
import { getSystemState } from "../execution/mode.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";
import { executeTool, getAvailableTools } from "./tools.js";

const logger = childLogger("assistantStatelessTurn");

export interface StatelessTurnResult {
  reply: string;
  toolCallCount: number;
}

/**
 * assistant/tools.ts declares its tools in Gemini's own FunctionDeclaration
 * shape (`parametersJsonSchema`). agentCore's two loops both take the plain
 * {name, description, parameters} shape -- which geminiToolLoop then hands
 * straight back to Gemini as parametersJsonSchema, so this is a rename, not a
 * translation, and nothing about the schema changes.
 */
function toAgentCoreTools(actionsEnabled: boolean): OllamaToolDeclaration[] {
  return getAvailableTools(actionsEnabled).map((t) => ({
    name: t.name ?? "",
    description: t.description ?? "",
    parameters: (t.parametersJsonSchema ?? {}) as Record<string, unknown>,
  }));
}

/**
 * Runs `userPrompt` as a single stateless tool-calling turn, routed by
 * ASSISTANT_PROVIDER with the same Ollama-unreachable-falls-back-to-Gemini
 * behaviour sendChatMessage has (see its sendChatMessageWithFallback comment
 * for the incident behind that fallback).
 *
 * Deliberately NOT serialized through client.ts's chatQueue: that queue exists
 * to stop overlapping calls interleaving their history WRITES, and this path
 * performs none. The scheduler has its own refreshInFlight guard against
 * overlapping refreshes.
 */
export async function runStatelessAssistantTurn(userPrompt: string): Promise<StatelessTurnResult> {
  const settings = getSettings();
  if (!settings.assistantEnabled) throw new Error("Assistant is disabled (ASSISTANT_ENABLED=false)");

  const systemState = await getSystemState();
  const actionsEnabled = settings.assistantEnabled && systemState.assistantActionsEnabled;
  const tools = toAgentCoreTools(actionsEnabled);
  // Null messageId: there is no AssistantMessage row for a stateless turn.
  const execute = (name: string, input: Record<string, unknown>) => executeTool(name, input, null);

  if (settings.assistantProvider === "ollama") {
    try {
      return await runOllamaToolLoop({
        baseUrl: settings.ollamaBaseUrl,
        model: settings.ollamaModel,
        systemPrompt: SYSTEM_PROMPT,
        userPrompt,
        tools,
        executeTool: execute,
      });
    } catch (err) {
      if (!settings.geminiApiKey) throw err;
      logger.warn({ err: String(err) }, "stateless_turn_ollama_unreachable_falling_back_to_gemini");
    }
  }

  return await runGeminiToolLoop({
    model: settings.assistantModel,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    tools,
    executeTool: execute,
  });
}
