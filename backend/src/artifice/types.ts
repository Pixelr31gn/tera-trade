/** Shared shapes for Artifice (see this directory's other files). */

export interface UntriagedBlueprint {
  blueprintId: number;
  pitchId: number;
  pitchTitle: string;
  pitchCategory: string;
  pitchRating: number | null;
  content: string;
}

export type ArtificeVerdictKind = "build" | "merge" | "low_priority" | "skip";

export interface WriteVerdictInput {
  blueprintId: number;
  verdict: ArtificeVerdictKind;
  mergeIntoBlueprintId?: number | null;
  reasoning: string;
}
