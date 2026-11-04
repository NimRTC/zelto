// Semantic spec analysis — content completeness and consistency checks
// NOTE: Per C7, semantic analysis NEVER makes decisions. It only produces
// suggestions, drafts, or analysis reports for human review.

import type { SliceData } from '../../slice/store.js';
import type { SpecAnalysis, SpecIssue, SemanticCheck } from '../types.js';
import { extractSection, sectionByConcept } from '../format.js';

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
  // 「设计 / Design」章节：写了但是空的 = warning；压根没写 = info
  //
  // 区别对待是因为 zelto 自己生成的规格模板（cli/commands/shared.ts 的
  // generateSliceSpecContent）就不含「设计」这一节——把它当必备会变成
  // 「每份规格都报缺章节」的噪声。有这一节却写空了才是真问题。
  const design = sectionByConcept('Design');
  if (!design) return null;
  const designBody = extractSection(specContent, design);

  if (designBody === null) {
    return {
      severity: 'info',
      category: 'semantic',
      message: 'Design section is missing',
      suggestion: 'Describe the design approach so the implementation stays traceable',
    };
  }

  if (designBody.length === 0) {
    return {
      severity: 'warning',
      category: 'semantic',
      message: 'Design section is empty',
      suggestion: 'Describe the design approach before implementation',
    };
  }

  // 有 API 变更章节但设计章节很短 → 提示补设计
  const api = sectionByConcept('API / Interface Changes');
  const apiBody = api ? extractSection(specContent, api) : null;
  if (apiBody !== null && apiBody.length > 0 && designBody.length < 20) {
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
  const testing = sectionByConcept('Testing Strategy');
  if (!testing) return null;

  const content = extractSection(specContent, testing);
  if (content !== null && content.length < 20) {
    return {
      severity: 'warning',
      category: 'semantic',
      message: 'Testing Strategy section is too brief',
      suggestion: 'Include unit test, integration test, and acceptance test plans',
    };
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
      issues.push({ ...issue, check: sc.name });
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
