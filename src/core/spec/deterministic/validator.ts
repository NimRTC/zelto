// Deterministic spec validation — hash matching, structural checks, invariants
// These checks are deterministic (C3): no model calls, no network, pure functions.

import { createHash } from 'node:crypto';
import type { SliceData } from '../../slice/store.js';
import type { SpecValidationResult, SpecIssue, DeterministicCheck } from '../types.js';

const EXPECTED_SECTIONS = [
  'Title',
  'Summary',
  'Motivation',
  'Design',
  'API / Interface Changes',
  'Data Model Changes',
  'Migration Plan',
  'Testing Strategy',
  'Acceptance Criteria',
];

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
  const missing: string[] = [];

  for (const section of EXPECTED_SECTIONS) {
    // Match markdown headings: ## Section Name or ### Section Name
    const escaped = section.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
    const pattern = new RegExp(`^#{1,6}\\s+${escaped}\\s*$`, 'm');
    if (!pattern.test(specContent)) {
      missing.push(section);
    }
  }

  if (missing.length > 0) {
    return {
      severity: missing.length > 3 ? 'error' : 'warning',
      category: 'structure',
      message: `Missing ${missing.length} recommended section(s): ${missing.join(', ')}`,
      suggestion: missing.length <= 3 ? 'Consider adding the missing sections' : 'Add essential sections before freezing',
    };
  }

  return null;
}

function checkAcceptanceCriteriaNotEmpty(slice: SliceData, specContent: string): SpecIssue | null {
  // Check if Acceptance Criteria section has content (not just empty after heading)
  const acMatch = specContent.match(/## Acceptance Criteria\s*\n([\s\S]*?)(?=\n## |$)/);
  if (acMatch) {
    const content = acMatch[1].trim();
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

  // No AC section at all — already caught by checkRequiredSections
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
      issues.push(issue);
    }
  }

  return { valid: issues.filter((i) => i.severity === 'error').length === 0, issues };
}

export { DETERMINISTIC_CHECKS, EXPECTED_SECTIONS };
