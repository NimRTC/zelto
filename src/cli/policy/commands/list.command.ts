/**
 * list.command.ts — `zelto policy list` subcommand
 *
 * Lists all policy rules from policy/policy.yaml in text or JSON format.
 * C6: cli/policy/ may depend on adapters/ and core/, but not vice versa.
 */

import { loadPolicyConfig } from '../../commands/shared.js';
import { existsSync, readFileSync } from 'node:fs';
import { colors } from '../../color.js';
import { writeOutput } from '../../output.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ListOptions {
  json?: boolean;
}

// ---------------------------------------------------------------------------
// List command
// ---------------------------------------------------------------------------

export async function listPolicyRules(options: ListOptions): Promise<number> {
  const config = loadPolicyConfig();

  if (options.json) {
    const yamlSource = readPolicyYamlSource();
    writeOutput(
      {
        rules: config.rules,
        protected: config.protected,
        source: yamlSource ?? undefined,
      },
      undefined,
      { json: true },
    );
    return 0;
  }

  // Text output
  if (config.rules.length === 0) {
    console.log(`${colors.yellow('No policy rules defined.')}`);
  } else {
    console.log(`${colors.bold('Policy Rules:')}`);
    for (const rule of config.rules) {
      const status = rule.action === 'allow' ? colors.green('✓') : rule.action === 'deny' ? colors.red('✗') : colors.yellow('?');
      const action = rule.action.padEnd(5);
      const desc = rule.description ?? '(no description)';
      const path = rule.match.path ?? '*';
      console.log(`  ${status} [${colors.cyan(rule.id)}] ${colors.dim(action)} ${desc}`);
      console.log(`    ${colors.dim(`path: ${path}`)}`);
      if (rule.match.operation) {
        console.log(`    ${colors.dim(`operation: ${rule.match.operation}`)}`);
      }
    }
  }

  // Show protected paths
  if (config.protected.length > 0) {
    console.log(`\n${colors.bold('Protected Paths:')}`);
    for (const p of config.protected) {
      console.log(`  ${colors.dim(p)}`);
    }
  }

  // Show source file info
  const yamlPath = 'policy/policy.yaml';
  if (existsSync(yamlPath)) {
    console.log(`\n${colors.dim(`Source: ${yamlPath}`)}`);
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readPolicyYamlSource(): string | null {
  try {
    return readFileSync('policy/policy.yaml', 'utf-8');
  } catch {
    return null;
  }
}
