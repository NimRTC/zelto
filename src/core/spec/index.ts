// Spec engine — slice specification validation and analysis

export { validateDeterministic, DETERMINISTIC_CHECKS, EXPECTED_SECTIONS } from './deterministic/validator.js';
export { analyzeSemantic, SEMANTIC_CHECKS } from './semantic/analyzer.js';
export type { SpecValidationResult, SpecIssue, SpecAnalysis, DeterministicCheck, SemanticCheck } from './types.js';
