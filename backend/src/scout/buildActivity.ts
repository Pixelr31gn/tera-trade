/**
 * scan_recent_activity -- Scout's build-activity source (signal #1: VS Code + Claude Code activity
 * on this repo). Three sub-sources, all read-only:
 *
 * 1. A repo-tree file watcher (Node's own fs.watch, recursive -- no new dependency) over a
 *    curated set of directories (SCOUT_WATCH_PATHS), catching every save regardless of what wrote
 *    it (VS Code, another editor, a script). Kept as an in-memory ring buffer, not persisted --
 *    this is the one source that's genuinely real-time, so a restart losing it is fine, the next
 *    save repopulates it.
 * 2. Claude Code's own session transcripts (~/.claude/projects/<encoded-repo-path>/*.jsonl) --
 *    tailed incrementally (see state.ts) for tool_use/tool_result pairs, which gives file touches
 *    AGENT-side (Read/Edit/Write calls), repeated shell commands (Bash tool_use), and repeated
 *    tool errors (tool_result.is_error) -- the richest source for "friction," since a repeated
 *    error is a direct, unambiguous signal of something tedious/costly recurring.
 * 3. Shell history (PowerShell's PSReadLine file, bash's .bash_history if present) -- tailed the
 *    same incremental way, for repeated commands run OUTSIDE Claude Code too.
 *
 * (2) and (3) are incremental: each scan reports what's been appended since the LAST scan (an
 * offset persisted in .scout-state/), not a strict "last N hours" replay -- correlating a JSONL
 * byte range to a time window isn't reliable (message sizes vary hugely), and Scout's own tick
 * cadence (SCOUT_TICK_MINUTES) already keeps "since last scan" close to "recent" in practice. Only
 * (1)'s ring buffer is filtered by a real lookbackHours window, since it already carries real
 * timestamps per event.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { FSWatcher, watch } from "node:fs";
import { getSettings } from "../core/config.js";
import { childLogger } from "../core/logger.js";
import { REPO_ROOT, readJsonState, writeJsonState } from "./state.js";
import type { BuildActivitySnapshot, FileTouchSummary, RepeatedCommandSummary, RepeatedErrorSummary } from "./types.js";

const logger = childLogger("scoutBuildActivity");

// ---------------------------------------------------------------------------
// 1. Repo file watcher -- in-memory ring buffer, no persistence needed.
// ---------------------------------------------------------------------------

const IGNORED_PATH_SEGMENTS = new Set(["node_modules", ".git", "dist", ".next", "out", ".turbo", "coverage", ".scout-state"]);
const RING_BUFFER_MAX = 5000;

interface WatchEvent {
  path: string; // repo-root-relative, forward slashes
  at: number; // epoch ms
}

const ringBuffer: WatchEvent[] = [];
let watchers: FSWatcher[] = [];

function toRepoRelative(absPath: string): string {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join("/");
}

function isIgnored(relPath: string): boolean {
  return relPath.split("/").some((segment) => IGNORED_PATH_SEGMENTS.has(segment));
}

function recordWatchEvent(absPath: string): void {
  const relPath = toRepoRelative(absPath);
  if (isIgnored(relPath)) return;
  ringBuffer.push({ path: relPath, at: Date.now() });
  if (ringBuffer.length > RING_BUFFER_MAX) ringBuffer.splice(0, ringBuffer.length - RING_BUFFER_MAX);
}

/** Starts fs.watch on every configured, existing watch path. Call once at Scout process boot. Returns a stop function. */
export function startFileWatchers(): () => void {
  const settings = getSettings();
  for (const relDir of settings.scoutWatchPaths) {
    const absDir = path.join(REPO_ROOT, relDir);
    if (!existsSync(absDir)) continue;
    try {
      const watcher = watch(absDir, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        recordWatchEvent(path.join(absDir, filename.toString()));
      });
      watcher.on("error", (err) => logger.warn({ dir: relDir, err: String(err) }, "scout_file_watch_error"));
      watchers.push(watcher);
      logger.info({ dir: relDir }, "scout_file_watch_started");
    } catch (err) {
      logger.warn({ dir: relDir, err: String(err) }, "scout_file_watch_start_failed");
    }
  }
  return () => {
    for (const w of watchers) w.close();
    watchers = [];
  };
}

