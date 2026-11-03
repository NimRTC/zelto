// Policy YAML parser — 策略文件的唯一解析实现
//
// C2/C6: core/ 内，只用 Node 内置模块，不依赖 adapters/
// C3: 纯解析，不调模型、不触网
//
// 之前 policy.yaml 的解析散落在三处（cli/commands/shared.ts、hook/index.ts、
// core/policy/data-access.ts），规则一旦漂移，「提交时判定」与「运行时判定」
// 就会给出不同结论。现在统一收敛到这里。

import type { Decision, PolicyRule } from './types.js';

/**
 * 去掉包裹整个字符串的双引号，保留字符串内部的引号。
 * '"npx claude-code"' → 'npx claude-code'
 */
export function stripSurroundingQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * 解析 policy.yaml 的 `rules:` 段。
 *
 * 支持两种写法：
 * - 行内：`match: { path: "src/**", operation: "write" }`
 * - 分行：`match:` 下面缩进写 `path:` / `operation:`
 *
 * `match` 必须把 `path` 写在前面 —— 行内写法靠正则按位置解析，
 * 写成 `{ operation: ..., path: ... }` 会被忽略。
 */
export function parsePolicyYaml(content: string): { rules: PolicyRule[] } {
  const rules: PolicyRule[] = [];
  let currentRule: Record<string, unknown> | null = null;

  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '') continue;

    if (trimmed.startsWith('- id:')) {
      if (currentRule?.id) rules.push(currentRule as unknown as PolicyRule);
      currentRule = { id: trimmed.slice(5).trim(), match: {} };
      continue;
    }

    if (!currentRule) continue;

    const matchInline = trimmed.match(
      /^match:\s*\{\s*path:\s*"([^"]*)"\s*(?:,\s*operation:\s*"([^"]*)")?\s*\}/,
    );
    if (matchInline) {
      currentRule.match = {
        path: matchInline[1],
        ...(matchInline[2] ? { operation: matchInline[2] } : {}),
      };
      continue;
    }

    if (trimmed.startsWith('path:')) {
      currentRule.match = {
        ...(currentRule.match as Record<string, unknown>),
        path: stripSurroundingQuotes(trimmed.slice(5).trim()),
      };
      continue;
    }

    if (trimmed.startsWith('operation:')) {
      currentRule.match = {
        ...(currentRule.match as Record<string, unknown>),
        operation: stripSurroundingQuotes(trimmed.slice(10).trim()),
      };
      continue;
    }

    if (trimmed.startsWith('action:')) {
      currentRule.action = trimmed.slice(7).trim() as Decision;
      continue;
    }

    if (trimmed.startsWith('basis:')) {
      currentRule.basis = stripSurroundingQuotes(trimmed.slice(6).trim());
      continue;
    }

    if (trimmed.startsWith('guidance:')) {
      currentRule.guidance = stripSurroundingQuotes(trimmed.slice(9).trim());
      continue;
    }

    if (trimmed.startsWith('priority:')) {
      currentRule.priority = Number.parseInt(trimmed.slice(9).trim(), 10);
    }
  }

  if (currentRule?.id) rules.push(currentRule as unknown as PolicyRule);
  return { rules };
}
