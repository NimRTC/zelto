// Version runtime — 版本工作目录、基点、依赖与跨版本冲突
//
// ADR-056：版本成为 git 的一等分支实体。
//
// 这一层负责三件事：
// 1. **准备版本工作目录** —— 建 `version/<label>` 分支与它的集成目录
// 2. **算基点** —— D1-A / D2-A：
//    - 无前置版本 → 从主干 HEAD 建（D1-A：基点可复现，不随依赖链改动漂移）
//    - 有前置版本 → 从**前置版本的分支 tip** 建（D2-A：否则 dependsOn 是假的依赖）
//    - 基点在第一次确定时**钉死**进版本计划，之后不重算 —— 这才是 D1 想要的「可复现」
// 3. **跨版本冲突检测** —— D5-B：检出冲突时提示但不阻断
//
// C3: 确定性 —— git 调用 + 字符串运算 + glob 匹配，不调模型、不触网
// C6: cli/ 层，不涉及 core/ 的依赖方向

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { Version, VersionPlan } from '../../core/version/types.js';
import {
  branchOfVersion,
  versionBranchName,
  versionTagName,
  versionWorktreeRelativePath,
} from '../../core/version/branch.js';
import {
  detectCrossVersionConflicts,
  type CrossVersionConflict,
  type VersionWriteSet,
} from '../../core/sched/cross-version.js';
import { prepareVersionDependencies } from '../../core/worktree/dependencies.js';
import type { WorktreeInfo } from '../../core/worktree/index.js';

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function git(args: string[], cwd: string): GitResult {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout, stderr: '' };
  } catch (err) {
    const e = err as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    return {
      ok: false,
      stdout: e.stdout ? String(e.stdout) : '',
      stderr: e.stderr ? String(e.stderr) : (e.message ?? ''),
    };
  }
}

/** 分支是否存在 */
export function branchExists(branch: string, repoRoot: string): boolean {
  return git(['rev-parse', '--verify', `refs/heads/${branch}`], repoRoot).ok;
}

/**
 * 这个路径在两个 ref 之间**有没有变化**？
 *
 * 用途（ADR-056 真实项目验证）：合并前的「工作区必须干净」守卫要判断
 * 「这条未提交改动能不能豁免」。
 *
 * `.zelto/` 下的运行时状态在有些项目里是**签进 git** 的（状态入库，
 * 跨机器同步）。zelto 自己写这些文件（`updatedAt` 变动、stall 重置），
 * 它们会以「未提交改动」的形式出现 —— 但那不是「人改了代码没提交」。
 *
 * 豁免的前提是**合并不会碰它**：
 * - 目标 ref 上同一个路径没变 → 合并不会碰 → 可以豁免
 * - 目标 ref 上同一个路径变了 → 合并会真冲突 → **必须拦**
 *
 * 判定用 `git diff --name-only <from> <to> -- <path>`。
 * 判定不出来（ref 不存在等）时**保守返回 true**（即「变了」）——
 * 宁可多拦一次，不要让真冲突溜过去。
 */
export function pathDiffersBetweenRefs(
  path: string,
  fromRef: string,
  toRef: string,
  repoRoot: string,
): boolean {
  const res = git(['diff', '--name-only', fromRef, toRef, '--', path], repoRoot);
  if (!res.ok) return true;
  return res.stdout.trim().length > 0;
}

/**
 * 这个路径在「目标 ref」与**任何一个待合分支**之间有没有变化？
 *
 * 只要有**一个**待合分支动了这个路径，合并就会碰它 → 必须拦。
 * 全都没动 → 合并碰不到 → 可以豁免。
 */
export function pathDiffersFromAnyRef(
  path: string,
  targetRef: string,
  candidateRefs: string[],
  repoRoot: string,
): boolean {
  for (const ref of candidateRefs) {
    if (pathDiffersBetweenRefs(path, targetRef, ref, repoRoot)) return true;
  }
  return false;
}



/** 取分支 tip */
export function branchTip(branch: string, repoRoot: string): string | null {
  const res = git(['rev-parse', '--verify', `${branch}^{commit}`], repoRoot);
  if (!res.ok) return null;
  return res.stdout.trim() || null;
}

