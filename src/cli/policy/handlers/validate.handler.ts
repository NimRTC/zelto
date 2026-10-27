/**
 * validate.handler.ts — `zelto policy validate` business logic
 *
 * Validates the current policy configuration by:
 * 1. Loading policy from policy.yaml
 * 2. Running core structural validation (rules, fields, types)
 * 3. Running CLI-level checks (duplicate IDs, anchor references)
 *
 * C6: cli/policy/ may depend on adapters/ and core/, but not vice versa.
 */

import { loadPolicyConfig } from '../../commands/shared.js';
import { validatePolicyConfig as validateCore } from '../../../core/policy/validator.js';
import type { PolicyRule } from '../../../core/policy/types.js';
import type { ValidationResult, ValidationError } from '../output-formatter.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ValidateOptions {
  /** Path to policy.yaml (defaults to policy/policy.yaml) */
  policyPath?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate the current policy configuration.
 *
 * Delegates to the core validator for structural checks (required fields,
 * valid actions, match objects, etc.), then adds CLI-level checks like
 * duplicate ID detection, anchor reference validation, overlap detection,
 * and unreachable rule detection.
 */
export function validatePolicy(_options?: ValidateOptions): ValidationResult {
  const errors: ValidationError[] = [];

  // 1. Load policy config
  let config: ReturnType<typeof loadPolicyConfig>;
  try {
    config = loadPolicyConfig();
  } catch {
    return {
      valid: false,
      errors: [{ message: 'Failed to load policy configuration', code: 'LOAD_ERROR' }],
    };
  }

  // 2. Core structural validation
  const coreResult = validateCore(config);
  for (const err of coreResult.errors) {
    errors.push({
      message: err.message,
      code: err.code,
      path: err.path || undefined,
    });
  }

  // 3. CLI-level checks
  errors.push(...checkDuplicateIds(config.rules));
  errors.push(...checkBasisAnchorReferences(config.rules));
  errors.push(...checkOverlappingRules(config.rules));
  errors.push(...checkUnreachableRules(config.rules));
  errors.push(...checkConflictingPriorities(config.rules));

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ---------------------------------------------------------------------------
// CLI-level validation helpers
// ---------------------------------------------------------------------------

/**
 * Check for duplicate rule IDs across the ruleset.
 */
function checkDuplicateIds(rules: PolicyRule[]): ValidationError[] {
  const errors: ValidationError[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < rules.length; i++) {
    const id = rules[i].id;
    if (id && seenIds.has(id)) {
      errors.push({
        message: `Duplicate rule ID: "${id}"`,
        code: 'DUPLICATE_ID',
        path: `rules[${i}].id`,
      });
    }
    if (id) {
      seenIds.add(id);
    }
  }

  return errors;
}

/**
 * Check that all basis fields are anchor references (contain "#").
 */
function checkBasisAnchorReferences(rules: PolicyRule[]): ValidationError[] {
  const errors: ValidationError[] = [];

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (rule.basis && rule.basis.trim() !== '' && !rule.basis.includes('#')) {
      errors.push({
        message: `Rule "${rule.id}" has basis that is not an anchor reference (missing "#"): "${rule.basis}"`,
        code: 'BASIS_NO_ANCHOR',
        path: `rules[${i}].basis`,
      });
    }
  }

  return errors;
}

/**
 * Check for overlapping rules (same path + operation with conflicting actions).
 * Rules with higher priority (lower number) take precedence; report when
 * a lower-priority rule can never match because a higher-priority rule
 * covers the same path+operation.
 */
function checkOverlappingRules(rules: PolicyRule[]): ValidationError[] {
  const errors: ValidationError[] = [];

  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      const a = rules[i];
      const b = rules[j];

      // Only check if both have path and same operation (or both undefined)
      if (!a.match.path || !b.match.path) continue;
      const opA = a.match.operation ?? 'write';
      const opB = b.match.operation ?? 'write';
      if (opA !== opB) continue;

      // Simple glob overlap check: if one path is a superset of the other
      const aIsSuperset = isGlobSuperset(a.match.path, b.match.path);
      const bIsSuperset = isGlobSuperset(b.match.path, a.match.path);

      if (aIsSuperset || bIsSuperset) {
        // Check if actions conflict
        if (a.action !== b.action) {
          const priA = a.priority ?? 100;
          const priB = b.priority ?? 100;
          errors.push({
            message: `Rules "${a.id}" and "${b.id}" overlap on path "${aIsSuperset ? b.match.path : a.match.path}" with conflicting actions (${a.action} vs ${b.action}). Priority: ${a.id}=${priA}, ${b.id}=${priB}`,
            code: 'OVERLAP_CONFLICT',
            path: `rules[${i}], rules[${j}]`,
          });
        }
      }
    }
  }

  return errors;
}

/**
 * Check for unreachable rules (rules that can never match because a
 * higher-priority rule with "allow" or "deny" catches all paths first).
 */
function checkUnreachableRules(rules: PolicyRule[]): ValidationError[] {
  const errors: ValidationError[] = [];

  // Sort by priority (lower = higher precedence)
  const sorted = rules.map((r, i) => ({ rule: r, index: i }));
  sorted.sort((a, b) => (a.rule.priority ?? 100) - (b.rule.priority ?? 100));

  for (let i = 0; i < sorted.length; i++) {
    for (let j = 0; j < i; j++) {
      const higher = sorted[j].rule;
      const lower = sorted[i].rule;

      // If higher-priority rule catches everything with a terminal action
      if (higher.match.path === '**' && (higher.action === 'allow' || higher.action === 'deny')) {
        if (lower.match.path !== '**') {
          errors.push({
            message: `Rule "${lower.id}" (priority ${lower.priority ?? 100}) may be unreachable: rule "${higher.id}" (priority ${higher.priority ?? 100}) catches all paths with "${higher.action}"`,
            code: 'UNREACHABLE',
            path: `rules[${sorted[i].index}]`,
          });
          break;
        }
      }
    }
  }

  return errors;
}

/**
 * Check for conflicting priorities (same priority value with overlapping paths).
 */
function checkConflictingPriorities(rules: PolicyRule[]): ValidationError[] {
  const errors: ValidationError[] = [];

  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      const a = rules[i];
      const b = rules[j];
      const priA = a.priority ?? 100;
      const priB = b.priority ?? 100;

      if (priA === priB && a.action !== b.action && a.match.path && b.match.path) {
        if (isGlobSuperset(a.match.path, b.match.path) || isGlobSuperset(b.match.path, a.match.path)) {
          errors.push({
            message: `Rules "${a.id}" and "${b.id}" have the same priority (${priA}) but conflicting actions (${a.action} vs ${b.action}) on overlapping paths`,
            code: 'PRIORITY_CONFLICT',
            path: `rules[${i}], rules[${j}]`,
          });
        }
      }
    }
  }

  return errors;
}

/**
 * Check if globA is a superset of globB.
 * E.g. "**" is superset of "src\/**\/*.ts"
 *      "src\/**" is superset of "src\/**\/*.ts"
 */
function isGlobSuperset(globA: string, globB: string): boolean {
  if (globA === '**') return true;

  // Convert glob to regex-like pattern for simple prefix matching
  const prefixA = globA.replace('/**', '').replace('**', '');
  const prefixB = globB.replace('/**', '').replace('**', '');

  if (prefixA === '') return true; // ** catches everything
  if (prefixB === '') return false;

  return prefixB.startsWith(prefixA) || prefixA.startsWith(prefixB);
}
