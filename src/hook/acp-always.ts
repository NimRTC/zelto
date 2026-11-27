// 「以后都允许」能不能给 —— 判定在 hook 层（ADR-133 补充）
//
// ── 这一层放哪 ────────────────────────────────────────────────────────
//
// 判定**必须在** `src/hook/`（C3：判定只读文件、纯计算、确定性）。
// adapter 只负责「问人」和「记账」，不自己判。
//
// ── 为什么不能直接把 allow_always 回给 agent ─────────────────────────
//
// 见 `src/adapters/acp/always-grants.ts` 的文件头：
// agent 收到 `allow_always` 会写进自己的 `.cursor/permissions.json`，
// 之后同类操作**不再问 zelto** → 逐写判定被绕过、且跨切片存活。
//
// 所以 zelto **永远对 agent 回 `allow_once`**，「以后都允许」的记忆
// 记在 zelto 自己这边。
//
// ── 授权范围（用户拍板 2026-11-27）──────────────────────────────────
//
// 「只对当前切片写集内的路径」放开。两条都要满足：
//
//   1. 路径在**本次判定的写集内**（`ctx.writes`）—— 否则是越界，
//      无论用户怎么授权都不行；
//   2. 路径在**用户配置的白名单**里（`alwaysAllowPaths`）——
//      缺省为空 = **关闭**。用户说「不重要的模块可以打开」，
//      那他就得在配置里明确列出那些模块。
//
// 白名单**缺省关闭**是关键：默认行为与现在完全一致（永不放开），
// 打开是**用户的显式动作**。

import { pathInWriteSet, relativizeTarget, type PreToolContext } from './pretool.js';

/**
 * 授权判定的结果。
 *
 * - `eligible` —— 可以问人「以后都允许吗」
 * - `notInWriteSet` —— 路径不在写集内 → **永远不能放开**
 * - `notInAllowlist` —— 不在用户配置的白名单 → **不能放开**（缺省关闭）
 * - `noPath` —— 判不出路径 → 不能放开
 */
export type AlwaysGrantDecision =
  | { eligible: true; path: string }
  | { eligible: false; reason: 'no-path' | 'not-in-write-set' | 'not-in-allowlist'; path: string | null };

/**
 * 路径是否落在用户配置的白名单里。
 *
 * 白名单的条目可以是：
 *
 *   - **精确路径**（`src/gen/schema.ts`）
 *   - **目录前缀**（`src/gen/` → 整个目录）
 *   - **glob**（`src/**`、`src/*.ts`）
 *
 * 与 `pathInWriteSet` 同一套匹配口径（`core/pathspec` 的 pathInWriteSet
 * 在 hook 里独立复刻了一份，见 pretool.ts 的同名函数）。
 */
export function pathInAllowlist(path: string, allowlist: string[]): boolean {
  for (const raw of allowlist) {
    if (typeof raw !== 'string') continue;
    const pattern = raw.trim().replace(/\\/g, '/');
    if (!pattern) continue;
    if (pattern.includes('*')) {
      // glob —— 借用写集匹配的同一套 glob 判定。
      // 写集匹配在 pathInWriteSet 里，这里复用它的逻辑：
      // 用 pathInWriteSet 传单条 pattern 即可（它是逐条 OR 的）。
      if (pathInWriteSet(path, [pattern])) return true;
      continue;
    }
    const dir = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
    if (!dir.includes('*') && (path === dir || path.startsWith(`${dir}/`))) {
      return true;
    }
  }
  return false;
}

/**
 * 判断某次写入**能不能**被授予「以后都允许」。
 *
 * @param targets — 本次判定的写入目标（相对 worktree 的 posix 路径）
 * @param ctx — 判定上下文（写集预约、保护域、策略、worktree 根）
 * @param allowlist — 用户配置的白名单（`agent.acp.alwaysAllowPaths`）
 */
export function judgeAlwaysGrant(
  targets: string[],
  ctx: PreToolContext,
  allowlist: string[] | undefined,
): AlwaysGrantDecision {
  // 缺省关闭 —— 白名单没配就**永远不能放开**。
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    return { eligible: false, reason: 'not-in-allowlist', path: null };
  }

  // 只认**单个**目标。多目标（一条命令写了几个文件）时，
  // 「以后都允许」的语义说不清是哪些 —— 不猜，不放开。
  if (targets.length !== 1) {
    return { eligible: false, reason: 'no-path', path: null };
  }

  const target = targets[0];

  // 越界（写到 worktree 之外）—— 无论用户怎么授权都不行。
  const rel = relativizeTarget(target, ctx.worktreeRoot);
  if (rel === null) {
    return { eligible: false, reason: 'not-in-write-set', path: target };
  }

  // 必须在**本次判定的写集内**。
  //
  // 注意 `ctx.writes === null` 的含义是「没有生效中的写集预约」——
  // 那时判定内核已经按 fail closed 拒绝了，这里也**不能**放开。
  if (!Array.isArray(ctx.writes) || ctx.writes.length === 0) {
    return { eligible: false, reason: 'not-in-write-set', path: rel };
  }
  if (!pathInWriteSet(rel, ctx.writes)) {
    return { eligible: false, reason: 'not-in-write-set', path: rel };
  }

  // 必须在**用户配置的白名单**里。
  if (!pathInAllowlist(rel, allowlist)) {
    return { eligible: false, reason: 'not-in-allowlist', path: rel };
  }

  return { eligible: true, path: rel };
}
