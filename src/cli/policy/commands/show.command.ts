/**
 * show.command.ts — `zelto policy show <rule-id>` subcommand
 *
 * Shows a single policy rule by ID with full details.
 *
 * C6: cli/policy/ may depend on adapters/ and core/, but not vice versa.
 */

import { showPolicyRule } from '../handlers/show.handler.js';
import { colors } from '../../color.js';
import { writeOutput } from '../../output.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShowOptions {
  ruleId: string;
  json?: boolean;
}

// ---------------------------------------------------------------------------
// Show command
// ---------------------------------------------------------------------------

export async function showPolicyRuleCommand(options: ShowOptions): Promise<number> {
  const { ruleId, json } = options;
  const result = showPolicyRule({ ruleId });

  if (!result.found) {
    if (json) {
      writeOutput({ found: false, error: result.message }, undefined, { json: true });
    } else {
      console.error(`${colors.red('✗')} ${result.message}`);
    }
    return 1;
  }

  const rule = result.rule!;

  if (json) {
    writeOutput({ found: true, rule }, undefined, { json: true });
    return 0;
  }

  console.log(`${colors.bold(`Rule: ${rule.id}`)}`);
  if (rule.description) console.log(`  Description: ${rule.description}`);
  console.log(`  Match path:      ${rule.match.path ?? '*'}`);
  if (rule.match.operation) console.log(`  Match operation: ${rule.match.operation}`);
  if (rule.match.harness) console.log(`  Match harness:   ${rule.match.harness}`);
  const actionColor = rule.action === 'allow' ? colors.green : rule.action === 'deny' ? colors.red : colors.yellow;
  console.log(`  Action:          ${actionColor(rule.action)}`);
  console.log(`  Basis:           ${colors.dim(rule.basis)}`);
  if (rule.guidance) console.log(`  Guidance:        ${rule.guidance}`);
  if (rule.priority !== undefined) console.log(`  Priority:        ${rule.priority}`);

  return 0;
}
