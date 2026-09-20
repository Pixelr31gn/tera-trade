/**
 * Auto-Provisioner's on-disk output -- staged scaffold directories, one per blueprint.
 *
 * Deliberately staged INSIDE backend/src/ (as backend/src/_provisioned/<id>-<slug>/), NOT under
 * .scout-state/ like Scout/Taylor's own output -- a scaffolded agent's relative imports (e.g.
 * `../core/config.js`, `../db/client.js`) are written assuming it lives one level under src/, same
 * as every real agent directory (scout/, taylor/, crossRegimeAnalyzer/). Staging at that same depth
 * means those imports actually resolve, so `tsc --noEmit` on the whole project genuinely
 * typechecks the generated code against real modules instead of a fabricated standalone tsconfig
 * that can't see the rest of the repo. src/_provisioned/ is gitignored (see backend/.gitignore)
 * and never imported from any real entry point, so nothing here runs or ships until a human
 * deliberately promotes it out of this directory.
 */
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** backend/src/autoProvisioner -> backend/src is one level up, backend/ two. */
export const SRC_ROOT = path.resolve(__dirname, "..");
export const BACKEND_ROOT = path.resolve(__dirname, "../..");
export const PROVISIONER_DIR = path.join(SRC_ROOT, "_provisioned");

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Repo-relative (from backend/) staging directory for one blueprint -- stable across reruns so a re-provisioned blueprint overwrites its own prior scaffold instead of piling up duplicates. */
export function stagingDirFor(blueprintId: number, pitchTitle: string): { absolute: string; repoRelative: string } {
  const dirName = `${blueprintId}-${slugify(pitchTitle)}`;
  const absolute = path.join(PROVISIONER_DIR, dirName);
  return { absolute, repoRelative: path.join("backend", "src", "_provisioned", dirName) };
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
