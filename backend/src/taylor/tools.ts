/** Taylor's two tools -- one read (list_approved_pitches), one write (write_blueprint). See systemPrompt.ts for why that's deliberately the full extent of what Taylor can do. */
import type { OllamaToolDeclaration, OllamaToolResult } from "../agentCore/ollamaToolLoop.js";
import type { ToolDefinitionSpec, WriteBlueprintInput } from "./types.js";
import { listApprovedPitches } from "./pitchQuery.js";
import { writeBlueprint } from "./blueprintStore.js";
import { childLogger } from "../core/logger.js";

const logger = childLogger("taylorTools");

export const TAYLOR_TOOLS: OllamaToolDeclaration[] = [
  {
    name: "list_approved_pitches",
    description: "Every Scout pitch the operator has rated highly enough to count as approved, that doesn't already have a blueprint. Read-only.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "write_blueprint",
    description: "Write a detailed build blueprint for one approved pitch. Call once per pitch from list_approved_pitches. The only tool that writes anything.",
    parameters: {
      type: "object",
      properties: {
        pitchId: { type: "number" },
        overview: { type: "string", description: "What this agent does and why, 2-4 sentences." },
        architecture: { type: "string", description: "Concrete file/module layout, following this repo's own established agent shape." },
        dataModelChanges: { type: "string", description: "Concrete Prisma model/field additions needed, or 'none'." },
        toolDefinitions: {
          type: "array",
          items: { type: "object", properties: { name: { type: "string" }, description: { type: "string" } }, required: ["name", "description"] },
          description: "Concrete tool-by-tool breakdown, expanding the pitch's rough toolsNeeded list.",
        },
        implementationSteps: { type: "array", items: { type: "string" }, description: "Ordered, concrete steps." },
        openQuestions: { type: "array", items: { type: "string" }, description: "What a human should decide/confirm before building this." },
      },
      required: ["pitchId", "overview", "architecture", "dataModelChanges", "toolDefinitions", "implementationSteps", "openQuestions"],
    },
  },
];

function toModelText(value: unknown): string {
  const MAX_CHARS = 8000;
  const json = JSON.stringify(value, null, 2) ?? "null";
  if (json.length <= MAX_CHARS) return json;
  return `${json.slice(0, MAX_CHARS)}\n... [truncated -- ${json.length} total chars]`;
}

export async function executeTaylorTool(name: string, input: Record<string, unknown>): Promise<OllamaToolResult> {
  try {
    switch (name) {
      case "list_approved_pitches": {
        const result = await listApprovedPitches();
        return { content: toModelText(result), isError: false };
      }
      case "write_blueprint": {
        const pitchId = Number(input.pitchId);
        if (!Number.isInteger(pitchId)) return { content: "Error: pitchId must be an integer", isError: true };
        const toolDefinitions = Array.isArray(input.toolDefinitions) ? (input.toolDefinitions as ToolDefinitionSpec[]) : [];
        const blueprintInput: WriteBlueprintInput = {
          pitchId,
          overview: String(input.overview ?? ""),
          architecture: String(input.architecture ?? ""),
          dataModelChanges: String(input.dataModelChanges ?? ""),
          toolDefinitions: toolDefinitions.map((t) => ({ name: String(t.name ?? ""), description: String(t.description ?? "") })),
          implementationSteps: Array.isArray(input.implementationSteps) ? input.implementationSteps.map(String) : [],
          openQuestions: Array.isArray(input.openQuestions) ? input.openQuestions.map(String) : [],
        };
        const result = await writeBlueprint(blueprintInput);
        logger.info({ pitchId: result.pitchId, blueprintId: result.blueprintId }, "taylor_blueprint_written");
        return { content: toModelText(result), isError: false };
      }
      default:
        return { content: `Unknown tool: ${name}`, isError: true };
    }
  } catch (err) {
    logger.warn({ tool: name, err: String(err) }, "taylor_tool_failed");
    return { content: `Error running ${name}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}
