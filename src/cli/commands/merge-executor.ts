// Merge executor — 把 MergePlan 落到 git 上
//
// C3: 策略选择来自 core/sched/merge.ts 的 MergePlanner（确定性），此处只执行、不判定
// C4: 每个动作写 append-only 事件，且事件按**真实切片 id** 落盘，保证审计可追溯
// C6: core/ 不 import adapters/（本文件在 cli/ 层，不涉及 core 依赖方向）
//
// 见 docs/adr-012-parallel-coordination.md §3.4

import { execFileSync } from 'node:child_process';
import type { EventStream } from '../../core/events/stream.js';
import type { MergePhase, MergePlan } from '../../core/sched/merge.js';

/** 参与合并的切片信息 */
export interface MergeSliceInfo {
  id: string;
  /** 分支名，通常为 `slice/<id>` */
  branch: string;
  /** 切片冻结时的基点 commit —— 用于判定 base 是否已漂移 */
  baseCommit: string | null;
}

export interface MergeExecutorOptions {
  events: EventStream;
  /** 主仓库根目录 */
  repoRoot?: string;
  /** 输出回调 */
  log?: (message: string) => void;
}

export interface MergeConflictReport {
  sliceId: string;
  files: string[];
  message: string;
}

export interface MergeExecutionResult {
  /** 成功合入的切片 id */
  merged: string[];
  /** 冲突详情 */
  conflicts: MergeConflictReport[];
  /** base 已漂移、因而改用合并提交的切片 id */
  staleBase: string[];
  /** 是否因冲突而中止 */
  aborted: boolean;
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * 执行 git 命令。退出码非 0 时不抛异常，返回 ok=false。
 *
 * `git merge-base --is-ancestor` 这类命令正是用退出码表达布尔结果，
 * 因此这里不能把非 0 当成异常。
 */
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

/** commit 是否存在于仓库中 */
export function commitExists(commit: string, repoRoot: string): boolean {
  return git(['rev-parse', '--verify', `${commit}^{commit}`], repoRoot).ok;
}

/** 分支是否存在 */
export function branchExists(branch: string, repoRoot: string): boolean {
  return git(['rev-parse', '--verify', `refs/heads/${branch}`], repoRoot).ok;
}

/**
 * 分支是否已经合入当前 HEAD。
 *
 * 用来判断某个切片的产物是否已经被合并过——已合并的切片不该再次参与合并。
 */
export function isMergedIntoHead(branch: string, repoRoot: string): boolean {
  return git(['merge-base', '--is-ancestor', branch, 'HEAD'], repoRoot).ok;
}

/**
 * 基点是否已漂移：切片冻结之后主分支已经前进。
 *
 * 判据是「基点是否仍等于当前 HEAD」——主分支前进后 HEAD 与基点不再相同，
 * 此时切片分支不再包含主分支的新提交，fast-forward 不再可能，必须走合并提交。
 *
 * 注意不能用「base 是否还是 HEAD 的祖先」来判：主分支正常前进时 base 永远是
 * HEAD 的祖先，那样判据永远为假，`merge.stale_base` 就永远不会触发。
 */
export function isStaleBase(baseCommit: string | null, repoRoot: string): boolean {
  if (!baseCommit) return false;
  if (!commitExists(baseCommit, repoRoot)) return false;
  const head = headCommit(repoRoot);
  if (!head) return false;
  return head !== baseCommit;
}

/**
 * 是否可以 fast-forward：当前 HEAD 是不是该分支的祖先。
 *
 * HEAD 是分支的祖先 → 分支可以快进；否则两条历史已分叉。
 */
export function canFastForward(branch: string, repoRoot: string): boolean {
  return git(['merge-base', '--is-ancestor', 'HEAD', branch], repoRoot).ok;
}

/** 列出当前处于冲突中的文件 */
function conflictedFiles(repoRoot: string): string[] {
  const res = git(['diff', '--name-only', '--diff-filter=U'], repoRoot);
  if (!res.ok) return [];
  return res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** 当前 HEAD 的 commit 号 */
function headCommit(repoRoot: string): string | null {
  const res = git(['rev-parse', 'HEAD'], repoRoot);
  return res.ok ? res.stdout.trim() : null;
}

/**
 * 执行一个合并计划。
 *
 * 每个 phase 的执行策略：
 * - `sequential_ff`：逐个 `git merge --ff-only`。若基点已漂移或历史已分叉
 *   （其它切片先合入），fast-forward 不再可能，自动降级为 `--no-ff` 合并提交，
 *   并写 `merge.stale_base`。
 * - `merge_commit`：逐个 `git merge --no-ff`，每个分支一个合并提交。
 * - `manual` / `rebase_onto`：不自动执行，交由人工处理。
 *
 * 冲突时立即 `git merge --abort`，主分支回到合并前的可构建状态，
 * 并输出冲突文件清单——不删分支、不吞异常。
 */
export async function executeMergePlan(
  plan: MergePlan,
  slices: MergeSliceInfo[],
  options: MergeExecutorOptions,
): Promise<MergeExecutionResult> {
  const repoRoot = options.repoRoot ?? process.cwd();
  const log = options.log ?? (() => {});
  const byId = new Map(slices.map((s) => [s.id, s]));

  const merged: string[] = [];
  const conflicts: MergeConflictReport[] = [];
  const staleBase: string[] = [];

  // ── 前置守卫：主仓库工作区必须干净，否则合并会污染未提交改动 ──
  const status = git(['status', '--porcelain'], repoRoot);
  if (status.ok && status.stdout.trim().length > 0) {
    // 列出具体是什么挡着 —— 只说「有未提交改动」的话，人得自己去找。
    const dirty = status.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 10);
    log('  ⚠️  主仓库工作区有未提交改动，已跳过自动合并。');
    for (const d of dirty) log(`     ${d}`);
    if (dirty.length >= 10) log('     …（只列前 10 条）');
    log('     先提交（git commit）或暂存（git stash）这些改动，再重新跑 zelto merge。');
    log('     签字已经过了，不用重新签。');
    return { merged, conflicts, staleBase, aborted: false };
  }

  // ── 记录计划 ──
  const phaseSummary = plan.phases.map((p) => ({
    phase: p.phase,
    slices: p.slices,
    strategy: p.strategy,
  }));
  for (const id of plan.slices) {
    await options.events.append(id, 'merge.planned', 'zelto', {
      slices: plan.slices,
      strategy: plan.strategy,
      phases: phaseSummary,
    });
  }

  for (const phase of plan.phases) {
    if (phase.strategy === 'manual' || phase.strategy === 'rebase_onto') {
      log(`  ⏭️  Phase ${phase.phase}: 策略 "${phase.strategy}" 不自动执行，需人工处理。`);
      log(`     手动合并：git merge ${phase.slices.map((id) => byId.get(id)?.branch ?? id).join(' ')}`);
      continue;
    }
    await executePhase(phase, byId, repoRoot, log, options, merged, conflicts, staleBase);
  }

  // ── 记录完成 ──
  const commit = headCommit(repoRoot);
  for (const id of merged) {
    await options.events.append(id, 'merge.completed', 'zelto', {
      sliceId: id,
      slices: merged,
      strategy: plan.strategy,
      phases: plan.phases.length,
      mergeCommit: commit,
    });
  }

  return { merged, conflicts, staleBase, aborted: conflicts.length > 0 };
}

async function executePhase(
  phase: MergePhase,
  byId: Map<string, MergeSliceInfo>,
  repoRoot: string,
  log: (message: string) => void,
  options: MergeExecutorOptions,
  merged: string[],
  conflicts: MergeConflictReport[],
  staleBase: string[],
): Promise<void> {
  for (const id of phase.slices) {
    const info = byId.get(id);
    if (!info) {
      log(`  ❌ Phase ${phase.phase}: 切片 "${id}" 没有分支信息，已跳过。`);
      continue;
    }

    const branchExists = git(['rev-parse', '--verify', `refs/heads/${info.branch}`], repoRoot).ok;
    if (!branchExists) {
      log(`  ❌ ${id}: 分支 "${info.branch}" 不存在，无法合并。`);
      conflicts.push({ sliceId: id, files: [], message: `分支 "${info.branch}" 不存在` });
      await options.events.append(id, 'merge.conflict', 'zelto', {
        phase: phase.phase,
        sliceId: id,
        files: [],
        resolution: 'failed',
        message: `分支 "${info.branch}" 不存在`,
      });
      continue;
    }

    // 基点漂移检测：base 不再是 HEAD 的祖先 → 主分支已前进
    const stale = isStaleBase(info.baseCommit, repoRoot);
    const ff = phase.strategy === 'sequential_ff' && !stale && canFastForward(info.branch, repoRoot);
    const useMergeCommit = phase.strategy === 'merge_commit' || !ff;

    if (stale) {
      staleBase.push(id);
      await options.events.append(id, 'merge.stale_base', 'zelto', {
        sliceId: id,
        branch: info.branch,
        baseCommit: info.baseCommit,
        reason: '切片基点不再是当前 HEAD 的祖先，fast-forward 不可用',
      });
      log(`  ℹ️  ${id}: 基点已漂移，改用合并提交（--no-ff）。`);
    } else if (!ff && phase.strategy === 'sequential_ff') {
      log(`  ℹ️  ${id}: 历史已分叉，改用合并提交（--no-ff）。`);
    }

    const args = useMergeCommit
      ? ['merge', '--no-ff', info.branch, '-m', `Merge slice ${id}\n\nRefs-Slice: ${id}`]
      : ['merge', '--ff-only', info.branch];

    const res = git(args, repoRoot);
    if (!res.ok) {
      const files = conflictedFiles(repoRoot);
      // 合并失败：先把主仓库恢复到合并前的状态
      git(['merge', '--abort'], repoRoot);

      const message = res.stderr.trim() || res.stdout.trim() || '合并失败';
      await options.events.append(id, 'merge.conflict', 'zelto', {
        phase: phase.phase,
        sliceId: id,
        files,
        resolution: files.length > 0 ? 'conflict' : 'failed',
        message,
      });
      conflicts.push({ sliceId: id, files, message });
      log(`  ❌ ${id}: 合并失败，主分支已恢复原状。`);
      log(`     ${message.split('\n')[0]}`);
      if (files.length > 0) {
        log('     冲突文件：');
        for (const f of files) log(`       - ${f}`);
      }
      log(`     手动解决：git merge ${info.branch}`);
      return;
    }

    merged.push(id);
    await options.events.append(id, 'merge.phase_complete', 'zelto', {
      phase: phase.phase,
      sliceId: id,
      slices: [id],
      strategy: useMergeCommit ? 'merge_commit' : 'sequential_ff',
      branch: info.branch,
      mergeCommit: headCommit(repoRoot),
    });
    log(`  ✅ ${id} 已合入（${useMergeCommit ? '合并提交' : 'fast-forward'}）`);
  }
}
