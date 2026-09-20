/**
 * Gemini equivalent of ollamaToolLoop.ts -- same stateless, bounded, single-turn shape (no
 * persisted history, no per-call gate to re-check), used ONLY as a fallback when the configured
 * Ollama host is unreachable (2026-09-09 operator request, after a real incident: the remote
 * Ollama box went dark for hours and silently zeroed out Scout/Taylor/the daily-plan scheduler
 * alike -- see assistant/client.ts's sendChatMessageWithFallback for the same fix on the trading
 * assistant's own, separately-implemented loop).
 *
 * Deliberately NOT unified with assistant/client.ts's Gemini loop -- that one persists multi-turn
 * AssistantMessage history and re-checks the assistantActionsEnabled gate before every tool call;
 * Scout/Taylor have neither property, same reasoning ollamaToolLoop.ts's own header comment gives
 * for not sharing with assistant/ollamaLoop.ts.
 *
 * Tool declarations are plain {name, description, parameters: JSON Schema} -- the exact same shape
 * ollamaToolLoop.ts's OllamaToolDeclaration uses (Scout/Taylor's own tools.ts files), which is also
 * exactly what Gemini's FunctionDeclaration.parametersJsonSchema expects directly, so no per-provider
 * tool translation is needed, unlike the trading assistant's own tools.ts (which is defined in
 * Gemini's shape first and translated TO Ollama's, the reverse direction).
 */
import { GoogleGenAI, type FunctionDeclaration, type Content, type Part } from "@google/genai";
import { getSettings } from "../core/config.js";
import { childLogger } from "../core/logger.js";
import type { OllamaToolDeclaration, OllamaToolResult } from "./ollamaToolLoop.js";

const logger = childLogger("geminiToolLoop");

// Mirrors ollamaToolLoop.ts's own bounds -- see that file's comments.
const MAX_TOOL_ITERATIONS = 10;
const MAX_OUTPUT_TOKENS = 4096;
// Shorter than ollamaToolLoop.ts's 300s (that generous bound exists specifically for a cold-loaded
// local model on a possibly-modest host) -- Gemini is a hosted API with no local cold-load concern,
// matches assistant/client.ts's own REQUEST_TIMEOUT_MS for the same reason.
const REQUEST_TIMEOUT_MS = 90_000;
const GENERATE_MAX_ATTEMPTS = 3;
const GENERATE_RETRY_DELAY_MS = 4_000;

let cachedClient: GoogleGenAI | undefined;
function getClient(): GoogleGenAI {
  if (cachedClient) return cachedClient;
  const settings = getSettings();
  if (!settings.geminiApiKey) throw new Error("GEMINI_API_KEY is not configured");
  cachedClient = new GoogleGenAI({ apiKey: settings.geminiApiKey });
  return cachedClient;
}

function toFunctionDeclaration(decl: OllamaToolDeclaration): FunctionDeclaration {
  return { name: decl.name, description: decl.description, parametersJsonSchema: decl.parameters };
}

async function generateContentWithRetry(
  client: GoogleGenAI,
  params: Parameters<GoogleGenAI["models"]["generateContent"]>[0]
): ReturnType<GoogleGenAI["models"]["generateContent"]> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= GENERATE_MAX_ATTEMPTS; attempt++) {
    try {
      return await client.models.generateContent(params);
    } catch (err) {
      lastErr = err;
      if (attempt < GENERATE_MAX_ATTEMPTS) {
        logger.warn({ attempt, err: String(err) }, "gemini_tool_loop_generate_failed_retrying");
        await new Promise((resolve) => setTimeout(resolve, GENERATE_RETRY_DELAY_MS));
      }
    }
  }
  throw lastErr;
}

export interface RunGeminiToolLoopParams {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  tools: OllamaToolDeclaration[];
  executeTool: (name: string, input: Record<string, unknown>) => Promise<OllamaToolResult>;
}

export interface GeminiToolLoopResult {
  reply: string;
  toolCallCount: number;
}

/** Runs one bounded, stateless tool-calling turn: `systemPrompt` + `userPrompt` as the only messages, looping until the model stops calling tools or MAX_TOOL_ITERATIONS is hit. Same contract as ollamaToolLoop.ts's runOllamaToolLoop. */
export async function runGeminiToolLoop(params: RunGeminiToolLoopParams): Promise<GeminiToolLoopResult> {
  const client = getClient();
  const functionDeclarations = params.tools.map(toFunctionDeclaration);
  const contents: Content[] = [{ role: "user", parts: [{ text: params.userPrompt }] }];

  let finalText = "";
  let toolCallCount = 0;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const response = await generateContentWithRetry(client, {
      model: params.model,
      contents,
      config: {
        systemInstruction: params.systemPrompt,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        tools: [{ functionDeclarations }],
        // Same reasoning as assistant/client.ts's own Gemini loop -- manual looping below is the
        // only thing allowed to execute a tool call.
        automaticFunctionCalling: { disable: true },
        httpOptions: { timeout: REQUEST_TIMEOUT_MS },
      },
    });

    const parts = response.candidates?.[0]?.content?.parts ?? [];
    contents.push({ role: "model", parts });
    finalText = response.text ?? "";

    const functionCalls = response.functionCalls ?? [];
    if (functionCalls.length === 0) break;

    const responseParts: Part[] = [];
    for (const call of functionCalls) {
      toolCallCount++;
      logger.info({ tool: call.name }, "gemini_tool_loop_tool_call");
      const result = await params.executeTool(call.name ?? "", call.args ?? {});
      responseParts.push({
        functionResponse: {
          id: call.id,
          name: call.name,
          response: result.isError ? { error: result.content } : { output: result.content },
        },
      });
    }
    contents.push({ role: "user", parts: responseParts });
  }

  return { reply: finalText, toolCallCount };
}