/** 主干 HEAD 的 commit */
export function headCommit(repoRoot: string): string | null {
  const res = git(['rev-parse', 'HEAD'], repoRoot);
  if (!res.ok) return null;
  return res.stdout.trim() || null;
}

/**
 * 算版本的基点（D1-A + D2-A）。
 *
 * @param version 本版本
 * @param plan 版本计划（用于找前置版本）
 * @param repoRoot 仓库根
 * @returns 基点 commit；null 表示算不出来
 */
export function resolveVersionBaseCommit(
  version: Version,
  plan: VersionPlan,
  repoRoot: string,
): { commit: string | null; source: string } {
  // 前置版本 → 从前置版本的分支 tip 建（D2-A）
  for (const dep of version.dependsOn) {
    const depVersion = plan.versions.find((v) => v.version === dep);
    if (!depVersion) continue;
    const depBranch = branchOfVersion(depVersion);
    const tip = branchTip(depBranch, repoRoot);
    if (tip) {
      return { commit: tip, source: `前置版本 ${dep} 的分支 ${depBranch}` };
    }
  }
  // 版本自己显式钉了基点 → 用它（D1-A：人指定的起点优先于「主干 HEAD」的默认）
  //
  // 为什么需要这一条（实测：nimrtc 1.4 演练）：版本要接在一条**不是主干的
  // 分支**上（`feat/v14-turn-tls`，且远端就是终态目标）。而 `version/<label>`
  // 建起来之后，pin 进来的这个提交本身不再是分支 tip —— 只能靠计划里的
  // `baseCommit` 记住「从哪来」。没有这一条，基点永远退回主干 HEAD，
  // 正好是「从 main 拉」这个被明确排除的起点。
  const pinned = version.baseCommit && version.baseCommit.trim();
  if (pinned) {
    const resolved = git(['rev-parse', '--verify', `${pinned}^{commit}`], repoRoot);
    if (resolved.ok && resolved.stdout.trim()) {
      return { commit: resolved.stdout.trim(), source: `版本计划里钉死的基点 ${pinned.slice(0, 10)}` };
    }
    // 钉了但解析不出来 —— 不静默退回主干：那会悄悄换掉起点
    return {
      commit: null,
      source: `版本计划里钉死的基点 ${pinned.slice(0, 10)} 在仓库里解析不出来`,
    };
  }
  // 无前置版本、无钉死基点 → 从主干 HEAD 建（D1-A）
  const head = headCommit(repoRoot);
  return { commit: head, source: '主干 HEAD' };
}

/** 版本工作目录准备的结果 */
export interface VersionWorkspace {
  /** 工作目录信息 */
  worktree: WorktreeInfo | null;
  /** 实际使用的基点 */
  baseCommit: string | null;
  /** 基点来源（面向人） */
  baseSource: string;
  /** 依赖准备的结果说明 */
  dependencyNote: string | null;
  /** 失败原因 */
  error: string | null;
}

/**
 * 准备版本工作目录。
 *
 * 步骤：
 * 1. 算基点（前置版本 tip 或主干 HEAD）
 * 2. 建/复用 `version/<label>` 分支与集成目录
 * 3. 依赖准备（D4-C）：锁文件一致就链接主仓那份，不一致就独立装
 */
