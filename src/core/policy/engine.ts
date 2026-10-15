// Policy engine — rule matching and decision making
// Pure function, zero dependencies, deterministic

import { type PolicyConfig, type PolicyDecision, type PolicyRule, type Decision } from './types.js';
import { createHash } from 'node:crypto';

const PROTECTED_PATTERNS: readonly string[] = [
  'policy/**',
  '.zelto/**',
  'AGENTS.md',
  '.cursor/rules/**',
  'zelto-hook',
  'zelto-hook.exe',
];

export function matchPath(pattern: string, path: string): boolean {
  // Convert glob-like pattern to regex
  // ** matches zero or more directory levels, * matches within a single segment
  const regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*\//g, '<<<DS>>>/')   // **/ → sentinel (keeps trailing / for later)
    .replace(/\*\*/g, '<<<DSB>>>')     // bare ** → different sentinel
    .replace(/\*/g, '[^/]*')
    .replace(/<<<DS>>>\//g, '(.+/|)')  // **/ → zero-or-more dirs (with optional /)
    .replace(/<<<DSB>>>/g, '.*');       // bare ** → any path
  return new RegExp(`^${regexStr}$`).test(path);
}

export function isProtectedPath(path: string): boolean {
  return PROTECTED_PATTERNS.some((p) => matchPath(p, path));
}

export function hashPolicy(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

export function evaluatePolicy(
  config: PolicyConfig,
  path: string,
  operation: string,
  policyVersion: string,
): PolicyDecision {
  // 1. Check protected domain first (0a/0b) — highest priority, hardcoded
  if (isProtectedPath(path) && operation === 'write') {
    return {
      decision: 'deny',
      ruleId: 'protected:0b',
      basis: 'AGENTS.md#禁区',
      guidance: `Path "${path}" is in the protected domain and cannot be modified.`,
      policyVersion,
    };
  }

  // 2. Check for path escape (outside project root)
  if (path.startsWith('..') || path.startsWith('/') || path.includes(':\\')) {
    return {
      decision: 'deny',
      ruleId: 'protected:0a',
      basis: 'AGENTS.md#禁区',
      guidance: `Path "${path}" escapes the project root.`,
      policyVersion,
    };
  }

  // 3. Sort rules by priority (highest first), then evaluate
  const sorted = [...config.rules].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  let finalDecision: Decision | null = null;
  let matchedRule: PolicyRule | null = null;

  for (const rule of sorted) {
    // Check if rule matches
    if (rule.match.path && !matchPath(rule.match.path, path)) continue;
    if (rule.match.operation && rule.match.operation !== operation) continue;

    // Found a match — deny overrides
    if (rule.action === 'deny') {
      return {
        decision: 'deny',
        ruleId: rule.id,
        basis: rule.basis,
        guidance: rule.guidance ?? null,
        policyVersion,
      };
    }

    // allow/ask — take the first match (priority order)
    if (finalDecision === null) {
      finalDecision = rule.action;
      matchedRule = rule;
    }
  }

  if (finalDecision && matchedRule) {
    return {
      decision: finalDecision,
      ruleId: matchedRule.id,
      basis: matchedRule.basis,
      guidance: matchedRule.guidance ?? null,
      policyVersion,
    };
  }

  // 4. Default: deny with guidance
  return {
    decision: 'deny',
    ruleId: 'default',
    basis: 'policy.yaml#default',
    guidance: `No matching rule for "${operation}" on "${path}". Add a rule to policy.yaml if this should be allowed.`,
    policyVersion,
  };
}

export function checkAnchor(
  currentHash: string,
  anchorHash: string | null,
): { valid: boolean; mismatch: boolean } {
  if (!anchorHash) {
    return { valid: false, mismatch: true };
  }
  return { valid: currentHash === anchorHash, mismatch: currentHash !== anchorHash };
}
