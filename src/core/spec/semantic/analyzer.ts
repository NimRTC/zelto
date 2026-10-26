// Semantic spec analysis — content completeness and consistency checks
// NOTE: Per C7, semantic analysis NEVER makes decisions. It only produces
// suggestions, drafts, or analysis reports for human review.

import type { SliceData } from '../../slice/store.js';
import type { SpecAnalysis, SpecIssue, SemanticCheck } from '../types.js';

function countSections(specContent: string): number {
  const matches = specContent.match(/^#{2,3}\s+.+$/gm);
  return matches?.length ?? 0;
}

function estimateCompleteness(specContent: string): number {
  // Heuristic: weight by content quality
  const lines = specContent.split('\n');
  if (lines.length === 0) return 0;

  const nonEmpty = lines.filter((l) => l.trim().length > 0).length;
  const headingLines = lines.filter((l) => /^#{2,3}\s+\S/.test(l)).length;
  const bulletLines = lines.filter((l) => /^\s*[-*]\s+\S/.test(l)).length;
  const codeLines = lines.filter((l) => /^\s{4}/.test(l) || /^```/.test(l)).length;

  // Check for placeholder markers
  const placeholderLines = lines.filter(
    (l) => /TBD|TODO|FIXME|XXX|\/\/\s+TODO|coming soon|not yet|to be determined/i.test(l),
  ).length;

  // Score: content volume + structure + detail
  const volumeScore = Math.min(1, nonEmpty / 40);
  const structureScore = Math.min(0.3, headingLines * 0.05);
  const detailScore = Math.min(0.3, (bulletLines + codeLines) * 0.03);
  const placeholderPenalty = Math.min(0.5, placeholderLines * 0.1);

  return Math.max(0, Math.min(1, volumeScore + structureScore + detailScore - placeholderPenalty));
}

function checkPlaceholders(slice: SliceData, specContent: string): SpecIssue | null {
  const placeholderMatches = specContent.match(
    /TBD|TODO|FIXME|coming soon|not yet determined|to be filled/i,
  );
  if (placeholderMatches) {
    return {
      severity: 'warning',
      category: 'semantic',
      message: 'Spec contains placeholder markers (TBD/TODO/FIXME)',
      suggestion: 'Replace placeholders with concrete content before freezing',
    };
  }
  return null;
}

function checkConsistencyBetweenSections(slice: SliceData, specContent: string): SpecIssue | null {
  // Check if Design section references terms not defined elsewhere
  const designMatch = specContent.match(/## Design\s*\n([\s\S]*?)(?=\n## |$)/);
  const apiMatch = specContent.match(/## API \/ Interface Changes\s*\n([\s\S]*?)(?=\n## |$)/);

  if (!designMatch || designMatch[1].trim().length === 0) {
    return {
      severity: 'warning',
      category: 'semantic',
      message: 'Design section is empty or missing',
      suggestion: 'Describe the design approach before implementation',
    };
  }

  // If there are API changes but no design, flag it
  if (apiMatch && apiMatch[1].trim().length > 0 && designMatch[1].trim().length < 20) {
    return {
      severity: 'warning',
      category: 'semantic',
      message: 'API changes defined but Design section is minimal',
      suggestion: 'Expand the Design section to explain the rationale behind API changes',
    };
  }

  return null;
}

function checkTestingStrategy(slice: SliceData, specContent: string): SpecIssue | null {
  const testMatch = specContent.match(/## Testing Strategy\s*\n([\s\S]*?)(?=\n## |$)/);
  if (testMatch) {
    const content = testMatch[1].trim();
    if (content.length < 20) {
      return {
        severity: 'warning',
        category: 'semantic',
        message: 'Testing Strategy section is too brief',
        suggestion: 'Include unit test, integration test, and acceptance test plans',
      };
    }
  }
  return null;
}

const SEMANTIC_CHECKS: SemanticCheck[] = [
  { name: 'placeholders', check: checkPlaceholders },
  { name: 'section-consistency', check: checkConsistencyBetweenSections },
  { name: 'testing-strategy', check: checkTestingStrategy },
];

export function analyzeSemantic(slice: SliceData, specContent: string): SpecAnalysis {
  const issues: SpecIssue[] = [];

  for (const sc of SEMANTIC_CHECKS) {
    const issue = sc.check(slice, specContent);
    if (issue) {
      issues.push(issue);
    }
  }

  const totalSections = countSections(specContent);
  const completeness = estimateCompleteness(specContent);
  const summary =
    completeness >= 0.8
      ? 'Spec appears complete'
      : completeness >= 0.5
        ? 'Spec is partially complete, review suggested'
        : 'Spec needs significant expansion';

  return {
    sliceId: slice.id,
    totalSections,
    completeness,
    issues,
    summary,
  };
}

export { SEMANTIC_CHECKS };
