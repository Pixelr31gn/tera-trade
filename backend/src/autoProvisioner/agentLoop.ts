/**
 * Auto-Provisioner's own tool-calling turn -- same shape as scout/agentLoop.ts and
 * taylor/agentLoop.ts: a thin wrapper over agentCore/ollamaToolLoop.ts, falling back to
 * agentCore/geminiToolLoop.ts when Ollama is unreachable.
 *
 * Known constraint, not fixed here: ollamaToolLoop.ts's MAX_OUTPUT_TOKENS (4096) is shared across
 * every agent that uses it -- fine for Scout/Taylor's prose-sized replies, but a blueprint asking
 * for several complete files can genuinely exceed it in one write_scaffold_files call. Bumping that
 * shared constant would change Scout/Taylor's own budget/cost too, which is out of scope for this
 * build -- if a scaffold comes back visibly truncated, that's a signal to either raise the shared
 * constant deliberately or have the model split large blueprints across multiple tool calls, not
 * something this file should quietly work around on its own.
 */
import { getSettings } from "../core/config.js";
import { runOllamaToolLoop, type OllamaToolLoopResult } from "../agentCore/ollamaToolLoop.js";
import { runGeminiToolLoop } from "../agentCore/geminiToolLoop.js";
import { AUTO_PROVISIONER_SYSTEM_PROMPT } from "./systemPrompt.js";
import { executeAutoProvisionerTool, AUTO_PROVISIONER_TOOLS } from "./tools.js";
import { childLogger } from "../core/logger.js";

const logger = childLogger("autoProvisionerAgentLoop");

export type AutoProvisionerTurnResult = OllamaToolLoopResult;

const TICK_PROMPT = `Routine check. Call list_pending_blueprints. If any come back, call write_scaffold_files once
for each -- process every blueprint in the list, not just the first. If the list is empty, say so
briefly and stop.`;

export async function runAutoProvisionerTurn(prompt: string = TICK_PROMPT): Promise<AutoProvisionerTurnResult> {
  const settings = getSettings();
  try {
    return await runOllamaToolLoop({
      baseUrl: settings.autoProvisionerOllamaBaseUrl,
      model: settings.autoProvisionerOllamaModel,
      systemPrompt: AUTO_PROVISIONER_SYSTEM_PROMPT,
      userPrompt: prompt,
      tools: AUTO_PROVISIONER_TOOLS,
      executeTool: executeAutoProvisionerTool,
    });
  } catch (err) {
    if (!settings.geminiApiKey) throw err;
    logger.warn({ err: String(err) }, "auto_provisioner_ollama_unreachable_falling_back_to_gemini");
    return await runGeminiToolLoop({
      model: settings.assistantModel,
      systemPrompt: AUTO_PROVISIONER_SYSTEM_PROMPT,
      userPrompt: prompt,
      tools: AUTO_PROVISIONER_TOOLS,
      executeTool: executeAutoProvisionerTool,
    });
  }
}
