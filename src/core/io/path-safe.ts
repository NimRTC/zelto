/**
 * path-safe.ts —— 路径包含性原语
 *
 * ## 为什么需要它
 *
 * zelto 到处把**标识符**拼进路径：切片 id 进 `.zelto/slices/<id>.json`、
 * 进 `specs/slices/<id>.md`、进 `tests/acceptance/<id>/`、进
 * `.zelto/worktrees/<id>/`；版本 label 进 `.zelto/version-worktrees/<label>/`。
 *
 * 标识符里有 `..` 时，`join()` 会把它**归一化掉**，于是路径逃出本该在的目录：
 *
 * ```
 * join('.zelto/worktrees', '../../evil')  →  '<repo>/evil'
 * join('.zelto/slices',    '../evil.json') →  '<repo>/.zelto/evil.json'
 * ```
 *
 * 后果不是「目录建歪了」，而是**写与删落在仓库根之外**：
 * worktree 会被建到仓库外，验收目录会被建到仓库外，
 * `rmSync(dest, { recursive: true, force: true })` 会删到仓库外。
 *
 * 切片 id 在 CLI 入口有白名单（`/^[a-zA-Z0-9_-]+$/`），版本 label 没有——
 * 那是同一个缺陷家族里唯一还开着口的地方。本原语把「拼出来的路径必须在
 * 指定的 base 之内」这件事变成**一处**判定，各调用方不再各写各的。
 *
 * ## 与既有校验的关系
 *
 * 两层，缺一不可：
 *
 * 1. **白名单**（`core/version/branch.ts` 的 `isValidVersionLabel`）：
 *    在入口就拒掉不该出现的字符，报错信息直接告诉人「label 不合法」。
 * 2. **包含性**（本文件）：即使白名单漏了、或标识符来自 LLM 产出、
 *    或将来新增了别的标识符来源，**拼出来的路径也不会逃出 base**。
 *
 * 第 2 层不依赖第 1 层，第 1 层也不依赖第 2 层 —— 这是有意的。
 *
 * ## 不变量
 *
 * - C1：状态只在文件里 —— 本文件只做路径计算，不写任何东西。
 * - C2：只用 Node 内置模块，零第三方运行时依赖。
 * - C3：纯路径计算，不调模型、不触网。
 */

import { isAbsolute, join, relative, resolve } from 'node:path';

/** 路径逃出指定 base 时抛出的异常 */
export class PathEscapeError extends Error {
  /** 出问题的原始标识符 */
  readonly identifier: string;

  constructor(identifier: string, base: string, resolved: string) {
    super(
      `路径逃逸：标识符 "${identifier}" 拼出的路径落在 "${base}" 之外（归一化后为 "${resolved}"）`,
    );
    this.name = 'PathEscapeError';
    this.identifier = identifier;
  }
}

/**
 * 把标识符拼进 base 目录，并保证结果**仍在 base 之内**。
 *
 * 拼接用 `join` 而不是 `resolve`：`join` 保留 base 原本的形态
 * （`/repo` 就还是 `/repo`，不会被强行变成 `D:\repo`）。
 * 判定用 `resolve` —— 归一化之后才谈得上「在不在里面」。
 *
 * @param base - 允许落脚的目录
 * @param identifier - 标识符（切片 id / 版本 label）
 * @returns base 下的路径（形态与 `join(base, identifier)` 一致）
 * @throws 标识符会让路径逃出 base 时抛 `PathEscapeError`
 */
export function resolveWithin(base: string, identifier: string): string {
  // 拼接：与旧的 `join(base, identifier)` 行为完全一致
  const joined = join(base, identifier);

  // 判定：归一化之后再比
  const normalizedBase = resolve(base);
  const resolved = resolve(joined);

  // 判据用 `relative` 而不是字符串前缀：
  // 前缀判据会把 `C:\repo-evil` 误判成 `C:\repo` 的子目录
  // （`C:\repo-evil`.startsWith(`C:\repo`) 为真）——
  // 这正是「看起来在 base 里、其实在隔壁目录」的经典形状。
  const rel = relative(normalizedBase, resolved);

  // 逃逸的两种形态：
  //   - `rel` 以 `..` 开头 → 真的出去了
  //   - `rel` 是绝对路径 → 换了盘符/根（Windows 上 `relative` 跨盘返回绝对路径）
  const escapes = rel.startsWith('..') || isAbsolute(rel);

  if (escapes) {
    throw new PathEscapeError(identifier, normalizedBase, resolved);
  }
  return joined;
}

/**
 * 标识符拼出的路径是否仍在 base 之内（不抛错的判据版）。
 *
 * 给「已经算好路径、只想确认一下」的场景用。
 */
export function isWithin(base: string, identifier: string): boolean {
  try {
    resolveWithin(base, identifier);
    return true;
  } catch {
    return false;
  }
}
