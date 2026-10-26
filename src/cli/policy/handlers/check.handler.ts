/**
 * check.handler.ts — `zelto policy check` matching logic
 *
 * Evaluates policy rules against a given path/operation pair and returns
 * which rules match and the overall decision.
 *
 * C6: cli/policy/ may depend on adapters/ and core/, but not vice versa.
 */

import { evaluatePolicy, matchPath } from '../../../core/policy/engine.js';
import { loadPolicyConfig } from '../../commands/shared.js';
import type { CheckResultEntry, CheckSummary } from '../output-formatter.js';
import type { PolicyRule } from '../../../core/policy/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CheckOptions {
  path: string;
  operation: string;
}

export interface CheckHandlerResult {
  decision: 'allow' | 'deny' | 'ask';
  ruleId: string | null;
  entries: CheckResultEntry[];
  summary: CheckSummary;
}

// ---------------------------------------------------------------------------
// Check handler
// ---------------------------------------------------------------------------

/**
 * Evaluate policy rules against a given path and operation.
 *
 * Returns which rules matched, the overall decision, and a summary count.
 */
export async function checkPolicy(options: CheckOptions): Promise<CheckHandlerResult> {
  const config = loadPolicyConfig();
  const { path, operation } = options;
  const policyVersion = 'v2';

  // Get the overall policy decision from the engine (handles protected paths,
  // path escape, priority ordering, and deny-overrides)
  const decision = evaluatePolicy(config, path, operation, policyVersion);

  // Build per-rule match results for display
  const entries: CheckResultEntry[] = config.rules.map((rule: PolicyRule) => {
    const pathMatch = rule.match.path ? matchPath(rule.match.path, path) : true;
    const opMatch = rule.match.operation ? rule.match.operation === operation : true;
    const matched = pathMatch && opMatch;

    return {
      rule,
      matched,
      details: matched
        ? `Matches "${path}"${rule.match.operation ? ` with operation "${operation}"` : ''}`
        : undefined,
    };
  });

  const matchedEntries = entries.filter((e) => e.matched);
  const blockedEntries = matchedEntries.filter((e) => e.rule.action === 'deny');

  return {
    decision: decision.decision,
    ruleId: decision.ruleId,
    entries,
    summary: {
      total: entries.length,
      matched: matchedEntries.length,
      blocked: blockedEntries.length,
    },
  };
}
