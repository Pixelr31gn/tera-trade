/** Taylor's on-disk output -- rendered blueprint markdown, for reading without a DB client. Shares the same .scout-state/ tree Scout already writes digests to (both are the local Scout->Taylor pitch pipeline's own runtime output; see .gitignore) rather than a separate top-level dir. */
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** backend/src/taylor -> repo root is three levels up. */
export const BACKEND_ROOT = path.resolve(__dirname, "../..");
export const BLUEPRINT_DIR = path.join(BACKEND_ROOT, ".scout-state", "blueprints");

export function ensureBlueprintDir(): void {
  if (!existsSync(BLUEPRINT_DIR)) mkdirSync(BLUEPRINT_DIR, { recursive: true });
}
