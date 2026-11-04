// Spec engine — slice specification validation and analysis

export { validateDeterministic, DETERMINISTIC_CHECKS, EXPECTED_SECTIONS } from './deterministic/validator.js';
export { analyzeSemantic, SEMANTIC_CHECKS } from './semantic/analyzer.js';
export { parseScopePaths, parseAcceptanceCriteria, parsePrerequisites } from './scope.js';
export {
  SPEC_SECTIONS, REQUIRED_SECTIONS, sectionByConcept, headingMatches,
  extractSection, missingRequiredSections,
} from './format.js';
export type { SectionSpec } from './format.js';
export { getEffectiveSpec } from './merge.js';
export { SpecOverlayType } from './types.js';
export type {
  SpecValidationResult, SpecIssue, SpecAnalysis, DeterministicCheck, SemanticCheck,
  SpecOverlay, EffectiveSpec, SpecDocument,
} from './types.js';
