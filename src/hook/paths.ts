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
 * 路径值的**形状判据**（ADR-136）。
 *
 * 判定内核拿到的「写入目标」最终是一个字符串。现在只检查「是不是非空字符串」，
 * 于是这些值会被当成路径塞进判定流程：
 *
 * | 值 | 实际是什么 | 词法归一化后的下场 |
 * |---|---|---|
 * | `~/../../etc/passwd` | agent 的 home 展开 | `~` 被当普通目录名 |
 * | `file:///etc/passwd` | URL | 变成 `<worktree>/file:/etc/passwd` → **落在写集内 → 放行** |
 * | `a\0b` | 含 NUL 字节 | fs 调用抛 `ERR_INVALID_ARG_VALUE` → **判定层崩掉** |
 * | `   ` | 纯空白 | 归一化后变成 `.` 或 worktree 根 |
 *
 * 参照 T3（`pingdotgg/t3code`，MIT）的 `acpCheckablePath()`，其注释里的
 * 论证是整条规则的根据：
 *
 * > may mean another file to the agent than it does when joined to the
 * > working directory
 *
 * ——「对 agent 来说可能指另一个文件，比拼起来之后指的文件不同」。
 * 判定的对象必须是「agent 真正会写的那个文件」，而不是「一个我们能归一化的字符串」。
 *
 * **与 T3 的差异**：T3 的第 5 条把**所有** `scheme:` 前缀都拒了，包括
 * Windows 盘符 `C:`。zelto 是**跨平台**的（Windows 上 `C:\foo` 是正常路径），
 * 所以第 5 条要排除盘符形态（`^[A-Za-z]:[\\/]`）。
 *
 * C2：只用 Node 内置，零第三方依赖。
 */
export function isCheckablePath(value: unknown): value is string {
  // 1. 不是字符串 —— 不指任何文件
  if (typeof value !== 'string') return false;

  // 2. trim 后为空 —— 同样不指任何文件
  if (value.trim().length === 0) return false;

  // 3. 含 NUL 字节 —— 路径里非法，fs 调用会抛（ADR-136 决策一）
  if (value.includes('\0')) return false;

  // 4. `~` 开头 —— 展开规则各 agent 不同（`~` vs `~/` vs Windows 的 `~\`），
  //    zelto 猜不出 agent 会展开成什么 → 不做 tilde 展开，就不判（AGENTS.md：
  //    「规格里没写的行为 → 停下来问，不许按『更合理』的直觉补全」）
  if (value.startsWith('~')) return false;

  // 5. URL scheme（`file://` / `http://` / …）—— 不是本地路径。
  //    Windows 盘符形态（`C:\` / `C:/`）要排除：那是正常的绝对路径。
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) && !/^[A-Za-z]:[\\/]/.test(value)) return false;

  // 6. POSIX 主机上的反斜杠 —— `a\b` 与 `a/b` 在 POSIX 上含义不同。
  //    Windows 上反斜杠是正常分隔符，放行。
  if (sep === '/' && value.includes('\\')) return false;

  return true;
}


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
