// Merge executor — 把 MergePlan 落到 git 上
//
// C3: 策略选择来自 core/sched/merge.ts 的 MergePlanner（确定性），此处只执行、不判定
// C4: 每个动作写 append-only 事件，且事件按**真实切片 id** 落盘，保证审计可追溯
// C6: core/ 不 import adapters/（本文件在 cli/ 层，不涉及 core 依赖方向）
//
// 见 docs/adr-012-parallel-coordination.md §3.4

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { EventStream } from '../../core/events/stream.js';
import type { MergePhase, MergePlan } from '../../core/sched/merge.js';
import {
  isZeltoManagedSpecPath,
  isZeltoStatePath,
} from '../../core/project/managed-paths.js';
import { parsePorcelainStatus, isSubmoduleOnlyDirty } from '../../core/sched/audit.js';
import { isUntouchedAcceptanceSkeleton } from '../../core/project/managed-acceptance.js';
import {
  branchOfVersion,
  readVersionPlans,
  resolveSliceOwnership,
} from '../../core/version/branch.js';
import { VersionStore } from '../../core/version/store.js';
import { pathDiffersFromAnyRef } from './version-runtime.js';

/** 参与合并的切片信息 */
export interface MergeSliceInfo {
  id: string;
  /** 分支名，通常为 `slice/<id>` */
  branch: string;
  /** 切片冻结时的基点 commit —— 用于判定 base 是否已漂移 */
  baseCommit: string | null;
  /**
   * 这个切片的写集路径（ADR-071 §3 D1）。
   *
   * **只有**「没有分支」的切片才需要它 —— 用来核实产物是否
   * 已经在目标分支上（空操作合并的判据）。
   */
  writes?: string[];
  /**
   * 是否是「产物已在目标分支」的空操作合并（ADR-071）。
   *
   * 为 true 时不执行 `git merge`（没什么可合的），
   * 但仍记 `merge.completed` 事件（mode: 'noop'）——
   * 追溯链不因为「这次没搬东西」而断。
   */
  noop?: boolean;
}

