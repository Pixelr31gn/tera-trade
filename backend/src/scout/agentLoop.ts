/**
 * Scout's own tool-calling turn -- a thin wrapper over the shared agentCore/ollamaToolLoop.ts
 * (see that file's header comment for why it's shared with Taylor but not the trading assistant),
 * supplying Scout's own system prompt, tools, and Ollama settings.
 *
 * Falls back to agentCore/geminiToolLoop.ts when the Ollama host is unreachable (2026-09-09
 * operator request -- see assistant/client.ts's sendChatMessageWithFallback for the same fix on
 * the trading assistant's own loop, added after a real incident where the remote Ollama box went
 * dark for hours and silently zeroed out Scout, Taylor, and the daily-plan scheduler alike).
 */
import { getSettings } from "../core/config.js";
import { runOllamaToolLoop, type OllamaToolLoopResult } from "../agentCore/ollamaToolLoop.js";
import { runGeminiToolLoop } from "../agentCore/geminiToolLoop.js";
import { SCOUT_SYSTEM_PROMPT } from "./systemPrompt.js";
import { executeScoutTool, SCOUT_TOOLS } from "./tools.js";
import { childLogger } from "../core/logger.js";

const logger = childLogger("scoutAgentLoop");

export type ScoutTurnResult = OllamaToolLoopResult;

export async function runScoutTurn(prompt: string): Promise<ScoutTurnResult> {
  const settings = getSettings();
  try {
    return await runOllamaToolLoop({
      baseUrl: settings.scoutOllamaBaseUrl,
      model: settings.scoutOllamaModel,
      systemPrompt: SCOUT_SYSTEM_PROMPT,
      userPrompt: prompt,
      tools: SCOUT_TOOLS,
      executeTool: executeScoutTool,
    });
  } catch (err) {
    if (!settings.geminiApiKey) throw err;
    logger.warn({ err: String(err) }, "scout_ollama_unreachable_falling_back_to_gemini");
    return await runGeminiToolLoop({
      model: settings.assistantModel,
      systemPrompt: SCOUT_SYSTEM_PROMPT,
      userPrompt: prompt,
      tools: SCOUT_TOOLS,
      executeTool: executeScoutTool,
    });
  }
}
