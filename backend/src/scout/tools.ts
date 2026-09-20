/**
 * Scout's four tools (native Ollama tool calling, see agentLoop.ts). Unlike the trading
 * assistant's tools.ts, there is no read/write split with a gate to check -- Scout has exactly one
 * tool that writes anything (write_pitch), and it writes only to ScoutPitch/ScoutDigest, never to
 * a trading table.
 */
import type { PitchCategory, WritePitchInput } from "./types.js";
import { queryRecentTradesAndSessions } from "./runtimeSignals.js";
import { scanRecentActivity } from "./buildActivity.js";
import { writePitch } from "./pitchStore.js";
import { compileDigest } from "./digest.js";
import { childLogger } from "../core/logger.js";

const logger = childLogger("scoutTools");

export interface ScoutToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const SCOUT_TOOLS: ScoutToolDeclaration[] = [
  {
    name: "query_recent_trades_and_sessions",
    description:
      "Tera Trade's own runtime data: recent session/strategy-version performance, per-regime trade outcomes, EVERY action the trading assistant has taken recently grouped by tool (from its own audit log -- not just manual corrections, includes routine/scheduler-triggered calls and their success/error counts), and currently disabled strategies/symbols. Read-only, reuses data the trading system already logs.",
    parameters: {
      type: "object",
      properties: { lookbackHours: { type: "number", description: "How far back to look for regime/correction data. Default 72." } },
    },
  },
  {
    name: "scan_recent_activity",
    description:
      "Recent build activity on this repo: files touched, repeated shell commands, repeated tool errors -- from Claude Code session logs, a live file watcher, and shell history. Incremental (since your last call), not a fixed replay window.",
    parameters: {
      type: "object",
      properties: { lookbackHours: { type: "number", description: "Time window for the file-watcher ring buffer specifically. Default 24." } },
    },
  },
  {
    name: "write_pitch",
    description:
      "Write (or reinforce, if the title matches an existing pitch) a pitch for a small agent that would fix a recurring frequency+friction overlap you've found. This is the only tool that writes durable state.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short, specific, stable across re-pitches -- this is the dedupe key." },
        problem: { type: "string", description: "What recurring frequency+friction this addresses, in plain English." },
        proposedAgent: { type: "string", description: "What the new agent would actually do." },
        toolsNeeded: { type: "array", items: { type: "string" }, description: "Rough list of tools/integrations it would need." },
        costEstimate: {
          type: "string",
          description:
            "Rough, not precise. LLM calls through this repo's own local Ollama install (which you and the trading assistant both already run on) cost ~$0 regardless of call volume -- say so explicitly ('$0, runs on the local Ollama install') rather than pricing them as API spend. Only put a real dollar figure on a genuinely different paid dependency the pitch would need (a hosted SaaS, a cloud service, a non-Ollama API).",
        },
        frequencyEstimate: { type: "string", description: "Rough run-frequency -- e.g. 'daily', 'on each PR', 'hourly'." },
        category: { type: "string", enum: ["frequency", "friction", "both"] },
        evidenceSummary: { type: "string", description: "One sentence: the specific observation from this turn that supports this pitch." },
        evidenceSource: { type: "string", enum: ["build_activity", "runtime"] },
      },
      required: ["title", "problem", "proposedAgent", "toolsNeeded", "costEstimate", "frequencyEstimate", "category", "evidenceSummary", "evidenceSource"],
    },
  },
  {
    name: "compile_digest",
    description: "Compile today's digest from the current pitch ranking and write it out. Only call this when explicitly asked to -- the daily scheduler asks for this once, at end of day.",
    parameters: { type: "object", properties: {} },
  },
];

export interface ScoutToolResult {
  content: string;
  isError: boolean;
}

function toModelText(value: unknown): string {
  const MAX_CHARS = 8000;
  const json = JSON.stringify(value, null, 2) ?? "null";
  if (json.length <= MAX_CHARS) return json;
  return `${json.slice(0, MAX_CHARS)}\n... [truncated -- ${json.length} total chars]`;
}

export async function executeScoutTool(name: string, input: Record<string, unknown>): Promise<ScoutToolResult> {
  try {
    switch (name) {
      case "query_recent_trades_and_sessions": {
        const result = await queryRecentTradesAndSessions(typeof input.lookbackHours === "number" ? input.lookbackHours : undefined);
        return { content: toModelText(result), isError: false };
      }
      case "scan_recent_activity": {
        const result = await scanRecentActivity(typeof input.lookbackHours === "number" ? input.lookbackHours : undefined);
        return { content: toModelText(result), isError: false };
      }
      case "write_pitch": {
        const toolsNeeded = Array.isArray(input.toolsNeeded) ? input.toolsNeeded.map(String) : [String(input.toolsNeeded ?? "")];
        const category = input.category;
        if (category !== "frequency" && category !== "friction" && category !== "both") {
          return { content: `Error: category must be "frequency", "friction", or "both" (got ${JSON.stringify(category)})`, isError: true };
        }
        const pitchInput: WritePitchInput = {
          title: String(input.title ?? ""),
          problem: String(input.problem ?? ""),
          proposedAgent: String(input.proposedAgent ?? ""),
          toolsNeeded,
          costEstimate: String(input.costEstimate ?? ""),
          frequencyEstimate: String(input.frequencyEstimate ?? ""),
          category: category as PitchCategory,
          evidenceSummary: String(input.evidenceSummary ?? ""),
          evidenceSource: input.evidenceSource === "runtime" ? "runtime" : "build_activity",
        };
        if (!pitchInput.title.trim()) return { content: "Error: title is required", isError: true };
        const result = await writePitch(pitchInput);
        logger.info({ pitchId: result.pitchId, wasNew: result.wasNew, occurrenceCount: result.occurrenceCount }, "scout_pitch_written");
        return {
          content: toModelText({ status: result.wasNew ? "created" : "reinforced", pitchId: result.pitchId, occurrenceCount: result.occurrenceCount, score: result.score }),
          isError: false,
        };
      }
      case "compile_digest": {
        const result = await compileDigest();
        return { content: toModelText({ digestDate: result.digestDate, pitchCount: result.pitchCount, filePath: result.filePath }), isError: false };
      }
      default:
        return { content: `Unknown tool: ${name}`, isError: true };
    }
  } catch (err) {
    logger.warn({ tool: name, err: String(err) }, "scout_tool_failed");
    return { content: `Error running ${name}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}
