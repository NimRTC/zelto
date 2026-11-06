// Policy YAML parser — 策略文件的唯一解析实现
//
// C2/C6: core/ 内，只用 Node 内置模块，不依赖 adapters/
// C3: 纯解析，不调模型、不触网
//
// 之前 policy.yaml 的解析散落在三处（cli/commands/shared.ts、hook/index.ts、
// core/policy/data-access.ts），规则一旦漂移，「提交时判定」与「运行时判定」
// 就会给出不同结论。现在统一收敛到这里。

import type { ArchGuardRule, Decision, PolicyRule } from './types.js';

/**
 * 去掉包裹整个字符串的成对引号，保留字符串内部的引号。
 * '"npx claude-code"' → 'npx claude-code'
 * "'secrets/**'"      → 'secrets/**'
 *
 * 单引号与双引号等价（ADR-028）：YAML 里两者都是字符串定界符，
 * 只认双引号会让用单引号写的规则解析成带引号的字面量，
 * glob 永不匹配 —— deny 规则因此被静默跳过，策略反而被绕过。
 *
 * 只剥成对包裹的引号；不成对（`'src/**`）原样保留。
 */
export function stripSurroundingQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

/**
 * 解析行内 `match: { ... }` 的内容。
 *
 * 按键值对解析，不依赖键的先后顺序（ADR-028）：
 * `{ path: "src/**", operation: "write" }` 与
 * `{ operation: "write", path: "src/**" }` 等价。
 *
 * 返回 `null` 表示这不是行内 match 写法，交给分行写法处理。
 */
function parseInlineMatch(body: string): { path?: string; operation?: string } | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;

  const inner = trimmed.slice(1, -1).trim();
  if (inner === '') return {};

  const result: { path?: string; operation?: string } = {};
  for (const part of inner.split(',')) {
    const segment = part.trim();
    if (segment === '') continue;

    const sep = segment.indexOf(':');
    if (sep < 0) continue;

    const key = stripSurroundingQuotes(segment.slice(0, sep).trim());
    const value = stripSurroundingQuotes(segment.slice(sep + 1).trim());
    if (key === 'path') result.path = value;
    else if (key === 'operation') result.operation = value;
  }
  return result;
}

/**
 * 解析 policy.yaml 的 `rules:` 段与可选 `arch:` 段（ADR-027）。
 *
 * 支持两种写法：
 * - 行内：`match: { path: "src/**", operation: "write" }`
 * - 分行：`match:` 下面缩进写 `path:` / `operation:`
 *
 * 两种写法都**引号风格无关**（单/双/无引号等价），
 * 行内写法的**键序无关**（`path` 与 `operation` 谁在前都一样）——ADR-028。
 *
 * 顶层段跟踪：进入 `arch:` 后 `action:` / `basis:` 归护栏规则，
 * 不再往最后一条 `rules:` 上贴（否则最后一个 rule 会被污染）。
 */
export function parsePolicyYaml(content: string): { rules: PolicyRule[]; arch?: ArchGuardRule[] } {
  const rules: PolicyRule[] = [];
  const arch: ArchGuardRule[] = [];
  let currentRule: Record<string, unknown> | null = null;
  let currentGuard: Record<string, unknown> | null = null;
  let section: 'rules' | 'arch' | null = null;

  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '') continue;

    // 顶层段切换：无缩进且以冒号结尾的行
    if (line[0] !== ' ' && line[0] !== '\t' && trimmed.endsWith(':')) {
      if (currentRule) {
        rules.push(currentRule as unknown as PolicyRule);
        currentRule = null;
      }
      if (currentGuard) {
        arch.push(currentGuard as unknown as ArchGuardRule);
        currentGuard = null;
      }
      section = trimmed === 'rules:' ? 'rules' : trimmed === 'arch:' ? 'arch' : null;
      continue;
    }
    if (trimmed === 'rules:') {
      if (currentGuard) {
        arch.push(currentGuard as unknown as ArchGuardRule);
        currentGuard = null;
      }
      section = 'rules';
      continue;
    }
    if (trimmed === 'arch:') {
      if (currentRule) {
        rules.push(currentRule as unknown as PolicyRule);
        currentRule = null;
      }
      section = 'arch';
      continue;
    }

    // ─── arch 段 ──────────────────────────────────────────────────
    if (section === 'arch') {
      if (trimmed.startsWith('- kind:')) {
        if (currentGuard) arch.push(currentGuard as unknown as ArchGuardRule);
        currentGuard = { kind: stripSurroundingQuotes(trimmed.slice(7).trim()) };
        continue;
      }
      if (!currentGuard) continue;
      if (trimmed.startsWith('kind:')) {
        currentGuard.kind = stripSurroundingQuotes(trimmed.slice(5).trim());
        continue;
      }
      if (trimmed.startsWith('action:')) {
        currentGuard.action = trimmed.slice(7).trim();
        continue;
      }
      if (trimmed.startsWith('basis:')) {
        currentGuard.basis = stripSurroundingQuotes(trimmed.slice(6).trim());
        continue;
      }
      if (trimmed.startsWith('guidance:')) {
        currentGuard.guidance = stripSurroundingQuotes(trimmed.slice(9).trim());
        continue;
      }
      continue;
    }

    if (section === null && currentRule === null && !trimmed.startsWith('- id:')) {
      // 还没进任何段：忽略（容忍 rules: 缺席的旧文件头）
    }

    if (trimmed.startsWith('- id:')) {
      if (currentRule) rules.push(currentRule as unknown as PolicyRule);
      currentRule = { id: stripSurroundingQuotes(trimmed.slice(5).trim()), match: {} };
      continue;
    }

    if (!currentRule) continue;

    if (trimmed.startsWith('match:')) {
      const inline = parseInlineMatch(trimmed.slice(6));
      if (inline) {
        currentRule.match = {
          ...(currentRule.match as Record<string, unknown>),
          ...inline,
        };
      }
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

  if (currentRule) rules.push(currentRule as unknown as PolicyRule);
  if (currentGuard) arch.push(currentGuard as unknown as ArchGuardRule);
  return arch.length > 0 ? { rules, arch } : { rules };
}
