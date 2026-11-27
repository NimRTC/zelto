// 路径 containment 的符号链接感知解析（ADR-134）
//
// 词法归一化（relativizeTarget）看不见符号链接：worktree 内一个指向外部的
// junction/symlink 就能让「词法上在 worktree 内」的路径落到 worktree 外，
// 逃逸 / 保护域 / 写集三条检查同时失效。
//
// 这里提供 realpath 感知的 canonical 解析：先逐级向上找到第一个存在的祖先、
// 对它做 realpath，再把不存在的后缀接回去（新建文件不因「不存在」而误拒）；
// realpath 失败一律不猜、不 fallback 到词法（fail closed，ADR-134 决策三）。
//
// C2：只用 Node 内置（node:fs / node:path），零第三方依赖。

import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * 单次判定批次内的祖先 realpath 缓存（ADR-134 决策四）。
 *
 * 键 = 目录绝对路径，值 = 该目录的 realpath；null = 解析失败。
 * 只在单次 `judgeWriteTargets()` 调用内有效 —— 判定结束即失效，
 * 不跨调用缓存（跨调用会引入「目录中途被换成 symlink」的时序问题）。
 */
export type AncestorRealpathCache = Map<string, string | null>;

/** 新建一次判定批次的祖先缓存。 */
export function createAncestorRealpathCache(): AncestorRealpathCache {
  return new Map();
}

/**
 * containment 判定的三分结果。
 *
 * - `inside` —— canonical 后落在 worktree 内，`rel` 是相对 worktree 的
 *   posix 路径（保护域 / 写集 / 策略判定统一用它）；
 * - `escape` —— canonical 后落在 worktree 外（真越界）；
 * - `unresolvable` —— realpath 解析失败（非 ENOENT 错误，或悬空的链接）。
 *
 * 两种拒绝共用 `ruleId: 'protected:0a'`，但 reason 必须能区分（ADR-134）。
 */
export type ContainmentOutcome =
  | { kind: 'inside'; rel: string }
  | { kind: 'escape' }
  | { kind: 'unresolvable' };

function isErrno(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && 'code' in e && typeof e.code === 'string';
}

/** Windows 的 realpath 可能返回 `\\?\` 前缀的长路径 —— 剥掉再比较。 */
function stripLongPathPrefix(p: string): string {
  if (p.startsWith('\\\\?\\UNC\\')) return p.slice(8);
  if (p.startsWith('\\\\?\\')) return p.slice(4);
  return p;
}

/**
 * 把写入目标转成绝对路径。
 *
 * **不词法折叠 `..`**：POSIX 的 realpath 会先解析符号链接再解析 `..`，
 * 词法折叠会让 `symlink/..` 的逃逸被隐藏（ADR-134 参照实现要点 1）。
 * Windows 上 realpath 的 Win32 归一化行为与真实写入一致，折叠与否结果相同。
 */
function toAbsolutePreservingDotDot(target: string, worktreeRoot: string): string {
  if (isAbsolute(target)) return target;
  const root = worktreeRoot.endsWith('/') || worktreeRoot.endsWith('\\') ? worktreeRoot : worktreeRoot + sep;
  return root + target;
}

/**
 * 解析真实落点（绝对路径），逐级向上找第一个存在的祖先。
 *
 * 返回绝对 canonical 路径；`null` = 无法解析：realpath 抛非 ENOENT 错误
 * （ELOOP / EACCES / …），或目标是一个悬空的符号链接/junction
 * （链接在、目标不在 —— 解析不出真实落点）。
 *
 * 缓存在单次判定批次内共享：多个写目标共享同一父目录时只 realpath 一次。
 */
function realpathCanonicalize(absPath: string, cache: AncestorRealpathCache): string | null {
  let candidate = absPath;
  const missingSuffix: string[] = [];

  for (;;) {
    const cached = cache.get(candidate);
    if (cached !== undefined) {
      if (cached === null) return null;
      return resolve(cached, ...missingSuffix);
    }

    let real: string;
    try {
      real = stripLongPathPrefix(realpathSync.native(candidate));
    } catch (err) {
      if (!isErrno(err) || err.code !== 'ENOENT') return null;
      // realpath 说「这一级不存在」：可能是真的不存在（往上找父目录），
      // 也可能是一个悬空的符号链接/junction —— 后者解析不出真实落点，拒绝。
      try {
        lstatSync(candidate);
        return null;
      } catch (err2) {
        if (!isErrno(err2) || err2.code !== 'ENOENT') return null;
      }
      const parent = dirname(candidate);
      if (parent === candidate) return null;
      missingSuffix.unshift(basename(candidate));
      candidate = parent;
      continue;
    }

    cache.set(candidate, real);
    return resolve(real, ...missingSuffix);
  }
}

/**
 * worktree 根的 canonical 绝对路径。
 *
 * worktree 根是受信边界（来自配置，不是 agent 输入）；解析不出来时
 * 退回词法绝对路径 —— 逃逸判定主要看**目标**的 canonical 落点。
 */
function canonicalRootOf(worktreeRoot: string, cache: AncestorRealpathCache): string {
  const abs = isAbsolute(worktreeRoot) ? worktreeRoot : resolve(worktreeRoot);
  return realpathCanonicalize(abs, cache) ?? abs;
}

/**
 * 符号链接感知的 containment 判定（ADR-134 决策二）。
 *
 * 三条 containment 检查（逃逸 / 保护域 / 写集）统一基于这里产出的
 * canonical 相对路径 —— 词法路径会被 junction/symlink 绕过，canonical 不会。
 */
export function canonicalContainment(
  target: string,
  worktreeRoot: string,
  cache: AncestorRealpathCache = createAncestorRealpathCache(),
): ContainmentOutcome {
  const canonicalTarget = realpathCanonicalize(toAbsolutePreservingDotDot(target, worktreeRoot), cache);
  if (canonicalTarget === null) return { kind: 'unresolvable' };
  const canonicalRoot = canonicalRootOf(worktreeRoot, cache);
  const rel = toPosix(relative(canonicalRoot, canonicalTarget));
  // `rel === ''` 是目标即 worktree 根本身；`isAbsolute(rel)` 覆盖 Windows 上
  // 跨盘符（junction 指向另一驱动器）时 relative 返回绝对路径的情况。
  if (rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    return { kind: 'escape' };
  }
  return { kind: 'inside', rel };
}

/**
 * 返回相对 worktree 的 canonical 路径（posix 分隔符）；
 * 逃逸 / 无法解析统一返回 null（两种都拒绝，理由由调用方区分）。
 */
export function canonicalizeForContainment(
  target: string,
  worktreeRoot: string,
  cache: AncestorRealpathCache = createAncestorRealpathCache(),
): string | null {
  const outcome = canonicalContainment(target, worktreeRoot, cache);
  return outcome.kind === 'inside' ? outcome.rel : null;
}

/** 把路径统一成正斜杠（与 protected.ts 同口径）。 */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}
