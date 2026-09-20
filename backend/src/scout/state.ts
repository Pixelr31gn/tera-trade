/**
 * Small on-disk state for Scout's watchers -- byte offsets into tailed files (Claude Code session
 * logs, shell history) so a restart resumes from where it left off instead of either re-reading
 * multi-hundred-MB session files from scratch or silently losing everything appended since the
 * last run. Lives under backend/.scout-state/ (git-ignored, see .gitignore) -- purely local
 * runtime state, not something any other part of the app reads.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** backend/src/scout -> repo root is three levels up. */
export const REPO_ROOT = path.resolve(__dirname, "../../..");
export const BACKEND_ROOT = path.resolve(__dirname, "../..");
export const SCOUT_STATE_DIR = path.join(BACKEND_ROOT, ".scout-state");
export const SCOUT_DIGEST_DIR = path.join(SCOUT_STATE_DIR, "digests");

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function readJsonState<T>(filename: string, fallback: T): T {
  ensureDir(SCOUT_STATE_DIR);
  const filePath = path.join(SCOUT_STATE_DIR, filename);
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonState<T>(filename: string, value: T): void {
  ensureDir(SCOUT_STATE_DIR);
  writeFileSync(path.join(SCOUT_STATE_DIR, filename), JSON.stringify(value, null, 2), "utf8");
}

export function ensureDigestDir(): void {
  ensureDir(SCOUT_DIGEST_DIR);
}
