// 驾驶舱的「根」发现 —— 一个仓库里可能有几份 zelto 状态（ADR-112）
//
// 为什么需要它：
//
//   ADR-056 把版本变成 git 的一等分支之后，每个版本有自己独立的集成目录
//   `.zelto/version-worktrees/<label>/`，那里面的 `.zelto/` 是一份**完整的**
//   zelto 状态 —— 切片、事件、签字请求、规格、验收目录全在。
//
//   驾驶舱过去只读 `repoRoot/.zelto`（`zelto web` 的 `process.cwd()`），
//   于是「版本目录里真正的开发进度」一片都看不见。
//   实测（nimrtc-v14，2026-11-25）：根上 8 片（3 基线 + 5 旧开发），
//   v3 目录里 15 片 —— 驾驶舱只显示前者，而后者里有两片正卡在 frozen 等人签字。
//
// 判据是**纯文件事实**（C3）：
//
//   - 仓库根永远算一个根（只要有 `.zelto/`）；
//   - `.zelto/version-worktrees/<label>/` 下有 `.zelto/slices` 或 `.zelto/events`
//     才算一个根 —— 没有的目录不列（空目录不是状态）。
//
// 刻意**不**扫 `.zelto/worktrees/<sliceId>/`（切片执行目录）：
//   那里的 `.zelto/slices/` 只是建 worktree 时同步进去的**基线快照**
//   （实测：`v1-install-tree-module-closure` 的 worktree 里只有那 3 片基线，
//   状态与根目录一模一样）。扫进去只会制造三份假副本，
//   让人以为「同一片有三个不同的状态」。
//
// C1: 只读文件，不写任何东西
// C2: 只用 Node 内置
// C3: 纯判定 —— 不调模型、不触网；排序稳定（同一棵树两次扫描结论一致）

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isValidVersionLabel } from '../version/branch.js';

/** 一个根的种类。 */
export type CockpitScope = 'root' | 'version';

/** 驾驶舱扫描到的一个「根」—— 一个装着 `.zelto/` 的目录。 */
export interface CockpitRoot {
  /** `root` = 仓库根；`version` = 版本集成目录 */
  scope: CockpitScope;
  /** 版本 label（`scope === 'version'` 时非空） */
  label: string | null;
  /** 根目录的绝对路径（`.zelto/` 的父目录） */
  dir: string;
}

/** 版本集成目录的父目录（相对仓库根）—— 与 `core/worktree/manager.ts` 同源。 */
export const VERSION_WORKTREES_REL = join('.zelto', 'version-worktrees');

/**
 * 切片执行目录的父目录（相对仓库根）—— 与 `core/worktree/manager.ts` 的
 * `WORKTREE_BASE_DIR` 同源。
 *
 * 这里**只列出、不扫描成根**：执行目录里的 `.zelto/slices/` 是基线快照
 * （见上面的说明）。驾驶舱用它在「执行目录」那一层展示「哪几条战线在跑」，
 * 不用它读切片状态。
 */
export const WORKTREES_REL = join('.zelto', 'worktrees');

/** 一个目录里存不存在「zelto 状态」（`.zelto/slices` 或 `.zelto/events`）。 */
function hasZeltoState(dir: string): boolean {
  const zeltoDir = join(dir, '.zelto');
  if (!existsSync(zeltoDir)) return false;
  return existsSync(join(zeltoDir, 'slices')) || existsSync(join(zeltoDir, 'events'));
}

/** 是不是一个目录（读不到就当不是 —— 判据不该被权限异常打断）。 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 发现驾驶舱该扫的所有根。
 *
 * 顺序是**固定**的（`root` 在前，版本按 label 字典序）——
 * 调用方可以据此做稳定的呈现，测试也可以逐条断言。
 *
 * @param repoRoot 仓库根（`zelto web` 的 cwd）
 */
export function discoverCockpitRoots(repoRoot: string): CockpitRoot[] {
  const roots: CockpitRoot[] = [
    { scope: 'root', label: null, dir: repoRoot },
  ];

  const base = join(repoRoot, VERSION_WORKTREES_REL);
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    // 没有版本工作目录 —— 老项目零行为变化
    return roots;
  }

  const labels = entries
    // label 会作为 `.zelto/version-worktrees/<label>` 的一段路径。
    // 非法 label（含 `..`、空格、路径分隔符）不列 —— 它们本来就建不出来，
    // 万一盘上有这个名字，也不该被驾驶舱当成一个根去读。
    .filter((name) => isValidVersionLabel(name))
    .filter((name) => isDirectory(join(base, name)))
    .filter((name) => hasZeltoState(join(base, name)))
    .sort();

  for (const label of labels) {
    roots.push({ scope: 'version', label, dir: join(base, label) });
  }

  return roots;
}

/**
 * 这个 scope/label 组合是不是「仓库根」。
 *
 * 给调用方做分支用：`scope === 'root'` 时 store 直接挂在 `repoRoot/.zelto` 下，
 * 与改造前的行为**逐字一致**。
 */
export function isRootScope(scope: CockpitScope | undefined, label: string | null | undefined): boolean {
  return scope === undefined || scope === 'root' || !label;
}