export async function prepareVersionWorkspace(
  version: Version,
  plan: VersionPlan,
  options: {
    repoRoot: string;
    manager: {
      versionPathFor(label: string): string;
      versionRelativePathFor(label: string): string;
      versionExists(label: string): boolean;
      createVersionWorktree(
        label: string,
        opts: { branch: string; baseCommit?: string | null },
      ): Promise<WorktreeInfo>;
    };
    /** 干跑：只判定不建目录 */
    dryRun?: boolean;
  },
): Promise<VersionWorkspace> {
  const branch = branchOfVersion(version);
  const { commit, source } = resolveVersionBaseCommit(version, plan, options.repoRoot);

  if (!commit) {
    return {
      worktree: null,
      baseCommit: null,
      baseSource: source,
      dependencyNote: null,
      error: `算不出版本 "${version.version}" 的基点 —— 仓库里读不到 HEAD。`,
    };
  }

  // 前置版本存在但分支还没建 —— 说清楚，别让它悄悄退回主干
  for (const dep of version.dependsOn) {
    const depVersion = plan.versions.find((v) => v.version === dep);
    if (!depVersion) continue;
    const depBranch = branchOfVersion(depVersion);
    if (!branchExists(depBranch, options.repoRoot)) {
      return {
        worktree: null,
        baseCommit: null,
        baseSource: source,
        dependencyNote: null,
        error:
          `前置版本 "${dep}" 的分支 "${depBranch}" 还不存在。\n` +
          `   先把 ${dep} 跑到 integrated（切片全部合入 ${depBranch}），` +
          `否则 "${version.version}" 看不到它的改动，依赖是假的。`,
      };
    }
  }

  if (options.dryRun) {
    return {
      worktree: null,
      baseCommit: commit,
      baseSource: source,
      dependencyNote: null,
      error: null,
    };
  }

  // 建/复用工作目录
  let worktree: WorktreeInfo;
  try {
    worktree = await options.manager.createVersionWorktree(version.version, {
      branch,
      baseCommit: commit,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      worktree: null,
      baseCommit: commit,
      baseSource: source,
      dependencyNote: null,
      error: `创建版本工作目录失败：${msg}`,
    };
  }

  // 依赖准备（D4-C）
  let dependencyNote: string | null = null;
  const dep = prepareVersionDependencies({
    repoRoot: options.repoRoot,
    worktreePath: worktree.path,
  });
  if (dep.error) {
    dependencyNote = `⚠️  ${dep.error}`;
  } else if (dep.strategy === 'install') {
    dependencyNote = `依赖：${dep.reason}`;
  } else {
    dependencyNote = `依赖：${dep.reason}`;
  }

  return { worktree, baseCommit: commit, baseSource: source, dependencyNote, error: null };
}

/**
 * 跨版本冲突检测（D5-B）。
 *
 * 把本版本的写集与**其它 in_progress 版本**的写集比。
 *
 * @param currentVersion 本版本 label
 * @param versions 各版本的写集（由调用方从切片文件收集）
 */
export function detectCrossVersionConflictsFor(
  currentVersion: string,
  versions: VersionWriteSet[],
): CrossVersionConflict[] {
  // 本版本**必须留在列表里** —— 两两比对要拿它跟别人比。
  // 之前把它排除掉了，结果列表里只剩别人，两两之间没有可比的一对，
  // 于是永远检不出冲突。
  //
  // 排除的是「同一个版本被重复收集」——按 label 去重，保留一份。
  const deduped = new Map<string, VersionWriteSet>();
  for (const v of versions) {
    if (!deduped.has(v.version)) deduped.set(v.version, v);
  }
  return detectCrossVersionConflicts([...deduped.values()]);
}

/**
 * 把跨版本冲突打印成人能读的样子。
 *
 * **必须**说清楚这是启发式判断 —— 不能让人以为「跨版本也安全了」。
 */
export function formatCrossVersionConflicts(conflicts: CrossVersionConflict[]): string[] {
  if (conflicts.length === 0) return [];
  const lines: string[] = [];
  const errors = conflicts.filter((c) => c.severity === 'error');
  const rest = conflicts.filter((c) => c.severity !== 'error');

  if (errors.length > 0) {
    lines.push(`⚠️  与其它在跑的版本有 ${errors.length} 处高风险重叠：`);
    for (const c of errors) {
      lines.push(`   - ${c.description}`);
    }
    lines.push('');
    lines.push('   两个版本并行改同一批文件，后合的那个会覆盖先合的。');
  }
  if (rest.length > 0) {
    lines.push(`ℹ️  另有 ${rest.length} 处较低风险重叠：`);
    for (const c of rest) {
      lines.push(`   - ${c.description}`);
    }
  }
  lines.push('');
  lines.push('   注意：这是**基于写集与工件命名**的启发式判断 ——');
  lines.push('   它挡得住「两个版本都改 types.ts」，挡不住「一个版本改了语义、另一个按旧语义写」。');
  lines.push('   那类问题要到合并或版本级验收时才暴露。');
  return lines;
}

/** 版本分支名（对外暴露，CLI 层用） */
export { branchOfVersion, versionBranchName, versionTagName, versionWorktreeRelativePath };

/** 版本计划目录 */
export function versionsDir(zeltoDir: string): string {
  return join(zeltoDir, 'versions');
}
