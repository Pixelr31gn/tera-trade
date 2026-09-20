/** Shared shapes for Taylor (see this directory's other files). */

export interface ApprovedPitchSummary {
  pitchId: number;
  title: string;
  problem: string;
  proposedAgent: string;
  toolsNeeded: string[];
  costEstimate: string;
  frequencyEstimate: string;
  category: string;
  rating: number;
  occurrenceCount: number;
  evidenceLog: { at: string; source: string; summary: string }[];
}

export interface ToolDefinitionSpec {
  name: string;
  description: string;
}

export interface WriteBlueprintInput {
  pitchId: number;
  overview: string;
  architecture: string;
  dataModelChanges: string;
  toolDefinitions: ToolDefinitionSpec[];
  implementationSteps: string[];
  openQuestions: string[];
}
