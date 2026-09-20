/** Auto-Provisioner's two tools -- one read (list_pending_blueprints), one write (write_scaffold_files). See systemPrompt.ts for the scope boundary on what write_scaffold_files is allowed to touch. */
import type { OllamaToolDeclaration, OllamaToolResult } from "../agentCore/ollamaToolLoop.js";
import { prisma } from "../db/client.js";
import { listPendingBlueprints } from "./blueprintQuery.js";
import { writeScaffoldFiles } from "./scaffold.js";
import { runTypeCheck } from "./validate.js";
import { recordProvisioningOutcome, recordProvisioningError } from "./checklist.js";
import type { ScaffoldFileSpec } from "./types.js";
import { childLogger } from "../core/logger.js";

const logger = childLogger("autoProvisionerTools");

export const AUTO_PROVISIONER_TOOLS: OllamaToolDeclaration[] = [
  {
    name: "list_pending_blueprints",
    description: "Every Taylor blueprint that hasn't been scaffolded yet (provisioningStatus=\"pending\"). Read-only.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "write_scaffold_files",
    description:
      "Write a first-draft implementation for one pending blueprint, staged for human review. Call once per blueprint from list_pending_blueprints. The only tool that writes anything -- see this agent's system prompt for what it may and may not touch.",
    parameters: {
      type: "object",
      properties: {
        blueprintId: { type: "number" },
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "Relative to this agent's own staging directory, e.g. \"types.ts\" or \"run.ts\"." },
              content: { type: "string", description: "Full file contents -- real TypeScript, not pseudocode." },
            },
            required: ["path", "content"],
          },
          description: "Every file the blueprint's architecture calls for.",
        },
        notes: {
          type: "string",
          description: "Config/env vars a human needs to add, npm script/supervisor needs, and any open-question judgment calls made.",
        },
      },
      required: ["blueprintId", "files", "notes"],
    },
  },
];

function toModelText(value: unknown): string {
  const MAX_CHARS = 6000;
  const json = JSON.stringify(value, null, 2) ?? "null";
  if (json.length <= MAX_CHARS) return json;
  return `${json.slice(0, MAX_CHARS)}\n... [truncated -- ${json.length} total chars]`;
}

export async function executeAutoProvisionerTool(name: string, input: Record<string, unknown>): Promise<OllamaToolResult> {
  try {
    switch (name) {
      case "list_pending_blueprints": {
        const result = await listPendingBlueprints();
        return { content: toModelText(result), isError: false };
      }
      case "write_scaffold_files": {
        const blueprintId = Number(input.blueprintId);
        if (!Number.isInteger(blueprintId)) return { content: "Error: blueprintId must be an integer", isError: true };

        const blueprint = await prisma.tailorBlueprint.findUnique({ where: { id: blueprintId }, include: { pitch: { select: { title: true } } } });
        if (!blueprint) return { content: `Error: no blueprint #${blueprintId} -- call list_pending_blueprints first and use one of the blueprintId values it returns.`, isError: true };

        const files: ScaffoldFileSpec[] = Array.isArray(input.files)
          ? (input.files as Record<string, unknown>[]).map((f) => ({ path: String(f.path ?? ""), content: String(f.content ?? "") }))
          : [];
        if (files.length === 0) return { content: "Error: files must be a non-empty array", isError: true };

        try {
          const { stagingDirAbsolute, stagingDirRepoRelative, filesWritten } = writeScaffoldFiles(blueprintId, blueprint.pitch.title, files);
          const typeCheck = await runTypeCheck();
          const { status, checklistPath } = await recordProvisioningOutcome({
            blueprintId,
            pitchId: blueprint.pitchId,
            pitchTitle: blueprint.pitch.title,
            stagingDirAbsolute,
            stagingDirRepoRelative,
            filesWritten,
            modelNotes: String(input.notes ?? ""),
            typeCheck,
          });
          logger.info({ blueprintId, status, filesWritten: filesWritten.length, typeCheckOk: typeCheck.ok }, "auto_provisioner_scaffold_written");
          return { content: toModelText({ status, stagingDir: stagingDirRepoRelative, filesWritten, typeCheckOk: typeCheck.ok, checklistPath }), isError: false };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await recordProvisioningError(blueprintId, message);
          return { content: `Error scaffolding blueprint #${blueprintId}: ${message}`, isError: true };
        }
      }
      default:
        return { content: `Unknown tool: ${name}`, isError: true };
    }
  } catch (err) {
    logger.warn({ tool: name, err: String(err) }, "auto_provisioner_tool_failed");
    return { content: `Error running ${name}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}
