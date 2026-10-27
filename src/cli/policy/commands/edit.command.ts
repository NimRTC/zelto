/**
 * edit.command.ts — `zelto policy edit` subcommand
 *
 * Edits an existing rule in policy.yaml. Delegates business logic to the edit handler.
 *
 * C6: cli/policy/ may depend on adapters/ and core/, but not vice versa.
 */

import { editPolicyRule as handlerEdit } from '../handlers/edit.handler.js';
import type { EditHandlerResult } from '../handlers/edit.handler.js';
import type { Decision } from '../../../core/policy/types.js';
import { colors } from '../../color.js';
import { writeOutput } from '../../output.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EditOptions {
  /** The rule identifier to edit */
  ruleId: string;
  /** New glob pattern */
  path?: string;
  /** New operation */
  operation?: string;
  /** New action */
  action?: Decision;
  /** New basis */
  basis?: string;
  /** New guidance */
  guidance?: string;
  /** New description */
  description?: string;
  /** New priority */
  priority?: number;
  /** Output as JSON */
  json?: boolean;
}

// ---------------------------------------------------------------------------
// Edit command
// ---------------------------------------------------------------------------

export async function editPolicyRule(options: EditOptions): Promise<number> {
  const { ruleId, path, operation, action, basis, guidance, description, priority, json: isJson } = options;

  const result: EditHandlerResult = handlerEdit({
    ruleId, path, operation, action, basis, guidance, description, priority,
  });

  if (!result.success) {
    if (isJson) {
      writeOutput(
        { success: false, error: result.message },
        undefined,
        { json: true },
      );
    } else {
      console.error(`${colors.red('✗')} ${result.message}`);
    }
    return 1;
  }

  // Success output
  if (isJson) {
    writeOutput(
      { success: true, ruleId, changes: result.changes },
      undefined,
      { json: true },
    );
  } else {
    console.log(`${colors.green('✓')} Rule "${colors.cyan(ruleId)}" updated.`);
    for (const [field, value] of Object.entries(result.changes)) {
      console.log(`  ${colors.dim(`${field}: ${value}`)}`);
    }
  }

  return 0;
}
