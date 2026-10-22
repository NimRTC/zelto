// DesignDoc types

export type DesignStatus = 'draft' | 'confirmed' | 'superseded';

export interface DesignModule {
  name: string;
  description: string;
  /** File globs this module is expected to touch */
  filePatterns: string[];
  /** Other modules this module depends on */
  dependencies: string[];
}

export interface DesignDoc {
  id: string;
  requirementId: string;
  title: string;
  /** AI-generated design body (Markdown) */
  body: string;
  modules: DesignModule[];
  status: DesignStatus;
  supersedes: string | null;
  createdAt: string;
  confirmedAt: string | null;
}

export interface DesignSummary {
  id: string;
  title: string;
  requirementId: string;
  status: DesignStatus;
  moduleCount: number;
  createdAt: string;
}
