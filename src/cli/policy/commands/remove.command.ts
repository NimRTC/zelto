/**
 * remove.command.ts — `zelto policy remove` subcommand
 *
 * Removes a rule from policy.yaml by rule ID.
 *
 * C6: cli/policy/ may depend on adapters/ and core/, but not vice versa.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadPolicyConfig } from '../../commands/shared.js';
import type { PolicyRule } from '../../../core/policy/types.js';
import { colors } from '../../color.js';
import { writeOutput } from '../../output.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RemoveOptions {
  /** The rule identifier to remove */
  ruleId: string;
  /** Output as JSON */
  json?: boolean;
}

// ---------------------------------------------------------------------------
// Remove command
// ---------------------------------------------------------------------------

export async function removePolicyRule(options: RemoveOptions): Promise<number> {
  const { ruleId } = options;

  // Load current policy config
  const config = loadPolicyConfig();

  // Find the rule to remove
  const ruleIndex = config.rules.findIndex((r) => r.id === ruleId);
  if (ruleIndex === -1) {
    if (options.json) {
      writeOutput(
        { success: false, error: `Rule "${ruleId}" not found.` },
        undefined,
        { json: true },
      );
    } else {
      console.error(`${colors.red('✗')} Rule "${colors.cyan(ruleId)}" not found.`);
    }
    return 1;
  }

  const removedRule = config.rules[ruleIndex];

  // Read the current policy YAML content
  const policyPath = resolve('policy', 'policy.yaml');
  if (!existsSync(policyPath)) {
    if (options.json) {
      writeOutput(
        { success: false, error: 'policy/policy.yaml not found.' },
        undefined,
        { json: true },
      );
    } else {
      console.error(`${colors.red('✗')} policy/policy.yaml not found.`);
    }
    return 1;
  }

  const yamlContent = readFileSync(policyPath, 'utf-8');
  const updatedYaml = removeRuleFromYaml(yamlContent, ruleId);

  if (updatedYaml === null) {
    if (options.json) {
      writeOutput(
        { success: false, error: `Rule "${ruleId}" not found in YAML content.` },
        undefined,
        { json: true },
      );
    } else {
      console.error(`${colors.red('✗')} Rule "${colors.cyan(ruleId)}" not found in policy.yaml.`);
    }
    return 1;
  }

  try {
    writeFileSync(policyPath, updatedYaml, 'utf-8');
  } catch (err) {
    if (options.json) {
      writeOutput(
        { success: false, error: `Failed to write policy.yaml: ${err}` },
        undefined,
        { json: true },
      );
    } else {
      console.error(`${colors.red('✗')} Failed to write policy.yaml: ${err}`);
    }
    return 1;
  }

  // Success output
  if (options.json) {
    writeOutput(
      {
        success: true,
        removed: {
          id: removedRule.id,
          match: removedRule.match,
          action: removedRule.action,
          basis: removedRule.basis,
        },
      },
      undefined,
      { json: true },
    );
  } else {
    console.log(`${colors.green('✓')} Rule "${colors.cyan(ruleId)}" removed.`);
    console.log(`  ${colors.dim(`path: ${removedRule.match.path ?? '*'}`)}`);
    if (removedRule.match.operation) {
      console.log(`  ${colors.dim(`operation: ${removedRule.match.operation}`)}`);
    }
    console.log(`  ${colors.dim(`action: ${removedRule.action}`)}`);
  }

  return 0;
}

// ---------------------------------------------------------------------------
// YAML Helpers
// ---------------------------------------------------------------------------

/**
 * Remove a rule entry from a policy.yaml string by matching the `- id:` line.
 * Returns null if the rule ID is not found.
 */
function removeRuleFromYaml(yaml: string, ruleId: string): string | null {
  const lines = yaml.split('\n');
  const linesToRemove: number[] = [];
  let inTargetRule = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (trimmed.startsWith('- id:')) {
      // If we were tracking a previous rule, stop
      inTargetRule = false;

      const id = trimmed.slice(5).trim();
      if (id === ruleId) {
        inTargetRule = true;
        linesToRemove.push(i);
        continue;
      }
    }

    if (inTargetRule) {
      // Remove all indented lines that belong to this rule entry
      // A non-empty, non-comment line at column 0 ends the rule
      if (trimmed !== '' && !trimmed.startsWith('#') && !trimmed.startsWith(' ') && !trimmed.startsWith('\t')) {
        inTargetRule = false;
      } else {
        linesToRemove.push(i);
      }
    }
  }

  if (linesToRemove.length === 0) {
    return null;
  }

  // Remove lines in reverse order to preserve indices
  for (const idx of linesToRemove.sort((a, b) => b - a)) {
    lines.splice(idx, 1);
  }

  return lines.join('\n');
}
