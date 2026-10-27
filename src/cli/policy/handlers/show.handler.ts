/**
 * show.handler.ts — `zelto policy show` business logic
 *
 * Shows a single policy rule by ID with full details.
 *
 * C6: cli/policy/ may depend on adapters/ and core/, but not vice versa.
 */

import { loadPolicyConfig } from '../../commands/shared.js';
import type { PolicyRule } from '../../../core/policy/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShowOptions {
  ruleId: string;
}

export interface ShowResult {
  found: boolean;
  rule?: PolicyRule;
  message?: string;
}

// ---------------------------------------------------------------------------
// Show handler
// ---------------------------------------------------------------------------

export function showPolicyRule(options: ShowOptions): ShowResult {
  const { ruleId } = options;

  try {
    const config = loadPolicyConfig();
    const rule = config.rules.find((r) => r.id === ruleId);

    if (!rule) {
      return {
        found: false,
        message: `Rule "${ruleId}" not found in policy`,
      };
    }

    return { found: true, rule };
  } catch {
    return {
      found: false,
      message: 'Failed to load policy configuration',
    };
  }
}
