// Spec types — slice specification validation

import type { SliceData } from '../slice/store.js';

export interface SpecValidationResult {
  valid: boolean;
  issues: SpecIssue[];
}

export interface SpecIssue {
  severity: 'error' | 'warning' | 'info';
  category: 'structure' | 'content' | 'trace' | 'hash' | 'semantic';
  message: string;
  path?: string;
  suggestion?: string;
}

export interface DeterministicCheck {
  name: string;
  check: (slice: SliceData, specContent: string) => SpecIssue | null;
}

export interface SemanticCheck {
  name: string;
  check: (slice: SliceData, specContent: string) => SpecIssue | null;
}

export interface SpecAnalysis {
  sliceId: string;
  totalSections: number;
  completeness: number; // 0-1 ratio
  issues: SpecIssue[];
  summary: string;
}
