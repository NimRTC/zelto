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
  /** 产生该问题的检查项名字（见 DETERMINISTIC_CHECKS / SEMANTIC_CHECKS）。
   *  调用方据此区分「阻断项」与「提示项」——同一份结果里，阻断与否是调用方的策略。 */
  check?: string;
}

export interface DeterministicCheck {
  name: string;
  check: (slice: SliceData, specContent: string) => SpecIssue[];
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

// ── AI Pipeline v2: Spec overlay & effective spec types ──────────────

export enum SpecOverlayType {
  Replace = 'replace',
  Merge = 'merge',
  Delete = 'delete',
}

export interface SpecOverlay {
  id: string;
  type: SpecOverlayType;
  path: string; // JSON path to apply the overlay at
  value?: unknown;
  description?: string;
  timestamp: string;
}

export interface EffectiveSpec {
  specId: string;
  specPath: string;
  content: SpecDocument;
  appliedOverlays: SpecOverlay[];
  timestamp: string;
}

// The shape of a parsed spec document (can be extended as needed)
export interface SpecDocument {
  [key: string]: unknown;
}
