/**
 * Artifice's own tool-calling turn -- a thin wrapper over agentCore/ollamaToolLoop.ts, same pattern
 * as scout/agentLoop.ts and taylor/agentLoop.ts, falling back to agentCore/geminiToolLoop.ts when
 * the Ollama host is unreachable (see that file's own header comment, and assistant/client.ts's
 * sendChatMessageWithFallback, for the 2026-09-09 incident that motivated this across every agent
 * in this repo).
 */
import { getSettings } from "../core/config.js";
import { runOllamaToolLoop, type OllamaToolLoopResult } from "../agentCore/ollamaToolLoop.js";
import { runGeminiToolLoop } from "../agentCore/geminiToolLoop.js";
import { ARTIFICE_SYSTEM_PROMPT } from "./systemPrompt.js";
import { executeArtificeTool, ARTIFICE_TOOLS } from "./tools.js";
import { childLogger } from "../core/logger.js";

const logger = childLogger("artificeAgentLoop");

export type ArtificeTurnResult = OllamaToolLoopResult;

const TICK_PROMPT = `Routine check. Call list_untriaged_blueprints. If any come back, triage every one this turn --
compare them against each other for duplicates before writing any verdict, call
get_session_performance if you need to check cited evidence, then call write_verdict once per
blueprint. If the list is empty, say so briefly and stop.`;

export async function runArtificeTurn(prompt: string = TICK_PROMPT): Promise<ArtificeTurnResult> {
  const settings = getSettings();
  try {
    return await runOllamaToolLoop({
      baseUrl: settings.artificeOllamaBaseUrl,
      model: settings.artificeOllamaModel,
      systemPrompt: ARTIFICE_SYSTEM_PROMPT,
      userPrompt: prompt,
      tools: ARTIFICE_TOOLS,
      executeTool: executeArtificeTool,
    });
  } catch (err) {
    if (!settings.geminiApiKey) throw err;
    logger.warn({ err: String(err) }, "artifice_ollama_unreachable_falling_back_to_gemini");
    return await runGeminiToolLoop({
      model: settings.assistantModel,
      systemPrompt: ARTIFICE_SYSTEM_PROMPT,
      userPrompt: prompt,
      tools: ARTIFICE_TOOLS,
      executeTool: executeArtificeTool,
    });
  }
}
