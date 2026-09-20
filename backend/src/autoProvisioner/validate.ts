/**
 * Runs the WHOLE project's `tsc --noEmit` after a scaffold is staged -- not a fabricated
 * standalone tsconfig for just the new files. Staging under backend/src/_provisioned/ (see
 * state.ts) means the scaffold sits in the real project tree at the same depth every other agent
 * directory does, so this actually typechecks its imports against real modules (../core/config.js,
 * ../db/client.js, etc.) instead of a check that can't see the rest of the repo. Blocking on
 * failure, not auto-fixing -- see systemPrompt.ts's header comment: this agent stages a draft for a
 * human to fix, it does not iterate on its own generated code.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BACKEND_ROOT } from "./state.js";
import type { ValidationResult } from "./types.js";

const execFileAsync = promisify(execFile);
const TSC_TIMEOUT_MS = 120_000;

export async function runTypeCheck(): Promise<ValidationResult> {
  try {
    const { stdout } = await execFileAsync("npx", ["tsc", "--noEmit", "-p", "tsconfig.json"], {
      cwd: BACKEND_ROOT,
      timeout: TSC_TIMEOUT_MS,
      shell: true,
    });
    return { ok: true, output: stdout.trim() || "tsc --noEmit passed with no output." };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output = [e.stdout, e.stderr].filter(Boolean).join("\n").trim() || e.message || String(err);
    return { ok: false, output };
  }
}
