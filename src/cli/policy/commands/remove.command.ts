/**
 * remove.command.ts — `zelto policy remove` subcommand (v3)
 *
 * Removes a rule from policy.yaml by rule ID.
 * Delegates business logic to the remove handler.
 *
 * C6: cli/policy/ may depend on adapters/ and core/, but not vice versa.
 */

import { removePolicyRule as handlerRemove } from '../handlers/remove.handler.js';
import type { RemoveHandlerResult } from '../handlers/remove.handler.js';
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
  const { ruleId, json: isJson } = options;

  const result: RemoveHandlerResult = handlerRemove({ ruleId });

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
      { success: true, removed: { id: ruleId } },
      undefined,
      { json: true },
    );
  } else {
    console.log(`${colors.green('✓')} Rule "${colors.cyan(ruleId)}" removed.`);
  }

  return 0;
}
