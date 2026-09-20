/** Artifice's three tools -- two read (list_untriaged_blueprints, get_session_performance), one write (write_verdict). See systemPrompt.ts for how they're meant to be used together. */
import type { OllamaToolDeclaration, OllamaToolResult } from "../agentCore/ollamaToolLoop.js";
import type { ArtificeVerdictKind } from "./types.js";
import { listUntriagedBlueprints, getSessionPerformance } from "./blueprintQuery.js";
import { writeVerdict } from "./verdictStore.js";
import { childLogger } from "../core/logger.js";

const logger = childLogger("artificeTools");

const VALID_VERDICTS: ArtificeVerdictKind[] = ["build", "merge", "low_priority", "skip"];

export const ARTIFICE_TOOLS: OllamaToolDeclaration[] = [
  {
    name: "list_untriaged_blueprints",
    description:
      "Every Taylor blueprint that doesn't have an Artifice verdict yet, ALL of them at once -- read every one before writing any verdicts, so near-duplicate blueprints (the same underlying idea proposed more than once) are actually visible to compare, not reviewed one at a time in isolation.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "get_session_performance",
    description:
      "Real, current per-session performance breakdown (byMarketStructure/byLiquidity/byPriceAction: sampleSize, winRate, avgRMultiple) for every trading session. Use this to check whether a blueprint's own cited evidence (an avgR figure, a sample size) still holds against real data, instead of taking the blueprint's text on faith.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "write_verdict",
    description:
      "Write a triage verdict for one blueprint. Call once per blueprint from list_untriaged_blueprints -- process every one, not just the first. The only tool that writes anything.",
    parameters: {
      type: "object",
      properties: {
        blueprintId: { type: "number" },
        verdict: { type: "string", enum: VALID_VERDICTS, description: "build | merge | low_priority | skip -- see this agent's own system prompt for what each means." },
        mergeIntoBlueprintId: { type: "number", description: "Required when verdict is 'merge': the blueprintId whose build already covers this one. Omit otherwise." },
        reasoning: { type: "string", description: "Why this verdict -- cite real evidence (sample size, avgR) when relevant, and name the specific blueprint it duplicates when merging." },
      },
      required: ["blueprintId", "verdict", "reasoning"],
    },
  },
];

function toModelText(value: unknown): string {
  const MAX_CHARS = 12000;
  const json = JSON.stringify(value, null, 2) ?? "null";
  if (json.length <= MAX_CHARS) return json;
  return `${json.slice(0, MAX_CHARS)}\n... [truncated -- ${json.length} total chars]`;
}

export async function executeArtificeTool(name: string, input: Record<string, unknown>): Promise<OllamaToolResult> {
  try {
    switch (name) {
      case "list_untriaged_blueprints": {
        const result = await listUntriagedBlueprints();
        return { content: toModelText(result), isError: false };
      }
      case "get_session_performance": {
        const result = await getSessionPerformance();
        return { content: toModelText(result), isError: false };
      }
      case "write_verdict": {
        const blueprintId = Number(input.blueprintId);
        if (!Number.isInteger(blueprintId)) return { content: "Error: blueprintId must be an integer", isError: true };
        const verdict = input.verdict;
        if (typeof verdict !== "string" || !VALID_VERDICTS.includes(verdict as ArtificeVerdictKind)) {
          return { content: `Error: verdict must be one of ${VALID_VERDICTS.join(", ")} (got ${JSON.stringify(verdict)})`, isError: true };
        }
        const mergeIntoBlueprintId = input.mergeIntoBlueprintId != null ? Number(input.mergeIntoBlueprintId) : null;
        const result = await writeVerdict({
          blueprintId,
          verdict: verdict as ArtificeVerdictKind,
          mergeIntoBlueprintId,
          reasoning: String(input.reasoning ?? ""),
        });
        logger.info({ blueprintId: result.blueprintId, verdict: result.verdict }, "artifice_verdict_written");
        return { content: toModelText(result), isError: false };
      }
      default:
        return { content: `Unknown tool: ${name}`, isError: true };
    }
  } catch (err) {
    logger.warn({ tool: name, err: String(err) }, "artifice_tool_failed");
    return { content: `Error running ${name}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}
