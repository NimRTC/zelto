/**
 * add.command.ts — `zelto policy add` subcommand
 *
 * Adds a new rule to policy.yaml. Validates the rule before writing.
 *
 * 业务逻辑在 `../handlers/rules.handler.js`（ADR-068 D-30：文本级编辑，
 * 不做全量反序列化 —— 不动 `arch:` 段、不动注释、不动别的段）。
 *
 * C6: cli/policy/ may depend on adapters/ and core/, but not vice versa.
 */

import { addPolicyRule as handlerAdd } from '../handlers/rules.handler.js';
import type { AddHandlerResult } from '../handlers/rules.handler.js';
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
  action: 'allow' | 'deny' | 'ask';
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

  const result: AddHandlerResult = await handlerAdd({
    id: ruleId,
    path,
    ...(operation ? { operation } : {}),
    action,
    basis,
    ...(guidance !== undefined ? { guidance } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(priority !== undefined ? { priority } : {}),
  });

  if (!result.success) {
    if (options.json) {
      writeOutput(
        { success: false, errors: result.errors },
        undefined,
        { json: true },
      );
    } else {
      console.error(`${colors.red('✗')} ${result.errors[0]?.message ?? '操作失败'}`);
      for (const err of result.errors.slice(1)) {
        console.error(`  ${colors.red('✗')} ${err.message}${err.code ? ` [${colors.yellow(err.code)}]` : ''}`);
      }
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
