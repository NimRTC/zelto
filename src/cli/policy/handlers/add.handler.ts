/**
 * add.handler.ts — `zelto policy add` business logic
 *
 * Adds a new policy rule to policy.yaml after validation.
 *
 * C6: cli/policy/ may depend on adapters/ and core/, but not vice versa.
 */

import { existsSync, readFileSync } from 'node:fs';
import { loadPolicyConfig } from '../../commands/shared.js';
import { validateRule } from '../../../core/policy/validator.js';
import { writePolicyYaml } from '../../../core/policy/yaml-writer.js';
import type { PolicyRule } from '../../../core/policy/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AddPolicyRuleOptions {
  id: string;
  path?: string;
  operation?: string;
  action: string;
  basis: string;
  guidance?: string;
  priority?: number;
  description?: string;
}

export interface AddRuleError {
  message: string;
  code: string;
  path?: string;
}

export interface AddHandlerResult {
  success: boolean;
  ruleId: string;
  errors: AddRuleError[];
  totalRulesAfter: number;
}

// ---------------------------------------------------------------------------
// Add handler
// ---------------------------------------------------------------------------

/**
 * Add a new policy rule to policy.yaml.
 *
 * Steps:
 * 1. Load current policy config to validate against existing rules
 * 2. Validate the new rule parameters using the core deterministic validator
 * 3. Check for duplicate rule IDs
 * 4. Read the raw YAML to preserve header comments
 * 5. Append the new rule and write back
 */
export function addPolicyRule(options: AddPolicyRuleOptions): AddHandlerResult {
  const errors: AddRuleError[] = [];

  // 1. Validate rule parameters using core validator
  const ruleToValidate: Record<string, unknown> = {
    id: options.id,
    match: {
      ...(options.path ? { path: options.path } : {}),
      ...(options.operation ? { operation: options.operation } : {}),
    },
    action: options.action,
    basis: options.basis,
  };
  if (options.guidance !== undefined) {
    ruleToValidate.guidance = options.guidance;
  }
  if (options.priority !== undefined) {
    ruleToValidate.priority = options.priority;
  }
  if (options.description !== undefined) {
    ruleToValidate.description = options.description;
  }

  const validationErrors = validateRule(ruleToValidate);
  for (const err of validationErrors) {
    errors.push({
      message: err.message,
      code: err.code,
      path: err.path,
    });
  }

  if (errors.length > 0) {
    return {
      success: false,
      ruleId: options.id,
      errors,
      totalRulesAfter: 0,
    };
  }

  // 2. Load current policy config to check for duplicate IDs
  let currentRules: PolicyRule[] = [];
  try {
    const config = loadPolicyConfig();
    currentRules = config.rules;
  } catch {
    // No existing config — start fresh
  }

  // 3. Check for duplicate ID
  const duplicate = currentRules.find((r) => r.id === options.id);
  if (duplicate) {
    errors.push({
      message: `A rule with ID "${options.id}" already exists`,
      code: 'DUPLICATE_ID',
      path: 'id',
    });
    return {
      success: false,
      ruleId: options.id,
      errors,
      totalRulesAfter: currentRules.length,
    };
  }

  // 4. Read raw YAML to extract header comments
  const policyPath = 'policy/policy.yaml';
  let headerComment: string | undefined;

  if (existsSync(policyPath)) {
    const rawContent = readFileSync(policyPath, 'utf-8');
    headerComment = extractHeaderComment(rawContent);
  }

  // 5. Build the new rule list and write
  const newRule = buildRuleData(options);
  const updatedRules = [...currentRules.map(toRuleData), newRule];

  writePolicyYaml(policyPath, updatedRules, headerComment);

  return {
    success: true,
    ruleId: options.id,
    errors: [],
    totalRulesAfter: updatedRules.length,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the header comment block (lines starting with #) from raw YAML content.
 * Returns lines as they appear, including leading # and trailing newline.
 */
function extractHeaderComment(rawContent: string): string | undefined {
  const lines = rawContent.split('\n');
  const commentLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      commentLines.push(line);
    } else if (trimmed === '' && commentLines.length > 0) {
      // Allow blank lines within the header block
      commentLines.push(line);
    } else {
      break;
    }
  }

  return commentLines.length > 0 ? commentLines.join('\n') : undefined;
}

/**
 * Convert a PolicyRule (from core types) to the RuleData format used by yaml-writer.
 */
function toRuleData(rule: PolicyRule): {
  id: string;
  match: { path?: string; operation?: string; harness?: string };
  action: string;
  basis: string;
  guidance?: string;
  priority?: number;
  description?: string;
} {
  return {
    id: rule.id,
    match: {
      ...(rule.match.path ? { path: rule.match.path } : {}),
      ...(rule.match.operation ? { operation: rule.match.operation } : {}),
      ...(rule.match.harness ? { harness: rule.match.harness } : {}),
    },
    action: rule.action,
    basis: rule.basis,
    ...(rule.guidance ? { guidance: rule.guidance } : {}),
    ...(rule.priority !== undefined ? { priority: rule.priority } : {}),
    ...(rule.description ? { description: rule.description } : {}),
  };
}

/**
 * Build a RuleData object from the add handler options.
 */
function buildRuleData(options: AddPolicyRuleOptions): {
  id: string;
  match: { path?: string; operation?: string };
  action: string;
  basis: string;
  guidance?: string;
  priority?: number;
  description?: string;
} {
  return {
    id: options.id,
    match: {
      ...(options.path ? { path: options.path } : {}),
      ...(options.operation ? { operation: options.operation } : {}),
    },
    action: options.action,
    basis: options.basis,
    ...(options.guidance ? { guidance: options.guidance } : {}),
    ...(options.priority !== undefined ? { priority: options.priority } : {}),
    ...(options.description ? { description: options.description } : {}),
  };
}