function fileTouchesFromRingBuffer(sinceMs: number): FileTouchSummary[] {
  const byPath = new Map<string, FileTouchSummary>();
  for (const evt of ringBuffer) {
    if (evt.at < sinceMs) continue;
    const existing = byPath.get(evt.path);
    if (existing) {
      existing.count++;
      if (evt.at > new Date(existing.lastTouchedAt).getTime()) existing.lastTouchedAt = new Date(evt.at).toISOString();
    } else {
      byPath.set(evt.path, { path: evt.path, count: 1, lastTouchedAt: new Date(evt.at).toISOString() });
    }
  }
  return [...byPath.values()];
}

// ---------------------------------------------------------------------------
// Generic incremental text-file tailer, shared by the Claude Code and shell-history sources.
// ---------------------------------------------------------------------------

interface TailOffsets {
  [absPath: string]: number;
}

const OFFSETS_FILE = "tail-offsets.json";
// Bootstrapping a fresh install shouldn't read a multi-hundred-MB session file from byte 0 --
// this bounds the FIRST read of any never-before-seen file to its own tail, not the full history.
const INITIAL_TAIL_BYTES = 512 * 1024;

/** Reads whatever's been appended to `filePath` since its last recorded offset (or the last INITIAL_TAIL_BYTES on first sight), returns complete lines only, and advances the offset up to the last complete newline -- a trailing partial line is left for the next tick, never dropped. */
async function tailNewLines(filePath: string, offsets: TailOffsets): Promise<string[]> {
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    return [];
  }

  let offset = offsets[filePath] ?? Math.max(0, size - INITIAL_TAIL_BYTES);
  if (offset > size) offset = 0; // file was truncated/rotated
  if (offset >= size) return [];

  const handle = await open(filePath, "r");
  try {
    const length = size - offset;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, offset);
    const lastNewline = buffer.lastIndexOf(0x0a); // '\n'
    if (lastNewline === -1) return []; // no complete line yet -- wait for more
    const consumed = buffer.subarray(0, lastNewline);
    offsets[filePath] = offset + lastNewline + 1;
    return consumed
      .toString("utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// 2. Claude Code session transcripts.
// ---------------------------------------------------------------------------

/** Replicates Claude Code's own project-directory naming: the repo's absolute path with ":" and path separators collapsed to "-". Both a lowercase- and uppercase-drive-letter variant are tried (observed both on disk -- which shell launched Claude Code affects casing), preferring whichever actually exists. */
export function deriveClaudeProjectDir(repoRoot: string): string | null {
  const claudeProjectsDir = path.join(os.homedir(), ".claude", "projects");
  const encode = (p: string) => p.replace(/[:\\/]/g, "-");
  const candidates = [encode(repoRoot), encode(repoRoot.charAt(0).toLowerCase() + repoRoot.slice(1)), encode(repoRoot.charAt(0).toUpperCase() + repoRoot.slice(1))];
  for (const candidate of new Set(candidates)) {
    const full = path.join(claudeProjectsDir, candidate);
    if (existsSync(full)) return full;
  }
  return null;
}

interface ClaudeToolUseRecord {
  name: string;
  inputSummary: string;
}

const BASH_LIKE_TOOLS = new Set(["Bash"]);
const FILE_TOOLS = new Set(["Read", "Edit", "Write", "NotebookEdit"]);

function summarizeToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  if (BASH_LIKE_TOOLS.has(name) && typeof obj.command === "string") return obj.command.trim().replace(/\s+/g, " ").slice(0, 200);
  if (FILE_TOOLS.has(name) && typeof obj.file_path === "string") return obj.file_path;
  if (typeof obj.pattern === "string") return obj.pattern;
  return JSON.stringify(obj).slice(0, 200);
}

