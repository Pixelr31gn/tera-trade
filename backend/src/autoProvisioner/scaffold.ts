/**
 * write_scaffold_files -- the only tool that writes anything. Always writes under this
 * blueprint's own staging directory (.scout-state/provisioner/<id>-<slug>/), NEVER into backend/src
 * or anywhere else live -- see systemPrompt.ts's header comment for why this repo's Auto-Provisioner
 * stages instead of committing. Every path the model provides is resolved against the staging dir
 * and rejected if it would escape it (defense in depth against a malformed/adversarial ".." path --
 * this is generated code from a local model, not user input, but writing files from any LLM output
 * without a containment check is the wrong default regardless of how trusted the source feels).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureDir, stagingDirFor } from "./state.js";
import type { ScaffoldFileSpec } from "./types.js";

export interface WriteScaffoldResult {
  stagingDirAbsolute: string;
  stagingDirRepoRelative: string;
  filesWritten: string[];
}

export function writeScaffoldFiles(blueprintId: number, pitchTitle: string, files: ScaffoldFileSpec[]): WriteScaffoldResult {
  const { absolute: stagingDirAbsolute, repoRelative: stagingDirRepoRelative } = stagingDirFor(blueprintId, pitchTitle);
  ensureDir(stagingDirAbsolute);

  const filesWritten: string[] = [];
  for (const file of files) {
    const normalized = path.normalize(file.path).replace(/^([/\\])+/, "");
    const resolved = path.resolve(stagingDirAbsolute, normalized);
    if (!resolved.startsWith(stagingDirAbsolute + path.sep) && resolved !== stagingDirAbsolute) {
      throw new Error(`Refusing to write outside the staging directory: ${file.path}`);
    }
    mkdirSync(path.dirname(resolved), { recursive: true });
    writeFileSync(resolved, file.content, "utf8");
    filesWritten.push(normalized);
  }

  return { stagingDirAbsolute, stagingDirRepoRelative, filesWritten };
}
