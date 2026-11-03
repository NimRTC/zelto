// Spec lint — types and stub for spec linting
//
// C3: deterministic, no model calls, no network
// C6: core/ only — no adapters/ imports

import type { SpecDocument } from './types.js';

export enum SpecLintSeverity {
  Error = 'error',
  Warning = 'warning',
  Info = 'info',
}

export interface SpecLintIssue {
  severity: SpecLintSeverity;
  message: string;
  path?: string; // JSON path to the relevant part of the spec
  rule?: string; // rule identifier
  suggestion?: string;
}

export interface SpecLintResult {
  specId: string;
  specPath: string;
  passed: boolean;
  issues: SpecLintIssue[];
  timestamp: string;
  metadata?: Record<string, unknown>;
}

/**
 * Lint a spec document.
 *
 * Currently a stub — always returns `passed: true` with no issues.
 * Real linting rules will be added in future iterations.
 *
 * @param spec - The spec document to lint
 * @returns A SpecLintResult indicating pass/fail and any issues found
 */
export function lintSpec(spec: SpecDocument): SpecLintResult {
  return {
    specId: (spec as Record<string, unknown>).id as string ?? '',
    specPath: (spec as Record<string, unknown>).path as string ?? '',
    passed: true,
    issues: [],
    timestamp: new Date().toISOString(),
    metadata: {
      ruleCount: 0,
      note: 'Stub implementation — no rules applied',
    },
  };
}