/** Parses new lines from every *.jsonl transcript directly in the Claude Code project directory (not the per-session sidecar subdirectories, which hold snapshots/artifacts rather than the message stream), extracting Bash commands, file touches, and tool errors. Best-effort throughout -- a malformed or unexpected line is skipped, never thrown. */
async function scanClaudeSessions(offsets: TailOffsets): Promise<{
  filesScanned: number;
  commands: Map<string, number>;
  fileTouches: Map<string, { count: number; lastTouchedAt: string }>;
  errors: Map<string, { tool: string; input: string; errorSnippet: string; count: number; lastSeenAt: string }>;
  userPromptCount: number;
}> {
  const commands = new Map<string, number>();
  const fileTouches = new Map<string, { count: number; lastTouchedAt: string }>();
  const errors = new Map<string, { tool: string; input: string; errorSnippet: string; count: number; lastSeenAt: string }>();
  let userPromptCount = 0;
  let filesScanned = 0;

  const settings = getSettings();
  const projectDir = settings.scoutClaudeProjectDir ?? deriveClaudeProjectDir(REPO_ROOT);
  if (!projectDir || !existsSync(projectDir)) {
    logger.warn({ repoRoot: REPO_ROOT }, "scout_claude_project_dir_not_found -- set SCOUT_CLAUDE_PROJECT_DIR if this repo's session logs live somewhere else");
    return { filesScanned, commands, fileTouches, errors, userPromptCount };
  }

  let entries: string[];
  try {
    entries = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
  } catch (err) {
    logger.warn({ projectDir, err: String(err) }, "scout_claude_project_dir_read_failed");
    return { filesScanned, commands, fileTouches, errors, userPromptCount };
  }

  // Tracks the most recent tool_use per (id, or sequential fallback) within this scan pass, so a
  // later tool_result (is_error) can be attributed to what it was actually the result of.
  const pendingToolUseById = new Map<string, ClaudeToolUseRecord>();
  let lastToolUse: ClaudeToolUseRecord | null = null;

  for (const filename of entries) {
    const absPath = path.join(projectDir, filename);
    const lines = await tailNewLines(absPath, offsets);
    if (lines.length === 0) continue;
    filesScanned++;

    for (const line of lines) {
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (!obj || typeof obj !== "object") continue;
      const entry = obj as { type?: string; timestamp?: string; message?: { content?: unknown } };
      const content = entry.message?.content;
      const nowIso = entry.timestamp ?? new Date().toISOString();

      if (entry.type === "user" && typeof content === "string" && content.trim().length > 0) {
        userPromptCount++;
        continue;
      }
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;

        if (b.type === "text" && entry.type === "user" && typeof b.text === "string" && b.text.trim().length > 0) {
          userPromptCount++;
        }

        if (b.type === "tool_use" && typeof b.name === "string") {
          const record: ClaudeToolUseRecord = { name: b.name, inputSummary: summarizeToolInput(b.name, b.input) };
          if (typeof b.id === "string") pendingToolUseById.set(b.id, record);
          lastToolUse = record;

          if (BASH_LIKE_TOOLS.has(b.name) && record.inputSummary) {
            commands.set(record.inputSummary, (commands.get(record.inputSummary) ?? 0) + 1);
          }
          if (FILE_TOOLS.has(b.name) && record.inputSummary) {
            const relPath = record.inputSummary.startsWith(REPO_ROOT) ? toRepoRelative(record.inputSummary) : record.inputSummary;
            const existing = fileTouches.get(relPath);
            if (existing) {
              existing.count++;
              existing.lastTouchedAt = nowIso;
            } else {
              fileTouches.set(relPath, { count: 1, lastTouchedAt: nowIso });
            }
          }
        }

        if (b.type === "tool_result" && b.is_error === true) {
          const toolUseId = typeof b.tool_use_id === "string" ? b.tool_use_id : undefined;
          const attributedTo = (toolUseId && pendingToolUseById.get(toolUseId)) || lastToolUse;
          const rawContent = Array.isArray(b.content) ? b.content.map((c) => (typeof c === "object" && c && "text" in c ? (c as { text?: string }).text : "")).join(" ") : b.content;
          const errorSnippet = String(rawContent ?? "").trim().slice(0, 200);
          const tool = attributedTo?.name ?? "unknown";
          const inputForKey = attributedTo?.inputSummary ?? "";
          const key = `${tool}|${inputForKey}`;
          const existing = errors.get(key);
          if (existing) {
            existing.count++;
            existing.lastSeenAt = nowIso;
          } else {
            errors.set(key, { tool, input: inputForKey, errorSnippet, count: 1, lastSeenAt: nowIso });
          }
        }
      }
    }
  }

  return { filesScanned, commands, fileTouches, errors, userPromptCount };
}

