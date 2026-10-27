/**
 * edit.handler.ts — `zelto policy edit` business logic
 *
 * Edits an existing policy rule's fields in policy.yaml.
 * Uses core yaml-writer for serialization, same as remove handler.
 *
 * C6: cli/policy/ may depend on adapters/ and core/, but not vice versa.
 */

import { existsSync, readFileSync } from 'node:fs';
import { loadPolicyConfig } from '../../commands/shared.js';
import { writePolicyYaml } from '../../../core/policy/yaml-writer.js';
import type { PolicyRule, Decision } from '../../../core/policy/types.js';
import type { RuleData } from '../../../core/policy/yaml-writer.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EditOptions {
  /** Rule ID to edit */
  ruleId: string;
  /** New glob pattern (optional) */
  path?: string;
  /** New operation (optional) */
  operation?: string;
  /** New action (optional) */
  action?: Decision;
  /** New basis (optional) */
  basis?: string;
  /** New guidance (optional) */
  guidance?: string;
  /** New description (optional) */
  description?: string;
  /** New priority (optional) */
  priority?: number;
}

export interface EditHandlerResult {
  success: boolean;
  ruleId: string;
  message: string;
  /** The updated rule fields (for display) */
  changes: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Edit handler
// ---------------------------------------------------------------------------

/**
 * Edit an existing policy rule by ID in policy.yaml.
 *
 * 1. Load current policy config to verify the rule exists.
 * 2. Read raw YAML to preserve header comments.
 * 3. Find the matching rule and apply field updates.
 * 4. Write the updated rules back via core yaml-writer.
 *
 * Returns a result indicating success or failure.
 */
export function editPolicyRule(options: EditOptions): EditHandlerResult {
  const { ruleId, path, operation, action, basis, guidance, description, priority } = options;

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
      changes: {},
    };
  }

  const ruleIndex = currentRules.findIndex((r) => r.id === ruleId);
  if (ruleIndex === -1) {
    return {
      success: false,
      ruleId,
      message: `Rule "${ruleId}" not found in policy`,
      changes: {},
    };
  }

  // 2. Track what changed
  const changes: Record<string, unknown> = {};
  const rule = currentRules[ruleIndex];

  // 3. Apply field updates
  if (path !== undefined) {
    rule.match = { ...rule.match, path };
    changes.path = path;
  }
  if (operation !== undefined) {
    rule.match = { ...rule.match, operation };
    changes.operation = operation;
  }
  if (action !== undefined) {
    rule.action = action;
    changes.action = action;
  }
  if (basis !== undefined) {
    rule.basis = basis;
    changes.basis = basis;
  }
  if (guidance !== undefined) {
    rule.guidance = guidance;
    changes.guidance = guidance;
  }
  if (description !== undefined) {
    rule.description = description;
    changes.description = description;
  }
  if (priority !== undefined) {
    rule.priority = priority;
    changes.priority = priority;
  }

  if (Object.keys(changes).length === 0) {
    return {
      success: false,
      ruleId,
      message: 'No changes specified. Use --path, --operation, --action, --basis, --guidance, --description, or --priority.',
      changes: {},
    };
  }

  // 4. Read raw YAML to extract header comments
  const policyPath = 'policy/policy.yaml';
  let headerComment: string | undefined;

  if (existsSync(policyPath)) {
    const rawContent = readFileSync(policyPath, 'utf-8');
    headerComment = extractHeaderComment(rawContent);
  }

  // 5. Convert rules to RuleData and write back
  const updatedRules = currentRules.map(toRuleData);
  writePolicyYaml(policyPath, updatedRules, headerComment);

  return {
    success: true,
    ruleId,
    message: `Rule "${ruleId}" updated`,
    changes,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the header comment block (lines starting with #) from raw YAML content.
 */
function extractHeaderComment(rawContent: string): string | undefined {
  const lines = rawContent.split('\n');
  const commentLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      commentLines.push(line);
    } else if (trimmed === '' && commentLines.length > 0) {
      commentLines.push(line);
    } else {
      break;
    }
  }

  return commentLines.length > 0 ? commentLines.join('\n') : undefined;
}

/**
 * Convert a PolicyRule to RuleData format.
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
