// Policy engine — rule matching and decision making
// Pure function, zero dependencies, deterministic

import { type PolicyConfig, type PolicyDecision, type PolicyRule, type Decision } from './types.js';
import { createHash } from 'node:crypto';
import { normalize } from 'node:path';
import { isZeltoManagedSpecPath } from '../project/managed-paths.js';

/**
 * 保护域（C5 / C8）：硬编码，**不可被任何策略规则覆盖**。
 *
 * 这是保护域的唯一真源 —— 报告层、hook 判定层都从这里取，
 * 不允许各自抄一份（抄一份就多一处漂移点，而漂移的后果是
 * 「本该拦住的文件被放行」）。
 *
 * 变更保护域等于变更不变量，必须走 ADR。
 */
export const PROTECTED_PATTERNS: readonly string[] = [
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
    .replace(/\*\*\//g, '<<<DS>>>/')   // **/ → sentinel (keeps trailing / for later)
    .replace(/\*\*/g, '<<<DSB>>>')     // bare ** → different sentinel
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')  // escape all regex metacharacters
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
  const normalized = normalize(path);
  if (normalized.startsWith('..') || path.startsWith('/') || path.includes(':\\')) {
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
  //
  // 例外：zelto 托管的规格文件（ADR-054）。
  //
  // `specs/slices/*.md` 是**zelto 自己写的**：人批准规格时写入，隔离运行时
  // 复制进 worktree，合并时提交回主干。所以它在提交 diff 里出现是正常的，
  // 报「不在策略允许范围内」是假警报 —— 提交这个文件的人就是 zelto 自己。
  //
  // 为什么放在**兜底**这一档、而不是判定之前就放行：策略里显式写的
  // deny 规则必须仍然拦得住 —— 「豁免托管文件」不能变成
  // 「谁都能改策略把保护解除」。人想真拦它，写一条 deny 规则即可。
  //
  // 这里放行的只是**提交时刻的策略判定**。更细的边界没有放松：
  //   - agent 能不能写它，由写集预约管（预留在 `.zelto/locks/<id>.json`）；
  //   - worktree 里的规格副本被改动，由托管文件哈希审计报篡改。
  if (operation === 'write' && isZeltoManagedSpecPath(path)) {
    return {
      decision: 'allow',
      ruleId: 'zelto:managed-spec',
      basis: 'zelto:managed-spec',
      guidance: null,
      policyVersion,
    };
  }

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
