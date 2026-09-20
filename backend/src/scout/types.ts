/** Shared shapes for Scout (see this directory's other files). */

export type PitchCategory = "frequency" | "friction" | "both";

export interface EvidenceLogEntry {
  at: string; // ISO timestamp
  source: "build_activity" | "runtime";
  summary: string;
}

export interface WritePitchInput {
  title: string;
  problem: string;
  proposedAgent: string;
  toolsNeeded: string[];
  costEstimate: string;
  frequencyEstimate: string;
  category: PitchCategory;
  evidenceSummary: string;
  evidenceSource: "build_activity" | "runtime";
}

export interface FileTouchSummary {
  path: string;
  count: number;
  lastTouchedAt: string;
}

export interface RepeatedCommandSummary {
  command: string;
  count: number;
}

export interface RepeatedErrorSummary {
  tool: string;
  input: string;
  errorSnippet: string;
  count: number;
  lastSeenAt: string;
}

export interface BuildActivitySnapshot {
  windowHours: number;
  claudeSessionFilesScanned: number;
  fileTouches: FileTouchSummary[];
  repeatedCommands: RepeatedCommandSummary[];
  repeatedErrors: RepeatedErrorSummary[];
  userPromptSampleCount: number;
  notes: string[];
}
