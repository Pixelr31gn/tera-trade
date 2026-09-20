/**
 * Taylor's own tool-calling turn -- a thin wrapper over agentCore/ollamaToolLoop.ts, same pattern
 * as scout/agentLoop.ts, falling back to agentCore/geminiToolLoop.ts when the Ollama host is
 * unreachable (see that file's own header comment, and assistant/client.ts's
 * sendChatMessageWithFallback, for the 2026-09-09 incident that motivated this).
 */
import { getSettings } from "../core/config.js";
import { runOllamaToolLoop, type OllamaToolLoopResult } from "../agentCore/ollamaToolLoop.js";
import { runGeminiToolLoop } from "../agentCore/geminiToolLoop.js";
import { TAYLOR_SYSTEM_PROMPT } from "./systemPrompt.js";
import { executeTaylorTool, TAYLOR_TOOLS } from "./tools.js";
import { childLogger } from "../core/logger.js";

const logger = childLogger("taylorAgentLoop");

export type TaylorTurnResult = OllamaToolLoopResult;

const TICK_PROMPT = `Routine check. Call list_approved_pitches. If any come back, call write_blueprint once for each --
process every pitch in the list, not just the first. If the list is empty, say so briefly and
stop.`;

export async function runTaylorTurn(prompt: string = TICK_PROMPT): Promise<TaylorTurnResult> {
  const settings = getSettings();
  try {
    return await runOllamaToolLoop({
      baseUrl: settings.taylorOllamaBaseUrl,
      model: settings.taylorOllamaModel,
      systemPrompt: TAYLOR_SYSTEM_PROMPT,
      userPrompt: prompt,
      tools: TAYLOR_TOOLS,
      executeTool: executeTaylorTool,
    });
  } catch (err) {
    if (!settings.geminiApiKey) throw err;
    logger.warn({ err: String(err) }, "taylor_ollama_unreachable_falling_back_to_gemini");
    return await runGeminiToolLoop({
      model: settings.assistantModel,
      systemPrompt: TAYLOR_SYSTEM_PROMPT,
      userPrompt: prompt,
      tools: TAYLOR_TOOLS,
      executeTool: executeTaylorTool,
    });
  }
}
