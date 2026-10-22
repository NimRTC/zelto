// RequirementDoc types

export type RequirementStatus = 'draft' | 'confirmed' | 'superseded';

export interface RequirementDoc {
  id: string;
  title: string;
  /** User's original natural language input */
  userInput: string;
  /** AI-generated full specification (Markdown) */
  spec: string;
  status: RequirementStatus;
  /** Previous version if this is a revision */
  supersedes: string | null;
  acceptanceCriteria: string[];
  createdAt: string;
  confirmedAt: string | null;
}

export interface RequirementSummary {
  id: string;
  title: string;
  status: RequirementStatus;
  createdAt: string;
}
