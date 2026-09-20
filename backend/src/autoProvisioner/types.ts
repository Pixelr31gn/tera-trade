/** Shared shapes for the Auto-Provisioner (see this directory's other files). */

export interface PendingBlueprintSummary {
  blueprintId: number;
  pitchId: number;
  pitchTitle: string;
  content: string; // Taylor's rendered blueprint markdown -- overview/architecture/tools/steps/open questions
}

export interface ScaffoldFileSpec {
  path: string; // relative to the blueprint's own staging directory, e.g. "src/index.ts"
  content: string;
}

export interface WriteScaffoldInput {
  blueprintId: number;
  files: ScaffoldFileSpec[];
  notes: string; // model's own summary of what it built and any assumptions it made
}

export type ProvisioningStatus = "pending" | "staged" | "lint_failed" | "error";

export interface ValidationResult {
  ok: boolean;
  output: string;
}