export interface MergeExecutorOptions {
  events: EventStream;
  /** 主仓库根目录 */
  repoRoot?: string;
  /**
   * 合并目标工作目录（ADR-056 §3.3）。
   *
   * 缺省 = repoRoot，也就是「合进主仓当前检出的分支」——
   * 改造前的行为，老调用方零改动。
   *
   * 合进版本分支时传版本工作目录；合进主干时传主仓。
   */
  targetDir?: string;
  /**
   * 合并目标的标识（写进事件 payload，便于审计）。
   *
   * 缺省 = 'main'。
   */
  targetLabel?: string;
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
  /**
   * 是否因冲突而中止
   *
   * **不只冲突**。工作区脏（未提交改动挡着）也是一种中止 ——
   * 见 `abortReason`。早期版本这里只表示「冲突」，而工作区脏的守卫
   * 返回 `aborted: false`，于是上层打印「✅ Merge complete (0 slices)」
   * 并退出 0 —— **合并根本没发生，工具却说成功了**（实测缺陷 D-11）。
   */
  aborted: boolean;
  /**
   * 中止原因（`aborted` 为 true 时有值）。
   *
   * 区分「冲突」与「工作区脏」：两者的排查方向完全不同 ——
   * 前者要解冲突，后者要先提交或暂存。
   */
  abortReason?: string;
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
 * 分支是否已经合入指定 ref（ADR-056 §3.3）。
 *
 * 合进版本分支时，判据不能是「合入 HEAD」—— HEAD 是**主仓当前检出的分支**，
 * 与版本分支无关。要判的是「这个切片的产物进了 version/<label> 没有」。
 *
 * ref 可以是分支名、tag 或 commit。
 */
export function isMergedIntoRef(branch: string, ref: string, repoRoot: string): boolean {
  return git(['merge-base', '--is-ancestor', branch, ref], repoRoot).ok;
}

/**
 * 一次性列出仓库里所有本地分支。
 *
 * 为什么要批量版：逐个分支跑 `git rev-parse` 是 N 次子进程调用，
 * 切片一多（几十个完成切片）光审计就要几秒。`for-each-ref` 一次拿全。
 */
export function listLocalBranches(repoRoot: string): Set<string> {
  const res = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], repoRoot);
  if (!res.ok) return new Set();
  return new Set(
    res.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

/**
 * 一次性列出已经合入当前 HEAD 的本地分支。
 *
 * 与逐个跑 `git merge-base --is-ancestor <branch> HEAD` 等价
 * （`--merged=HEAD` 筛的就是「tip 是 HEAD 的祖先」的引用），
 * 但只需要一次子进程调用。
 */
export function listMergedIntoHead(repoRoot: string): Set<string> {
  const res = git(
    ['for-each-ref', '--merged=HEAD', '--format=%(refname:short)', 'refs/heads/'],
    repoRoot,
  );
  if (!res.ok) return new Set();
  return new Set(
    res.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

/**
 * 基点是否已漂移：切片冻结之后目标分支已经前进。
 *
 * 判据是「基点是否仍等于目标 ref 的 commit」——目标分支前进后两者不再相同，
 * 此时切片分支不再包含目标分支的新提交，fast-forward 不再可能，必须走合并提交。
 *
 * 注意不能用「base 是否还是目标 ref 的祖先」来判：分支正常前进时 base 永远是
 * 祖先，那样判据永远为假，`merge.stale_base` 就永远不会触发。
 *
 * @param baseCommit 切片基点
 * @param repoRoot 仓库根
 * @param targetRef 目标 ref（缺省 HEAD —— 主仓当前分支）
 */
export function isStaleBase(
  baseCommit: string | null,
  repoRoot: string,
  targetRef: string = 'HEAD',
): boolean {
  if (!baseCommit) return false;
  if (!commitExists(baseCommit, repoRoot)) return false;
  const head = refCommit(repoRoot, targetRef);
  if (!head) return false;
  return head !== baseCommit;
}

/**
 * 是否可以 fast-forward：目标 ref 是不是该分支的祖先。
 *
 * ref 是分支的祖先 → 分支可以快进；否则两条历史已分叉。
 */
export function canFastForward(branch: string, repoRoot: string, targetRef: string = 'HEAD'): boolean {
  return git(['merge-base', '--is-ancestor', targetRef, branch], repoRoot).ok;
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
 * 指定 ref 的 commit 号（ADR-056 §3.3）。
 *
 * 缺省查 HEAD —— 与 `headCommit` 等价，但合并到版本分支时要查
 * `refs/heads/version/<label>`。
 */
function refCommit(repoRoot: string, ref: string): string | null {
  const res = git(['rev-parse', '--verify', `${ref}^{commit}`], repoRoot);
  return res.ok ? res.stdout.trim() : null;
}

/**
 * 某个路径在指定 ref 上是否存在（ADR-071 §3 D2）。
 *
 * 判据是「路径在**目标 ref 的树里**」，不是「文件在磁盘上」——
 * 后者会把未提交的本地改动算成已合入。
 *
 * 用 `git ls-tree` 而不是 `git cat-file`：`ls-tree` 对目录路径也返回条目
 * （带 `tree` 类型），所以写集里的目录形态（`src/**`）也能核实。
 */
function pathExistsInRef(path: string, ref: string, repoRoot: string): boolean {
  const res = git(['ls-tree', '-r', '--name-only', ref, '--', path], repoRoot);
  if (!res.ok) return false;
  return res.stdout.split('\n').some((l) => l.trim().length > 0);
}

/**
 * 核实切片的产物是否已经在目标 ref 上（ADR-071 §3 D1）。
 *
 * 适用场景：**切片没有 `slice/<id>` 分支**，但产物由人直接提交到了
 * 目标分支。此时合并是空操作 —— 产物已经在那儿了。
 *
 * 判据是**写集路径**：切片自己声明的产物清单。
 * 这是「无分支」情形下唯一还在的证据（没有基点、没有分支、没有 diff）。
 *
 * 逐条路径核实：
 * - 路径在目标 ref 上**存在** → 该条已就位
 * - 路径在目标 ref 上**不存在**，但它在工作区里也不存在 → 视为
 *   「该路径已被删除」，也算已就位（搬迁类切片）
 * - 路径在目标 ref 上**不存在**，但工作区里有 → 缺失（未合入）
 *
 * @returns 缺失的路径清单。空数组 = 产物已全部就位。
 */
export function verifyArtifactsInRef(
  writes: string[],
  ref: string,
  repoRoot: string,
): { missing: string[]; satisfied: string[] } {
  const missing: string[] = [];
  const satisfied: string[] = [];

  for (const raw of writes) {
    const path = raw.trim();
    if (!path) continue;

    // glob 写集无法逐个核实 —— 保守地认为它「已就位」，
    // 否则所有带 glob 写集的切片都会卡在这里（而 glob 写集的
    // 实际内容由运行时守卫逐写判定管着，见 C9）。
    if (path.includes('*') || path.includes('?')) {
      satisfied.push(path);
      continue;
    }

    if (pathExistsInRef(path, ref, repoRoot)) {
      satisfied.push(path);
      continue;
    }

    // 目标 ref 上没有 —— 该路径是不是「已经被删掉了」？
    // 判据：工作区里也没有，且它在目标 ref 的**上一次提交**里曾经存在。
    // 后者用 `git log --diff-filter=D` 查（该路径被删除过）。
    const deleted = git(
      ['log', '--diff-filter=D', '--name-only', '--format=%H', '-1', ref, '--', path],
      repoRoot,
    );
    if (deleted.ok && deleted.stdout.split('\n').some((l) => l.trim() === path)) {
      satisfied.push(path);
      continue;
    }

    missing.push(path);
  }

  return { missing, satisfied };
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

  // 合并目标目录与目标 ref（ADR-056 §3.3）
  // 缺省 = 主仓 + HEAD —— 与改造前完全一致。
  const targetDir = options.targetDir ?? repoRoot;
  const targetLabel = options.targetLabel ?? 'main';
  // 目标 ref：合版本分支时是那个分支，合主干时是 HEAD（主仓当前检出）
  const targetRef = targetLabel === 'main' ? 'HEAD' : `refs/heads/${targetLabel}`;

  const merged: string[] = [];
  const conflicts: MergeConflictReport[] = [];
  const staleBase: string[] = [];

  // ── 前置守卫：目标工作区必须干净，否则合并会污染未提交改动 ──
  //
  // 例外：zelto 自己管理的规格文件（`specs/slices/**`）与**验收骨架**
  // （`tests/acceptance/**` 里还全是 `test.todo` 的文件）。
  // 守卫要拦的是「人改了代码还没提交」—— 合并会把分支上的改动带进主干，
  // 未提交的本地改动会被盖掉。规格文件不是代码：合并不会碰它，
  // 它是追溯链的出处，该入库但不该挡路。接管既有项目时基线规格是新建文件，
  // 人还没来得及提交 —— 把它算成「工作区不干净」，合并就永远过不去。
  //
  // 验收骨架同理（ADR-056 真实项目验证）：`zelto version start` 会给每个
  // 切片生成骨架 → 主仓多出未跟踪的 `tests/acceptance/<id>/` →
  // 之后每次 merge 都被这个守卫拦下。骨架是规格的可执行投影，不是代码。
  //
  // 但**只豁免还全是 todo 的骨架** —— agent 把 todo 改成真断言之后，
  // 那份文件就是代码了（进了写集、参与门禁②），必须挡住。
  const status = git(['status', '--porcelain'], targetDir);
  if (status.ok && status.stdout.trim().length > 0) {
    // ⚠️ 路径解析必须用 parsePorcelainStatus —— 它先切掉状态码再 trim。
    // 自己写 `line.trim().slice(3)` 会把**行首的那个空格**吃掉、整行左移一位，
    // 于是路径的首字符丢失（` M .zelto/x.json` → `zelto/x.json`），
    // 结果是所有路径豁免在「**已修改的文件**」上全部失效
    // （未跟踪文件 `?? path` 没有行首空格，所以这个 bug 一直没被发现）。
    const entries = status.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const paths = parsePorcelainStatus(status.stdout);

    const dirty: string[] = [];
    const managedSpecs: string[] = [];
    const managedSkeletons: string[] = [];
    const managedState: string[] = [];
    const submoduleDirtyOnly: string[] = [];
    // 待合分支（合并会碰到的来源）—— 用来判断 zelto 状态文件会不会被覆盖
    //
    // ADR-071：**空操作切片没有分支** —— 它的产物本来就在目标分支上，
    // 合并不会碰任何东西。所以它不能进 candidateRefs：
    // `pathDiffersFromAnyRef` 对不存在的 ref 会保守返回 true
    //（「判定不出来 → 当作变了」），那会让所有 zelto 状态文件都失去豁免，
    // 把空操作合并也拦下来 —— 而它压根不会碰这些文件。
    const candidateRefs = plan.slices
      .map((id) => byId.get(id))
      .filter((info): info is MergeSliceInfo => info !== undefined && info.noop !== true)
      .map((info) => `refs/heads/${info.branch}`);
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const path = paths[i] ?? '';
      if (isZeltoManagedSpecPath(path)) {
        managedSpecs.push(entry);
      } else if (isUntouchedAcceptanceSkeleton(path, targetDir)) {
        managedSkeletons.push(entry);
      } else if (
        isZeltoStatePath(path) &&
        // 只有「待合分支都没动这个路径」才豁免 —— 动了就会真冲突，必须拦
        !pathDiffersFromAnyRef(path, targetRef, candidateRefs, repoRoot)
      ) {
        managedState.push(entry);
      } else if (isSubmoduleOnlyDirty(targetDir, path)) {
        // submodule 只有 `-dirty` 标记（指针没变）→ 合并碰不到它，不算脏。
        //
        // 实测（nimrtc-zelto，2026-11-17）：msquic 的嵌套 submodule 被 CRLF
        // 弄脏，主仓 gitlink 指针一模一样 —— 守卫判成「工作区不干净」→
        // **每一片都合不进去**。这不是「人改了代码还没提交」，不该拦。
        submoduleDirtyOnly.push(entry);
      } else {
        dirty.push(entry);
      }
    }

    if (managedSpecs.length > 0) {
      log(`  ℹ️  ${managedSpecs.length} 个 zelto 管理的规格文件未提交（不影响合并）：`);
      for (const m of managedSpecs.slice(0, 5)) log(`     ${m}`);
      if (managedSpecs.length > 5) log('     …');
    }

    if (managedSkeletons.length > 0) {
      log(`  ℹ️  ${managedSkeletons.length} 个验收骨架未提交（不影响合并）：`);
      for (const m of managedSkeletons.slice(0, 5)) log(`     ${m}`);
      if (managedSkeletons.length > 5) log('     …');
    }

    if (managedState.length > 0) {
      log(`  ℹ️  ${managedState.length} 个 zelto 运行时状态未提交（不影响合并）：`);
      for (const m of managedState.slice(0, 5)) log(`     ${m}`);
      if (managedState.length > 5) log('     …');
    }

    if (submoduleDirtyOnly.length > 0) {
      log(`  ℹ️  ${submoduleDirtyOnly.length} 个 submodule 只有内部脏标记（指针未变，不影响合并）：`);
      for (const m of submoduleDirtyOnly.slice(0, 5)) log(`     ${m}`);
      if (submoduleDirtyOnly.length > 5) log('     …');
    }

    if (dirty.length > 0) {
      // 列出具体是什么挡着 —— 只说「有未提交改动」的话，人得自己去找。
      const shown = dirty.slice(0, 10);
      log('  ⚠️  目标工作区有未提交改动，已跳过自动合并。');
      for (const d of shown) log(`     ${d}`);
      if (dirty.length > 10) log('     …（只列前 10 条）');
      log('     先提交（git commit）或暂存（git stash）这些改动，再重新跑 zelto merge。');
      log('     签字已经过了，不用重新签。');
      // D-11：这里必须算**中止**，不能返回 `aborted: false`。
      //
      // 合并一步都没做，但上层看到 aborted=false 就打印
      // 「✅ Merge complete (0 slices)」并退出 0 —— 工具报告成功，
      // 而产物根本没进目标分支。人会以为合完了，把时间花在下游上，
      // 真正的问题（工作区脏）被一句「✅」盖住了。
      //
      // 更糟的是 `--push` 也会跟着跑 —— 推的是一条没变的分支。
      return {
        merged,
        conflicts,
        staleBase,
        aborted: true,
        abortReason: `目标工作区有未提交改动（${dirty.length} 项），已跳过合并`,
      };
    }
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
      target: targetLabel,
    });
  }

  for (const phase of plan.phases) {
    if (phase.strategy === 'manual' || phase.strategy === 'rebase_onto') {
      log(`  ⏭️  Phase ${phase.phase}: 策略 "${phase.strategy}" 不自动执行，需人工处理。`);
      log(`     手动合并：git merge ${phase.slices.map((id) => byId.get(id)?.branch ?? id).join(' ')}`);
      continue;
    }
    await executePhase(
      phase,
      byId,
      targetDir,
      targetRef,
      targetLabel,
      log,
      options,
      merged,
      conflicts,
      staleBase,
    );
  }

  // ── 记录完成 ──
  const commit = refCommit(targetDir, targetRef) ?? headCommit(targetDir);
  for (const id of merged) {
    // ADR-071 §3 D3：空操作合并也记事件 —— 追溯链不因为
    // 「这次没搬东西」而断。mode 字段区分两种合并。
    const info = byId.get(id);
    const noop = info?.noop === true;
    await options.events.append(id, 'merge.completed', 'zelto', {
      sliceId: id,
      slices: merged,
      strategy: plan.strategy,
      phases: plan.phases.length,
      mergeCommit: commit,
      mode: noop ? 'noop' : 'merged',
      ...(noop
        ? {
            reason: '产物已在目标分支（无 slice 分支，按写集路径核实）',
            artifacts: info?.writes ?? [],
          }
        : {}),
    });
  }

  // ── 同步版本计划状态 ──
  // 切片合入的是版本分支 → 版本计划要跟着走，否则 `version status` 会一直
  // 报 in_progress，下游版本（dependsOn）永远被挡：人找不到"还要做什么"。
  if (merged.length > 0) {
    await syncVersionPlanAfterMerge({ merged, targetLabel, targetRef, options, log });
  }

  return { merged, conflicts, staleBase, aborted: conflicts.length > 0 };
}

/**
 * 合并后同步版本计划：本版本的切片全部合入版本分支 → `in_progress → integrated`。
 *
 * 判据是**事实**（每个切片分支是否已并入版本分支），不是「刚合了几片」——
 * 只合了 v1 的一半，v1 就还是 in_progress。
 *
 * 不碰 `planned`（还没开工的版本）与 `delivered`（已经交付的版本）；
 * 已经是 `integrated` 的不重复写。
 */
async function syncVersionPlanAfterMerge(ctx: {
  merged: string[];
  targetLabel: string;
  targetRef: string;
  options: MergeExecutorOptions;
  log: (message: string) => void;
}): Promise<void> {
  const repoRoot = ctx.options.repoRoot ?? process.cwd();
  const versionsDir = join(repoRoot, '.zelto', 'versions');
  const plans = readVersionPlans(versionsDir);
  if (plans.length === 0) return;

  // 只处理「刚合的切片真的属于这个版本」的情形 —— 归属解析不出来
  //（切片不在任何计划里 / 归属歧义 / 显式合主干）就不替人做决定。
  const mergedSet = new Set(ctx.merged);
  const ownedPlans = new Set<string>();
  for (const id of ctx.merged) {
    try {
      const owner = resolveSliceOwnership(id, { versionsDir });
      if (owner.kind === 'version') ownedPlans.add(owner.planId);
    } catch {
      return;
    }
  }

  for (const plan of plans) {
    if (!ownedPlans.has(plan.id)) continue;
    const version = plan.versions.find(
      (v) => v.status === 'in_progress' && branchOfVersion(v) === ctx.targetLabel,
    );
    if (!version) continue;

    // 每个切片：没有分支（空操作 / 已删）或分支已并入目标 ref → 算已合入
    const allIn = version.slices.every((s) => {
      const branch = `slice/${s.id}`;
      if (!git(['rev-parse', '--verify', `refs/heads/${branch}`], repoRoot).ok) return true;
      return git(['merge-base', '--is-ancestor', `refs/heads/${branch}`, ctx.targetRef], repoRoot).ok;
    });
    if (!allIn) continue;

    version.status = 'integrated';
    await new VersionStore(join(repoRoot, '.zelto')).updateVersionStatus(plan.id, version.version, 'integrated');
    ctx.log(`  ℹ️  版本 ${version.version} 的切片已全部合入 ${ctx.targetLabel} → 状态 integrated`);

    try {
      await ctx.options.events.append(`version-${version.version}`, 'version.integrated', 'zelto', {
        plan: plan.id,
        version: version.version,
        target: ctx.targetLabel,
        slices: version.slices.map((s) => s.id),
        mergedThisRound: [...mergedSet],
      });
    } catch {
      // 事件写失败不阻塞合并结果 —— 计划状态已经落盘
    }
  }
}

async function executePhase(
  phase: MergePhase,
  byId: Map<string, MergeSliceInfo>,
  targetDir: string,
  targetRef: string,
  targetLabel: string,
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

    // ADR-071：空操作合并 —— 产物已在目标分支，没什么可合的。
    //
    // 这条路径**不执行 git merge**，但仍算「已合入」：
    // 走完流程后切片的状态与审计链才是完整的。
    if (info.noop === true) {
      merged.push(id);
      await options.events.append(id, 'merge.phase_complete', 'zelto', {
        phase: phase.phase,
        sliceId: id,
        slices: [id],
        strategy: 'noop',
        branch: info.branch,
        mergeCommit: refCommit(targetDir, targetRef) ?? headCommit(targetDir),
        target: targetLabel,
      });
      log(`  ✅ ${id} 产物已在目标分支，无需合并（空操作）`);
      continue;
    }

    const branchExists = git(['rev-parse', '--verify', `refs/heads/${info.branch}`], targetDir).ok;
    if (!branchExists) {
      log(`  ❌ ${id}: 分支 "${info.branch}" 不存在，无法合并。`);
      conflicts.push({ sliceId: id, files: [], message: `分支 "${info.branch}" 不存在` });
      await options.events.append(id, 'merge.conflict', 'zelto', {
        phase: phase.phase,
        sliceId: id,
        files: [],
        resolution: 'failed',
        message: `分支 "${info.branch}" 不存在`,
        target: targetLabel,
      });
      continue;
    }

    // 基点漂移检测：base 不再等于目标 ref → 目标分支已前进（ADR-056 §3.3）
    const stale = isStaleBase(info.baseCommit, targetDir, targetRef);
    const ff = phase.strategy === 'sequential_ff' && !stale && canFastForward(info.branch, targetDir, targetRef);
    const useMergeCommit = phase.strategy === 'merge_commit' || !ff;

    if (stale) {
      staleBase.push(id);
      await options.events.append(id, 'merge.stale_base', 'zelto', {
        sliceId: id,
        branch: info.branch,
        baseCommit: info.baseCommit,
        reason: '切片基点不再是目标分支的祖先，fast-forward 不可用',
        target: targetLabel,
      });
      log(`  ℹ️  ${id}: 基点已漂移，改用合并提交（--no-ff）。`);
    } else if (!ff && phase.strategy === 'sequential_ff') {
      log(`  ℹ️  ${id}: 历史已分叉，改用合并提交（--no-ff）。`);
    }

    const args = useMergeCommit
      ? ['merge', '--no-ff', info.branch, '-m', `Merge slice ${id}\n\nRefs-Slice: ${id}`]
      : ['merge', '--ff-only', info.branch];

    const res = git(args, targetDir);
    if (!res.ok) {
      const files = conflictedFiles(targetDir);
      // 合并失败：先把目标工作区恢复到合并前的状态
      git(['merge', '--abort'], targetDir);

      const message = res.stderr.trim() || res.stdout.trim() || '合并失败';
      await options.events.append(id, 'merge.conflict', 'zelto', {
        phase: phase.phase,
        sliceId: id,
        files,
        resolution: files.length > 0 ? 'conflict' : 'failed',
        message,
        target: targetLabel,
      });
      conflicts.push({ sliceId: id, files, message });
      log(`  ❌ ${id}: 合并失败，目标分支已恢复原状。`);
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
      mergeCommit: refCommit(targetDir, targetRef) ?? headCommit(targetDir),
      target: targetLabel,
    });
    log(`  ✅ ${id} 已合入${targetLabel === 'main' ? '' : ` ${targetLabel}`}（${useMergeCommit ? '合并提交' : 'fast-forward'}）`);
  }
}