// ---------------------------------------------------------------------------
// 3. Shell history.
// ---------------------------------------------------------------------------

function shellHistoryPaths(): string[] {
  const home = os.homedir();
  const paths: string[] = [];
  const appData = process.env.APPDATA;
  if (appData) paths.push(path.join(appData, "Microsoft", "Windows", "PowerShell", "PSReadLine", "ConsoleHost_history.txt"));
  paths.push(path.join(home, ".bash_history"));
  return paths.filter((p) => existsSync(p));
}

async function scanShellHistory(offsets: TailOffsets): Promise<Map<string, number>> {
  const commands = new Map<string, number>();
  for (const filePath of shellHistoryPaths()) {
    const lines = await tailNewLines(filePath, offsets);
    for (const raw of lines) {
      const command = raw.trim().replace(/\s+/g, " ").slice(0, 200);
      if (!command || command.startsWith("#")) continue; // bash history timestamp comment lines
      commands.set(command, (commands.get(command) ?? 0) + 1);
    }
  }
  return commands;
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

export async function scanRecentActivity(lookbackHours = 24): Promise<BuildActivitySnapshot> {
  const offsets = readJsonState<TailOffsets>(OFFSETS_FILE, {});
  const notes: string[] = [];

  const claudeResult = await scanClaudeSessions(offsets);
  if (claudeResult.filesScanned === 0) notes.push("No new Claude Code session content since the last scan (or the project's session directory wasn't found -- see logs).");

  const shellCommands = await scanShellHistory(offsets);
  writeJsonState(OFFSETS_FILE, offsets);

  const sinceMs = Date.now() - lookbackHours * 60 * 60 * 1000;
  const ringBufferTouches = fileTouchesFromRingBuffer(sinceMs);

  // Merge ring-buffer (human/editor-driven) and Claude Code (agent-driven) file touches into one
  // count per path -- both answer the same question ("what keeps getting touched").
  const mergedTouches = new Map<string, FileTouchSummary>();
  for (const t of ringBufferTouches) mergedTouches.set(t.path, { ...t });
  for (const [relPath, v] of claudeResult.fileTouches) {
    const existing = mergedTouches.get(relPath);
    if (existing) {
      existing.count += v.count;
      if (v.lastTouchedAt > existing.lastTouchedAt) existing.lastTouchedAt = v.lastTouchedAt;
    } else {
      mergedTouches.set(relPath, { path: relPath, count: v.count, lastTouchedAt: v.lastTouchedAt });
    }
  }

  const mergedCommands = new Map<string, number>(claudeResult.commands);
  for (const [cmd, count] of shellCommands) mergedCommands.set(cmd, (mergedCommands.get(cmd) ?? 0) + count);

  const fileTouches: FileTouchSummary[] = [...mergedTouches.values()].sort((a, b) => b.count - a.count).slice(0, 30);
  const repeatedCommands: RepeatedCommandSummary[] = [...mergedCommands.entries()]
    .map(([command, count]) => ({ command, count }))
    .filter((c) => c.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 30);
  const repeatedErrors: RepeatedErrorSummary[] = [...claudeResult.errors.values()]
    .map((e) => ({ tool: e.tool, input: e.input, errorSnippet: e.errorSnippet, count: e.count, lastSeenAt: e.lastSeenAt }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 30);

  return {
    windowHours: lookbackHours,
    claudeSessionFilesScanned: claudeResult.filesScanned,
    fileTouches,
    repeatedCommands,
    repeatedErrors,
    userPromptSampleCount: claudeResult.userPromptCount,
    notes,
  };
}
