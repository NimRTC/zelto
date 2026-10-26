export { evaluatePolicy, matchPath, isProtectedPath, hashPolicy, checkAnchor } from './engine.js';
export type { PolicyConfig, PolicyRule, PolicyDecision, Decision, Anchor } from './types.js';
export {
  validatePolicyConfig,
  validateRule,
  validateMatch,
  validatePolicyYaml,
  validateRuleResult,
  isValidGlobPattern,
  isValidAction,
  isValidOperation,
} from './validator.js';
export type { ValidationError, ValidationResult } from './validator.js';
