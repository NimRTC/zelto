/**
 * check.command.ts — `zelto policy check` subcommand
 *
 * Evaluates a path+operation against all policy rules and shows
 * which rules matched, the final decision, and any guidance.
 *
 * C6: cli/policy/ may depend on adapters/ and core/, but not vice versa.
 */

import { loadPolicyConfig } from '../../commands/shared.js';
import { evaluatePolicy, matchPath } from '../../../core/policy/engine.js';
import type { PolicyRule } from '../../../core/policy/types.js';
import { colors } from '../../color.js';
import { writeOutput } from '../../output.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CheckResultEntry {
  rule: PolicyRule;
  matched: boolean;
  details?: string;
}

export interface CheckSummary {
  total: number;
  matched: number;
  blocked: number;
}

export interface CheckOptions {
  path: string;
  operation: string;
  json?: boolean;
}

// ---------------------------------------------------------------------------
// Check command
// ---------------------------------------------------------------------------

export async function checkPolicy(options: CheckOptions): Promise<number> {
  const config = loadPolicyConfig();
  const { path, operation } = options;

  // Evaluate each rule
  const entries: CheckResultEntry[] = config.rules.map((rule) => {
    const pathMatches = rule.match.path ? matchPath(rule.match.path, path) : true;
    const opMatches = rule.match.operation ? rule.match.operation === operation : true;
    const matched = pathMatches && opMatches;

    let details: string | undefined;
    if (matched) {
      details = `action: ${rule.action}`;
    }

    return { rule, matched, details };
  });

  // Compute summary
  const total = entries.length;
  const matched = entries.filter((e) => e.matched).length;
  const blocked = entries.filter((e) => e.matched && e.rule.action === 'deny').length;

  // Get the final decision
  const decision = evaluatePolicy(config, path, operation, 'cli');

  if (options.json) {
    writeOutput(
      {
        path,
        operation,
        decision: {
          result: decision.decision,
          ruleId: decision.ruleId,
          basis: decision.basis,
          guidance: decision.guidance,
        },
        entries: entries.map((e) => ({
          ruleId: e.rule.id,
          action: e.rule.action,
          path: e.rule.match.path,
          operation: e.rule.match.operation,
          matched: e.matched,
          details: e.details,
        })),
        summary: { total, matched, blocked },
      },
      undefined,
      { json: true },
    );
    return 0;
  }

  // Text output
  console.log(`${colors.bold('Policy Check:')} ${colors.cyan(path)} (${operation})`);

  if (entries.length === 0) {
    console.log(`  ${colors.yellow('No rules defined.')}`);
  } else {
    for (const entry of entries) {
      const icon = entry.matched
        ? entry.rule.action === 'deny'
          ? colors.red('✗')
          : colors.green('✓')
        : colors.dim('○');
      const action = entry.rule.action.padEnd(5);
      const rulePath = entry.rule.match.path ?? '*';
      const ruleOp = entry.rule.match.operation ?? 'any';
      console.log(`  ${icon} [${colors.cyan(entry.rule.id)}] ${colors.dim(action)} ${rulePath} (${ruleOp})`);
      if (entry.matched) {
        console.log(`       ${colors.dim(`→ ${entry.rule.action}`)}`);
      }
      if (entry.rule.guidance) {
        console.log(`       ${colors.dim(entry.rule.guidance)}`);
      }
    }
  }

  console.log(`\n  ${colors.bold('Result:')} ${decision.decision === 'allow' ? colors.green(decision.decision) : colors.red(decision.decision)}`);
  if (decision.ruleId) {
    console.log(`  ${colors.dim(`Rule: ${decision.ruleId}`)}`);
  }
  console.log(`  ${colors.dim(`Basis: ${decision.basis}`)}`);
  if (decision.guidance) {
    console.log(`  ${colors.dim(`Guidance: ${decision.guidance}`)}`);
  }

  console.log(`\n  Summary: ${total} rules, ${matched} matched, ${blocked} blocked`);

  return 0;
}
