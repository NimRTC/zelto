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
 * duplicate ID detection and anchor reference validation.
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
