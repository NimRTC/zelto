/**
 * add.command.ts — `zelto policy add` subcommand
 *
 * Adds a new rule to policy.yaml. Validates the rule before writing.
 *
 * C6: cli/policy/ may depend on adapters/ and core/, but not vice versa.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadPolicyConfig } from '../../commands/shared.js';
import { validateRule } from '../../../core/policy/validator.js';
import type { ValidationError } from '../../../core/policy/validator.js';
import type { PolicyRule, Decision } from '../../../core/policy/types.js';
import { colors } from '../../color.js';
import { writeOutput } from '../../output.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AddOptions {
  /** The rule identifier (e.g. "allow-src-ts") */
  ruleId: string;
  /** Glob pattern the rule applies to */
  path: string;
  /** Optional operation to match (read|write|execute) */
  operation?: string;
  /** The action to take (allow|deny|ask) */
  action: Decision;
  /** Justification basis (e.g. "policy.yaml#rule-id") */
  basis: string;
  /** Optional guidance message */
  guidance?: string;
  /** Optional human-readable description */
  description?: string;
  /** Optional priority (lower = higher precedence) */
  priority?: number;
  /** Output as JSON */
  json?: boolean;
}

// ---------------------------------------------------------------------------
// Add command
// ---------------------------------------------------------------------------

export async function addPolicyRule(options: AddOptions): Promise<number> {
  const { ruleId, path, operation, action, basis, guidance, description, priority } = options;

  // Load current policy config
  const config = loadPolicyConfig();

  // Check for duplicate rule IDs
  const existing = config.rules.find((r) => r.id === ruleId);
  if (existing) {
    if (options.json) {
      writeOutput(
        { success: false, error: `Rule "${ruleId}" already exists.` },
        undefined,
        { json: true },
      );
    } else {
      console.error(`${colors.red('✗')} Rule "${colors.cyan(ruleId)}" already exists.`);
    }
    return 1;
  }

  // Build the new rule
  const newRule: PolicyRule = {
    id: ruleId,
    match: { path, ...(operation ? { operation } : {}) },
    action,
    basis,
    ...(guidance ? { guidance } : {}),
    ...(description ? { description } : {}),
    ...(priority !== undefined ? { priority } : {}),
  };

  // Validate the rule
  const ruleErrors = validateRule(newRule);
  if (ruleErrors.length > 0) {
    if (options.json) {
      writeOutput(
        { success: false, errors: ruleErrors },
        undefined,
        { json: true },
      );
    } else {
      console.error(`${colors.red('✗')} Invalid rule definition:`);
      for (const err of ruleErrors) {
        console.error(`  ${colors.red('✗')} ${err.message}${err.code ? ` [${colors.yellow(err.code)}]` : ''}`);
      }
    }
    return 1;
  }

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

  // Append the rule to the YAML file
  const yamlContent = readFileSync(policyPath, 'utf-8');
  const updatedYaml = appendRuleToYaml(yamlContent, newRule);

  try {
    writeFileSync(policyPath, updatedYaml, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (options.json) {
      writeOutput(
        { success: false, error: `Failed to write policy.yaml: ${msg}` },
        undefined,
        { json: true },
      );
    } else {
      console.error(`${colors.red('✗')} Failed to write policy.yaml: ${msg}`);
    }
    return 1;
  }

  // Success output
  if (options.json) {
    writeOutput(
      {
        success: true,
        rule: {
          id: ruleId,
          match: { path, ...(operation ? { operation } : {}) },
          action,
          basis,
        },
      },
      undefined,
      { json: true },
    );
  } else {
    console.log(`${colors.green('✓')} Rule "${colors.cyan(ruleId)}" added.`);
    console.log(`  ${colors.dim(`path: ${path}`)}`);
    if (operation) {
      console.log(`  ${colors.dim(`operation: ${operation}`)}`);
    }
    console.log(`  ${colors.dim(`action: ${action}`)}`);
    console.log(`  ${colors.dim(`basis: ${basis}`)}`);
  }

  return 0;
}

// ---------------------------------------------------------------------------
// YAML Helpers
// ---------------------------------------------------------------------------

/**
 * Append a new rule entry to the rules list in a policy.yaml string.
 * Finds the `rules:` section and inserts the new rule before any
 * top-level key that follows (e.g. `protected:`).
 */
function appendRuleToYaml(yaml: string, rule: PolicyRule): string {
  const lines = yaml.split('\n');

  // Scan to find the rules section boundaries
  let rulesHeaderLine = -1;
  let rulesSectionEnd = -1;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    if (raw.trim() === 'rules:') {
      rulesHeaderLine = i;
      continue;
    }

    // rules section ended: we see a non-empty line with no leading whitespace
    // (top-level YAML key) that isn't a comment
    if (rulesHeaderLine !== -1 && rulesSectionEnd === -1) {
      if (raw.length > 0 && raw[0] !== ' ' && raw[0] !== '\t' && raw[0] !== '#') {
        rulesSectionEnd = i;
        break;
      }
    }
  }

  if (rulesHeaderLine === -1) {
    // No rules section at all, append to end
    lines.push('', 'rules:');
    lines.push(buildRuleYamlBlock(rule));
    return lines.join('\n');
  }

  // Find the last rule entry and where it ends
  let lastRuleStart = -1;   // line index of last `- id:`
  let afterLastRule = rulesSectionEnd !== -1 ? rulesSectionEnd : lines.length;

  for (let i = rulesHeaderLine + 1; i < afterLastRule; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('- id:')) {
      lastRuleStart = i;
    }
  }

  if (lastRuleStart !== -1) {
    // Find where the last rule entry ends: next `- id:` or section end
    for (let i = lastRuleStart + 1; i < afterLastRule; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('- id:')) {
        afterLastRule = i;
        break;
      }
    }
  }

  const ruleBlock = buildRuleYamlBlock(rule);

  if (lastRuleStart !== -1) {
    // Insert after the last complete rule entry
    lines.splice(afterLastRule, 0, ruleBlock);
  } else {
    // Rules section exists but empty, insert after the header
    lines.splice(rulesHeaderLine + 1, 0, ruleBlock);
  }

  return lines.join('\n');
}

/**
 * Build a YAML block string for a single policy rule.
 * Produces format:
 *   - id: rule-id
 *     match: { path: "glob", operation: "op" }
 *     action: allow
 *     basis: "..."
 *     guidance: "..."
 */
function buildRuleYamlBlock(rule: PolicyRule): string {
  const lines: string[] = [];
  lines.push(`  - id: ${rule.id}`);

  const matchParts = [`path: "${rule.match.path ?? '**'}"`];
  if (rule.match.operation) {
    matchParts.push(`operation: "${rule.match.operation}"`);
  }
  lines.push(`    match: { ${matchParts.join(', ')} }`);

  lines.push(`    action: ${rule.action}`);
  lines.push(`    basis: "${rule.basis}"`);

  if (rule.guidance) {
    lines.push(`    guidance: "${rule.guidance}"`);
  }
  if (rule.description) {
    lines.push(`    description: "${rule.description}"`);
  }
  if (rule.priority !== undefined) {
    lines.push(`    priority: ${rule.priority}`);
  }

  return lines.join('\n');
}
