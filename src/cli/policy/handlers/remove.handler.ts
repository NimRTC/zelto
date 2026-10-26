/**
 * remove.handler.ts — `zelto policy remove` business logic
 *
 * Removes a policy rule by ID from policy.yaml.
 * Reads the raw YAML, finds and removes the rule block, and writes back.
 *
 * C6: cli/policy/ may depend on adapters/ and core/, but not vice versa.
 * C1: State only in files — reads/writes policy/policy.yaml directly.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadPolicyConfig } from '../../commands/shared.js';

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
}

// ---------------------------------------------------------------------------
// Remove handler
// ---------------------------------------------------------------------------

/**
 * Remove a policy rule by ID from policy.yaml.
 *
 * 1. Loads the policy config to verify the rule exists.
 * 2. Reads policy.yaml as raw text.
 * 3. Parses the YAML line-by-line to locate and remove the rule block.
 * 4. Writes the modified content back to policy.yaml.
 *
 * Returns a result indicating success or failure.
 */
export function removePolicyRule(options: RemoveOptions): RemoveHandlerResult {
  const { ruleId } = options;
  const policyPath = 'policy/policy.yaml';

  // 1. Verify the rule exists by loading the config
  let config;
  try {
    config = loadPolicyConfig();
  } catch {
    return {
      success: false,
      ruleId,
      message: 'Failed to load policy configuration',
    };
  }

  const ruleIndex = config.rules.findIndex((r) => r.id === ruleId);
  if (ruleIndex === -1) {
    return {
      success: false,
      ruleId,
      message: `Rule "${ruleId}" not found in policy`,
    };
  }

  // 2. Read the raw YAML
  if (!existsSync(policyPath)) {
    return {
      success: false,
      ruleId,
      message: `Policy file not found: ${policyPath}`,
    };
  }

  const content = readFileSync(policyPath, 'utf-8');

  // 3. Parse line-by-line to remove the rule block matching the given ID
  const lines = content.split('\n');
  const newLines: string[] = [];
  let inTargetRule = false;
  let found = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Detect start of a rule: `- id: <ruleId>`
    if (trimmed.startsWith('- id:')) {
      const idValue = trimmed.slice(5).trim().replace(/^"|"$/g, '');
      if (idValue === ruleId) {
        inTargetRule = true;
        found = true;
        continue; // Skip this line — rule starts here
      }
      inTargetRule = false;
    }

    if (inTargetRule) {
      // Check if we've reached the next rule or a top-level key
      if (trimmed.startsWith('- id:') || trimmed.startsWith('#')) {
        inTargetRule = false;
        // Fall through to add this line
      } else {
        // Still inside the target rule block — skip
        continue;
      }
    }

    // Only re-add if we haven't just finished skipping the target rule
    if (!inTargetRule) {
      newLines.push(lines[i]);
    }
  }

  if (!found) {
    return {
      success: false,
      ruleId,
      message: `Rule "${ruleId}" could not be located in policy.yaml text`,
    };
  }

  // 4. Write the modified content back
  const newContent = newLines.join('\n');
  writeFileSync(policyPath, newContent, 'utf-8');

  return {
    success: true,
    ruleId,
    message: `Rule "${ruleId}" has been removed`,
  };
}
