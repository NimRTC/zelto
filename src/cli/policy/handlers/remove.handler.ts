/**
 * remove.handler.ts — `zelto policy remove` business logic (v3)
 *
 * Removes a policy rule by ID from policy.yaml using core yaml-writer.
 *
 * C6: cli/policy/ may depend on adapters/ and core/, but not vice versa.
 */

import { existsSync, readFileSync } from 'node:fs';
import { loadPolicyConfig } from '../../commands/shared.js';
import { writePolicyYaml } from '../../../core/policy/yaml-writer.js';
import type { PolicyRule } from '../../../core/policy/types.js';
import type { RuleData } from '../../../core/policy/yaml-writer.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RemoveOptions {
  /** Rule ID to remove */
  ruleId: string;
}

export interface RemoveHandlerResult {
  success: boolean;
  ruleId: string;
  message: string;
  /** Number of rules remaining after removal (0 if failed) */
  totalRulesAfter: number;
}

// ---------------------------------------------------------------------------
// Remove handler
// ---------------------------------------------------------------------------

/**
 * Remove a policy rule by ID from policy.yaml.
 *
 * 1. Load current policy config to verify the rule exists.
 * 2. Read raw YAML to preserve header comments.
 * 3. Filter out the matching rule.
 * 4. Write the updated rules back via core yaml-writer.
 *
 * Returns a result indicating success or failure.
 */
export function removePolicyRule(options: RemoveOptions): RemoveHandlerResult {
  const { ruleId } = options;

  // 1. Load current policy config to verify the rule exists
  let currentRules: PolicyRule[];
  try {
    const config = loadPolicyConfig();
    currentRules = config.rules;
  } catch {
    return {
      success: false,
      ruleId,
      message: 'Failed to load policy configuration',
      totalRulesAfter: 0,
    };
  }

  const ruleExists = currentRules.some((r) => r.id === ruleId);
  if (!ruleExists) {
    return {
      success: false,
      ruleId,
      message: `Rule "${ruleId}" not found in policy`,
      totalRulesAfter: currentRules.length,
    };
  }

  // 2. Read raw YAML to extract header comments
  const policyPath = 'policy/policy.yaml';
  let headerComment: string | undefined;

  if (existsSync(policyPath)) {
    const rawContent = readFileSync(policyPath, 'utf-8');
    headerComment = extractHeaderComment(rawContent);
  }

  // 3. Filter out the matching rule
  const updatedRules = currentRules
    .filter((r) => r.id !== ruleId)
    .map(toRuleData);

  // 4. Write the updated rules back
  writePolicyYaml(policyPath, updatedRules, headerComment);

  return {
    success: true,
    ruleId,
    message: `Rule "${ruleId}" has been removed`,
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
function toRuleData(rule: PolicyRule): RuleData {
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
