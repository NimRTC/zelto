// Deterministic spec validation — hash matching, structural checks, invariants
// These checks are deterministic (C3): no model calls, no network, pure functions.

import { createHash } from 'node:crypto';
import type { SliceData } from '../../slice/store.js';
import type { SpecValidationResult, SpecIssue, DeterministicCheck } from '../types.js';
import {
  REQUIRED_SECTIONS as EXPECTED_SECTIONS,
  extractSection,
  missingRequiredSections,
  sectionByConcept,
} from '../format.js';

function checkFrozenHash(slice: SliceData, specContent: string): SpecIssue | null {
  if (!slice.spec.frozenHash) return null;

  const expectedHash = slice.spec.frozenHash.replace('sha256:', '');
  const actualHash = createHash('sha256').update(specContent, 'utf-8').digest('hex');

  if (expectedHash !== actualHash) {
    return {
      severity: 'error',
      category: 'hash',
      message: `Spec content hash mismatch: expected ${expectedHash.slice(0, 12)}..., got ${actualHash.slice(0, 12)}...`,
      suggestion: 'Re-freeze the spec or revert spec changes',
    };
  }

  return null;
}

function checkRequiredSections(slice: SliceData, specContent: string): SpecIssue | null {
  const missing = missingRequiredSections(specContent);

  if (missing.length > 0) {
    return {
      severity: 'warning',
      category: 'structure',
      message: `Missing ${missing.length} required section(s): ${missing.join(', ')}`,
      suggestion: `Add the missing section(s): ${missing.join(', ')}`,
    };
  }

  return null;
}

function checkAcceptanceCriteriaNotEmpty(slice: SliceData, specContent: string): SpecIssue | null {
  // 「验收标准 / Acceptance Criteria」章节存在但没有内容 = error
  const ac = sectionByConcept('Acceptance Criteria');
  if (!ac) return null;

  const content = extractSection(specContent, ac);
  if (content === null) {
    // 章节不存在 —— 已由 checkRequiredSections 报出
    return null;
  }

  if (!content || content === '-' || content.startsWith('<!--')) {
    return {
      severity: 'error',
      category: 'content',
      message: 'Acceptance Criteria section is empty',
      suggestion: 'Define at least one acceptance criterion',
    };
  }

  return null;
}

function checkTraceConsistency(slice: SliceData, _specContent: string): SpecIssue | null {
  if (slice.trace.requirements.length === 0 && !slice.traceWaiver) {
    return {
      severity: 'warning',
      category: 'trace',
      message: 'No requirements traced to this slice',
      suggestion: 'Add requirement IDs to slice.trace.requirements or set traceWaiver',
    };
  }

  return null;
}

function checkSpecFileExists(slice: SliceData, _specContent: string): SpecIssue | null {
  if (!slice.spec.path) {
    return {
      severity: 'error',
      category: 'structure',
      message: 'Spec path is not set',
      suggestion: 'Run zelto freeze to set the spec path',
    };
  }

  return null;
}

const DETERMINISTIC_CHECKS: DeterministicCheck[] = [
  { name: 'frozen-hash', check: checkFrozenHash },
  { name: 'required-sections', check: checkRequiredSections },
  { name: 'acceptance-criteria', check: checkAcceptanceCriteriaNotEmpty },
  { name: 'trace-consistency', check: checkTraceConsistency },
  { name: 'spec-file-exists', check: checkSpecFileExists },
];

export function validateDeterministic(slice: SliceData, specContent: string): SpecValidationResult {
  const issues: SpecIssue[] = [];

  for (const dc of DETERMINISTIC_CHECKS) {
    const issue = dc.check(slice, specContent);
    if (issue) {
      issues.push({ ...issue, check: dc.name });
    }
  }

  return { valid: issues.filter((i) => i.severity === 'error').length === 0, issues };
}

export { DETERMINISTIC_CHECKS, EXPECTED_SECTIONS };
