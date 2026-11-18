// zelto version ship —— 版本分支合入主干
//
// ADR-056 §3.5：版本分支合入主干是**独立显式动作**。
//
// 与 ADR-018 的关系：ADR-018 禁止的是「签字后自动合并」。
// ship 的粒度与今天的 `zelto merge` 完全一致 —— 人显式跑一次，zelto 执行一次合并。
// 它没有把合并挂到签字上，也没有把「逐片签字」变成「一次批准」。
//
// D3-C：ship 之后在主干重跑一次版本级验收，**只提示不阻断**。
//   - ship 的语义是「现在就合」，不是「再验一遍」
//   - 但集成缺口是真风险（版本分支验过，主干合入时可能撞出缺口）
//   - 结论必须可见且有留痕（写进 version.delivered 事件 payload）
//
// D6-C：ship 之后打 tag —— 版本分支是可变的（会被 rebase、会被删），
//   「这个版本整体长什么样」需要**不可变**锚点。

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { register, events, ZELTO_DIR, worktreeManager, loadConfig } from './shared.js';
import { VersionStore } from '../../core/version/store.js';
import type { VersionPlan } from '../../core/version/types.js';
import { branchOfVersion, versionBranchName, versionTagName } from '../../core/version/branch.js';
import {
  isZeltoManagedSpecPath,
  isZeltoStatePath,
} from '../../core/project/managed-paths.js';
import { parsePorcelainStatus } from '../../core/sched/audit.js';
import { clearUntrackedManagedSpecs } from '../../core/project/untracked-specs.js';
import { isUntouchedAcceptanceSkeleton } from '../../core/project/managed-acceptance.js';
import { branchExists, pathDiffersFromAnyRef } from './version-runtime.js';
import { getDefaultFormatter } from '../output-formatter.js';
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
      timeout: 120_000,
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

/** 冲突文件列表 */
function conflictedFiles(repoRoot: string): string[] {
  const res = git(['diff', '--name-only', '--diff-filter=U'], repoRoot);
  if (!res.ok) return [];
  return res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * 把版本分支合入主仓当前分支。
 *
 * 走的是与 `zelto merge` 同一套机制（策略选择、冲突处理、`--abort` 保护），
 * 但目标反过来：这里是把**版本分支**合进**主干**。
 */
function shipBranch(
  versionBranch: string,
  repoRoot: string,
  log: (m: string) => void,
  versionBaseCommit: string | null = null,
): {
  ok: boolean;
  mergeCommit: string | null;
  conflicts: string[];
  error: string | null;
  /**
   * 本次 ship **产生**的提交（空操作合并时为 null）。
   *
   * D-71：空操作时**不能**拿 HEAD 顶替 —— 那可能是上一次 ship 留下的提交，
   * 事件与 tag 会因此指向别的版本。
   */
  mergeCommitProduced: boolean;
  /**
   * 可以代表「这一版整体长什么样」的提交（tag 打在它上面）。
   *
   * 空操作时是「包含本版本内容的那个提交」；版本内容不在目标分支上时为 null
   * —— 没有诚实锚点就不打 tag。
   */
  anchorCommit: string | null;
  /** 本次合并是空操作（没产生新提交） */
  noop: boolean;
  /**
   * 实际合进的分支名（D-63）。
   *
   * ship 合的是**主仓当前检出的分支**（ADR-056 §3.5），不一定是 `main`。
   * 事件里必须写真实的那个 —— 写死 `'main'` 会让追溯链说谎。
   */
  targetBranch: string | null;
} {
  // ── D-63：合进「主仓当前检出的分支」，并记住它到底是哪个 ──────────
  //
  // ship 合的是**主仓当前检出的分支**（ADR-056 §3.5：「版本分支合入主干」，
  // 「主干」在 ADR 的语境里 = 主仓当前分支，不特指 `main`）。
  //
  // 之前的写法把 `target` 算出来就扔了，而事件里写死 `target: 'main'`：
  // 于是主仓停在 `feat/xxx` 上跑 ship 时，
  // **事件说「已合入 main」，实际上合的是 feat/xxx** ——
  // 追溯链（C4：事件是追溯的唯一证据载体）在这里说了假话。
  //
  // 实测（nimrtc-zelto v3，2026-11-18）：`version.delivered` 事件写着
  // `shippedTo: "main"`，而 tag `v3` 实际打在 `feat/remote-desktop-m1-m4` 上，
  // `git merge-base --is-ancestor v3 main` 返回假 —— v3 从来没进过 main。
  //
  // 后果：以后查「v3 进主干了吗」，事件说进了，git 说没进。**两个证据打架，
  // 人只能靠猜** —— 这比「没合」更坏，因为追溯链看起来是完整的。
  //
  // 修法：把真实的分支名带出去，写进事件。
  //
  // （放在守卫之前算：守卫失败时也要知道「本来要合到哪」）
  const current = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
  const targetBranch = current.ok ? current.stdout.trim() : null;

  // 主干工作区必须干净
  //
  // 例外：zelto 自己管理的规格文件（`specs/slices/**`）与**验收骨架**
  // （`tests/acceptance/**` 里还全是 `test.todo` 的文件）——
  // 与 `zelto merge` 的守卫同一口径（ADR-039 §3.3、ADR-056 真实项目验证）。
  // 守卫要拦的是「人改了代码还没提交」；规格文件与骨架都是追溯链的产物，
  // 不是代码改动，不该挡住 ship。
  //
  // 验收目录里 agent 写的真断言**不豁免** —— 那是代码，合并会覆盖它。
  const status = git(['status', '--porcelain'], repoRoot);
  if (status.ok && status.stdout.trim().length > 0) {
    const entries = status.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    // ⚠️ 路径解析必须用 parsePorcelainStatus —— 先切状态码再 trim。
    // `line.trim().slice(3)` 会吃掉行首空格、让路径首字符丢失，
    // 导致豁免在「已修改的文件」上失效。
    const paths = parsePorcelainStatus(status.stdout);

    const dirty: string[] = [];
    const managedSpecs: string[] = [];
    const managedSkeletons: string[] = [];
    const managedState: string[] = [];
    // 来源分支（版本分支）—— 合并会碰到它的改动
    const candidateRefs = [`refs/heads/${versionBranch}`];
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const path = paths[i] ?? '';
      if (isZeltoManagedSpecPath(path)) {
        managedSpecs.push(entry);
      } else if (isUntouchedAcceptanceSkeleton(path, repoRoot)) {
        managedSkeletons.push(entry);
      } else if (
        isZeltoStatePath(path) &&
        // 版本分支没动这个路径 → 合并碰不到 → 可豁免；动了就必须拦
        !pathDiffersFromAnyRef(path, 'HEAD', candidateRefs, repoRoot)
      ) {
        managedState.push(entry);
      } else {
        dirty.push(entry);
      }
    }

    if (managedSpecs.length > 0) {
      log(`  ℹ️  ${managedSpecs.length} 个 zelto 管理的规格文件未提交（不影响 ship）：`);
      for (const m of managedSpecs.slice(0, 5)) log(`     ${m}`);
      if (managedSpecs.length > 5) log('     …');
    }

    if (managedSkeletons.length > 0) {
      log(`  ℹ️  ${managedSkeletons.length} 个验收骨架未提交（不影响 ship）：`);
      for (const m of managedSkeletons.slice(0, 5)) log(`     ${m}`);
      if (managedSkeletons.length > 5) log('     …');
    }

    if (managedState.length > 0) {
      log(`  ℹ️  ${managedState.length} 个 zelto 运行时状态未提交（不影响 ship）：`);
      for (const m of managedState.slice(0, 5)) log(`     ${m}`);
      if (managedState.length > 5) log('     …');
    }

    if (dirty.length > 0) {
      log('  ⚠️  主仓工作区有未提交改动，已跳过 ship：');
      for (const d of dirty.slice(0, 10)) log(`     ${d}`);
      if (dirty.length > 10) log('     …（只列前 10 条）');
      log('     先提交或暂存这些改动，再重新跑 zelto version ship。');
      return {
        ok: false,
        mergeCommit: null,
        mergeCommitProduced: false,
        anchorCommit: null,
        noop: false,
        conflicts: [],
        error: '主仓工作区不干净',
        targetBranch,
      };
    }
  }

  // ── D-62：清掉「未跟踪的 zelto 规格文件副本」 ────────────────────────
  //
  // 上面那个守卫把 `specs/slices/**` 豁免了（报「不影响 ship」），
  // 但 **git 自己不认这个豁免** —— 未跟踪文件会被合并覆盖时，
  // git 直接拒绝合并：
  //
  //     error: The following untracked working tree files would be overwritten by merge:
  //             specs/slices/v3-chrome-waterfall.md
  //
  // 于是「守卫放行 → git 硬拦」—— 失败信息是 git 的原话，
  // 人看不到「其实是 zelto 自己的豁免跟 git 的硬拦冲突」。
  //
  // 实测（nimrtc-zelto v3 ship，2026-11-18）：就卡在这儿。
  //
  // 这些副本是 zelto 自己写的产物；版本分支上有它们的正式版本。
  // 内容一致（只差行尾）就删掉工作区这份，让合并把版本分支上的落下来。
  // 内容不一致 → 不删，报出来让人看（保守方向）。
  const specCleanup = clearUntrackedManagedSpecs(repoRoot, `refs/heads/${versionBranch}`);
  if (specCleanup.removed.length > 0) {
    log(`  ℹ️  清理了 ${specCleanup.removed.length} 个未跟踪的规格文件副本（与 ${versionBranch} 上的一致）：`);
    for (const p of specCleanup.removed.slice(0, 5)) log(`     ${p}`);
    if (specCleanup.removed.length > 5) log('     …');
  }
  for (const note of specCleanup.notes) log(`  ⚠️  ${note}`);
  if (specCleanup.conflicts.length > 0) {
    log(`  ⚠️  ${specCleanup.conflicts.length} 个规格文件副本与 ${versionBranch} 上不一致，已保留（合并可能被 git 拦）：`);
    for (const p of specCleanup.conflicts.slice(0, 5)) log(`     ${p}`);
  }

  // 基点漂移：版本分支的基点是否还是当前 HEAD
  // 版本分支从哪建的不一定等于现在的 HEAD（主干在这期间前进过）
  const headRes = git(['rev-parse', 'HEAD'], repoRoot);
  const head = headRes.ok ? headRes.stdout.trim() : null;
  const ancestor = git(['merge-base', '--is-ancestor', 'HEAD', versionBranch], repoRoot);
  const canFf = ancestor.ok;

  const args = canFf
    ? ['merge', '--ff-only', versionBranch]
    : ['merge', '--no-ff', versionBranch, '-m', `Ship version ${versionBranch}`];

  if (!canFf) {
    // ── D-70：分叉 ≠ 主干前进 ──────────────────────────────────
    //
    // 「主干已前进」与「主干历史被改写」是两回事，
    // 但合并前的提示只说了前者 —— 人在真正撞上冲突之前
    // 得到的诊断是**错的**。
    //
    // 实测（nimrtc-zelto v5，2026-11-18）：
    // v1–v4 的 PR 是 **squash 合并**进 main 的 —— squash 重写了 main 的历史，
    // 于是从 squash 前的分支建出来的 `version/v5` 与 main 有了**两套祖先**：
    //
    //   $ git merge-base --is-ancestor HEAD version/v5 ; echo $?
    //   1                     ← 不是快进
    //   $ git merge-base main version/v5
    //   b4c66de…              ← 共同祖先在 squash 之前
    //
    // 提示说「主干已前进，改用合并提交」—— 但真正的问题是
    // **两套历史**：合并会产生 40+ 文件的冲突，
    // 而版本分支里的产物其实早已在 main 上（squash 带过去了）。
    //
    // ── 判据 ──────────────────────────────────────────────────
    //
    // 用**版本分支记录的基点**（`version.baseCommit`）判，而不是用祖先关系：
    //
    //   - 基点仍是主干 HEAD 的祖先 → 主干只是前进，历史没被动过 → 正常 --no-ff；
    //   - 基点**不再**是主干 HEAD 的祖先 → 主干历史被改写过（squash / rebase /
    //     filter-branch）→ 版本分支挂在旧历史上，合并必然大面积冲突。
    //
    // 为什么不用祖先关系判（`is-ancestor versionBranch HEAD`）：
    // 那判的是「版本分支的提交有没有进主干」，而**正常流程里答案本来就是「没有」**
    // —— 版本分支的产物正是要靠这次 ship 才进主干。
    // 用它当判据会把每一次正常的 ship 都误报成分叉。
    //
    // 为什么必须区分这两种情况：
    // 这是**人做决定前**唯一拿到的信号。提示说「改用合并提交」时，
    // 人以为 --no-ff 就行；真撞上 40 文件冲突时，
    // 人完全不知道该 rebase 版本分支还是该从主干重建。
    const baseAncestor =
      versionBaseCommit !== null &&
      git(['merge-base', '--is-ancestor', versionBaseCommit, 'HEAD'], repoRoot).ok;

    if (versionBaseCommit === null) {
      // 没有基点可判 → 不乱说（保守方向：宁可说「已前进」让人撞一次，
      // 也不要误报「分叉」把人引去 rebase 一条本来干净的历史）。
      log('  ℹ️  主干已前进，改用合并提交（--no-ff）。');
      log('     ℹ️  版本基点未记录，无法判断主干历史是否被改写过。');
    } else if (baseAncestor) {
      log('  ℹ️  主干已前进，改用合并提交（--no-ff）。');
    } else {
      const mb = git(['merge-base', 'HEAD', versionBranch], repoRoot);
      const mbShort = mb.ok ? mb.stdout.trim().slice(0, 8) : '未知';
      log('  ⚠️  版本分支与主干**已分叉**（主干历史被改写过，不是单纯的主干前进）。');
      log(`     版本基点：${versionBaseCommit ? versionBaseCommit.slice(0, 8) : '（未记录）'}`);
      log(`     共同祖先：${mbShort}`);
      log('     主干历史被改写过（常见于 squash 合并 PR），版本分支还挂在旧历史上。');
      log('     直接合并会产生大量冲突 —— 先把版本分支对齐到主干：');
      log(`       git rebase --onto ${targetBranch ?? 'main'} ${mbShort} ${versionBranch}`);
      log('     对齐后再重跑 zelto version ship。');
    }
  }

  // ── 合并前的 HEAD ──────────────────────────────────────────
  //
  // 记下来，是为了判断「这次合并到底有没有产生新提交」。
  const headBefore = head;

  const res = git(args, repoRoot);
  if (!res.ok) {
    const files = conflictedFiles(repoRoot);
    git(['merge', '--abort'], repoRoot);
    const message = res.stderr.trim() || res.stdout.trim() || '合并失败';
    return {
      ok: false,
      mergeCommit: null,
      mergeCommitProduced: false,
      anchorCommit: null,
      noop: false,
      conflicts: files,
      error: message,
      targetBranch,
    };
  }

  const commitRes = git(['rev-parse', 'HEAD'], repoRoot);
  const headAfter = commitRes.ok ? commitRes.stdout.trim() : null;

  // ── D-71：合并没产生新提交时，mergeCommit 不能是「HEAD 恰好是啥」 ──
  //
  // 合并「什么都没做」有两种：
  //   1. 版本分支的产物早已在目标分支上（切片的产物被人直接提交到了主干，
  //      或者上一版 ship 已经把它带进去了）→ `git merge` 报 "Already up to date"，
  //      HEAD 不动；
  //   2. 快进合并失败但内容一致 —— 同上，HEAD 不动。
  //
  // 之前的写法：`mergeCommit = rev-parse HEAD` —— **不管这次合并有没有动 HEAD**。
  // 于是当 HEAD 恰好停在**上一次** ship 留下的提交上时，
  // 这次 ship 的事件与 tag 就指向了**别的版本**的提交。
  //
  // 实测（nimrtc-zelto v1，2026-11-17）：
  //
  //   v4 delivered at 22:27:04  mergeCommit=5e6e0abc  （Ship version version/v4）
  //   v1 delivered at 22:35:26  mergeCommit=5e6e0abc  ← 同一个提交！
  //
  // v1 的 ship 实际**没有产生新提交**（产物早就在分支上了），
  // 但它记下了 HEAD 当时的位置 —— 那是 v4 留下的 5e6e0abc。
  // 结果 tag `v1` 和 tag `v4` 指向**同一个提交**，
  // `git merge-base --is-ancestor v1 main` 说「v1 不在主干里」——
  // **追溯链在这里说了假话**（C4：事件是追溯的唯一证据载体）。
  //
  // 修法：合并前后 HEAD 没变 → 这次合并是空操作，
  // mergeCommit 记 **null**，并明确说「产物早已在目标分支上」。
  // 事件里 mergeCommit=null 是**真话**；写一个别人的提交是假话。
  const producedCommit = headBefore !== null && headAfter !== null && headBefore !== headAfter;

  // ── tag 该打在哪个提交上 ────────────────────────────────────
  //
  // tag 的语义（D6-C）：「**这个版本整体长什么样**」的不可变锚点。
  // 版本分支是可变的（会被 rebase、会被删），所以要把它钉在某个提交上。
  //
  // 正常合并时：钉在**本次合并产生的新提交**上（那个提交只属于这一版）。
  //
  // 空操作合并时：本次没有新提交。剩下的候选只有两个：
  //   - 目标分支当前位置（HEAD）—— **不能选**。
  //     HEAD 可能是**别的版本** ship 留下的提交（实测：v1 的 ship 是空操作，
  //     HEAD 停在 v4 的 ship 提交 5e6e0abc 上 → tag v1 与 tag v4 撞在一起）。
  //   - **版本分支的 tip**（version/vN）—— 选它。
  //     它是这一版的产物汇聚点，**每个版本各不相同**，
  //     而且内容正好是「这一版整体长什么样」。
  //
  // 版本分支的 tip 不是 HEAD 的祖先时（内容压根没过去），没有诚实锚点 → 不打 tag。
  const versionTipRes = git(['rev-parse', versionBranch], repoRoot);
  const versionTip = versionTipRes.ok ? versionTipRes.stdout.trim() : null;
  const versionIsAncestor = git(['merge-base', '--is-ancestor', versionBranch, 'HEAD'], repoRoot).ok;
  const anchorCommit = producedCommit
    ? headAfter
    : (versionIsAncestor && versionTip
      ? versionTip
      : (versionIsAncestor ? headAfter : null));

  if (!producedCommit) {
    log('  ℹ️  合并是空操作 —— 版本分支的产物早已在目标分支上，本次没有产生新提交。');
    log(`     目标分支当前位置：${(headAfter ?? '未知').slice(0, 8)}（不是本次合并产生的）`);
    if (anchorCommit) {
      log(`     tag 将打在 ${anchorCommit.slice(0, 8)}（版本分支 tip —— 这一版的产物汇聚点）。`);
    } else {
      log('     ⚠️  版本分支的内容不在目标分支上 —— 不打 tag（没有诚实的锚点）。');
    }
  }

  return {
    ok: true,
    mergeCommit: producedCommit ? headAfter : null,
    mergeCommitProduced: producedCommit,
    anchorCommit,
    noop: !producedCommit,
    conflicts: [],
    error: null,
    targetBranch,
  };
}

/**
 * tag 在 git 里**已经存在**吗（D-73）。
 *
 * 「本次打了 tag」与「这一版有 tag」是两件事 ——
 * 二次 ship 时前者是假、后者是真。
 */
function tagAlreadyExists(tag: string, repoRoot: string): boolean {
  return git(['rev-parse', '--verify', `refs/tags/${tag}`], repoRoot).ok;
}

/** 打 tag（幂等 —— 已存在就跳过，不覆盖） */
function tagVersion(tag: string, commit: string, repoRoot: string, log: (m: string) => void): boolean {
  const existing = git(['rev-parse', '--verify', `refs/tags/${tag}`], repoRoot);
  if (existing.ok) {
    log(`  ℹ️  tag "${tag}" 已存在 —— 不覆盖`);
    return false;
  }
  const res = git(['tag', '-a', tag, commit, '-m', `Version ${tag}`], repoRoot);
  if (!res.ok) {
    log(`  ⚠️  打 tag "${tag}" 失败：${(res.stderr || res.stdout).trim().slice(0, 200)}`);
    return false;
  }
  log(`  🏷️  已打 tag "${tag}" → ${commit.slice(0, 8)}`);
  return true;
}

/**
 * `zelto version ship` —— 版本分支合入主干。
 *
 * 导出为函数而不是独立注册命令：`commands` 是 Record，
 * 注册 'version' 会覆盖 ai-pipeline.ts 里那个（ADR-056 §3.5）。
 * 由 ai-pipeline.ts 的 version 分发器调用。
 */
export async function handleVersionShip(
  args: string[],
  f: ReturnType<typeof getDefaultFormatter>,
): Promise<number> {
  const versionLabel = args[1];
  if (!versionLabel || versionLabel.startsWith('--')) {
    f.error('USAGE', 'Usage: zelto version ship <version-label> [--plan <plan-id>] [--dry-run] [--no-tag]');
    return 1;
  }

  const planIdx = args.indexOf('--plan');
  const planId = planIdx >= 0 ? args[planIdx + 1] : null;
  const isDryRun = args.includes('--dry-run');
  const noTag = args.includes('--no-tag');
  const asJson = args.includes('--json');

  const versionStore = new VersionStore(ZELTO_DIR);
  let targetPlan: VersionPlan | null = null;

  if (planId) {
    if (!(await versionStore.exists(planId))) {
      f.error('NOT_FOUND', `Plan "${planId}" not found.`);
      return 1;
    }
    targetPlan = await versionStore.read(planId);
  } else {
    const plans = await versionStore.list();
    const confirmed = plans.filter((p) => p.status === 'confirmed');
    if (confirmed.length === 0) {
      f.error('NOT_FOUND', 'No confirmed plans found. Confirm a plan first.');
      return 1;
    }
    targetPlan = await versionStore.read(confirmed[0].id);
  }

  const version = targetPlan.versions.find((v) => v.version === versionLabel);
  if (!version) {
    f.error('NOT_FOUND', `Version "${versionLabel}" not found in plan "${targetPlan.id}".`);
    return 1;
  }

  if (version.status !== 'integrated' && version.status !== 'in_progress') {
    f.error('INVALID_STATE', `Version "${versionLabel}" is ${version.status}. Must be "integrated" to ship.`);
    return 1;
  }

  // D-57：ship 是「这一版做完、、交给主干」。
  //   版本状态说 integrated 不算数 —— 那个字段可能是**合并时误写**的
  //   （实测 nimrtc-zelto v3，2026-11-18：一片没跑也被判成 integrated）。
  //   这里重新核一遍切片状态：每一片都得真的 completed。
  //
  //   为什么必须核：ship 是**唯一**把版本推进主干的闸门。
  //   闸门放行一个没做完的版本 → 半成品进主干，后面谁都查不出来。
  const { allSlicesCompleted } = await import('./merge-executor.js');
  if (!(await allSlicesCompleted(version.slices, process.cwd()))) {
    const notDone = version.slices.map((s) => s.id).join(', ');
    f.error(
      'INVALID_STATE',
      `版本 "${versionLabel}" 还没做完（切片状态未到 completed）：${notDone} —— 先把每一片跑完并合入 ${branchOfVersion(version)}。`,
    );
    return 1;
  }

  const manager = worktreeManager();
  if (!manager.isGitRepo()) {
    f.error('INVALID_STATE', 'Not in a git repository — 版本分支不可用。');
    return 1;
  }

  const versionBranch = branchOfVersion(version);
  if (!branchExists(versionBranch, process.cwd())) {
    f.error('NOT_FOUND', `版本分支 "${versionBranch}" 不存在 —— 先跑 zelto version start ${versionLabel}。`);
    return 1;
  }

  if (isDryRun) {
    if (asJson) {
      console.log(JSON.stringify({ version: versionLabel, branch: versionBranch, dryRun: true }, null, 2));
    } else {
      // D-63：dry-run 也要说真名 —— 人要在**动手前**知道会合到哪。
      const cur = git(['rev-parse', '--abbrev-ref', 'HEAD'], process.cwd());
      f.out(`🔍 Dry-run —— 不会真的合入。`);
      f.out(`   版本分支：${versionBranch}`);
      f.out(`   合入目标：${cur.ok ? cur.stdout.trim() : '（未知）'}`);
      f.out(`   标签：${noTag ? '（不打）' : versionTagName(versionLabel)}`);
    }
    return 0;
  }

  const result = shipBranch(
    versionBranch,
    process.cwd(),
    (m) => f.out(m),
    version.baseCommit ?? null,
  );

  f.out(`── ship 版本 ${versionLabel} ──`);
  f.out(`   版本分支：${versionBranch}`);
  // D-63：把真实的目标分支名打出来 —— 人一眼就能看出「这一版合到哪了」，
  // 不用去翻 git。写死「主仓当前分支」这种话，人得自己去看当前检出的是什么。
  f.out(`   合入目标：${result.targetBranch ?? '（未知）'}`);

  if (!result.ok) {
    f.out('');
    f.out(`❌ ship 失败 —— 主干未改动`);
    if (result.error) f.out(`   ${result.error.split('\n')[0]}`);
    if (result.conflicts.length > 0) {
      f.out('   冲突文件：');
      for (const c of result.conflicts) f.out(`     - ${c}`);
      f.out('');
      f.out(`   手动解决：git merge ${versionBranch}`);
    }
    await events.append(versionEventKey(versionLabel), 'merge.conflict', 'zelto', {
      version: versionLabel,
      branch: versionBranch,
      files: result.conflicts,
      resolution: result.conflicts.length > 0 ? 'conflict' : 'failed',
      message: result.error ?? 'ship 失败',
      target: result.targetBranch ?? 'main',
    });
    return 1;
  }

  // ── D6-C：打不可变 tag ──
  //
  // tag 打在**锚点**上，不是「本次合并产生的提交」上：
  // 空操作合并时本次没有新提交，但 tag 仍要能代表「这一版整体长什么样」。
  // 前提是版本内容确实在那个提交上（anchorCommit）。
  //
  // D-71：没有诚实锚点（anchorCommit 为 null）时**不打 tag** ——
  // 打一个指向别的提交的 tag，比没有 tag 更坏：
  // `git merge-base --is-ancestor <tag> main` 会说假话。
  const tag = version.tag ?? versionTagName(versionLabel);
  let tagged = false;
  if (!noTag && result.anchorCommit) {
    tagged = tagVersion(tag, result.anchorCommit, process.cwd(), (m) => f.out(m));
  } else if (!noTag) {
    f.out(`  ⚠️  没有诚实的锚点可打 —— 不打 tag "${tag}"（版本内容不在目标分支上）。`);
  }

  // D-73：这一版**有没有 tag**，以 git 里的事实为准 ——
  // 不是以「本次有没有新打」为准。
  //
  // 病灶（实测 nimrtc-zelto v1 / v2，2026-11-17）：
  //   `tagVersion()` 对已存在的 tag 返回 false（「不覆盖」），
  //   于是 `version.tag = tagged ? tag : undefined` 把计划里**已有的**
  //   tag 记录抹成 undefined，事件里也记 `tag: null`。
  //
  //   但 git 里 tag 好好地在那儿（`git tag -l` 看得到）。
  //   结果：计划说「这一版没打 tag」，git 说「tag 在」——
  //   **两个证据打架**（C4：事件是追溯的唯一证据载体，这里事件说了假话）。
  //
  //   实测后果：nimrtc-zelto 的版本计划里
  //     v1: tag=undefined   v2: tag=undefined
  //     v3: tag="v3"        v4: tag="v4"        v5: tag="v5"
  //   差别就是「这一版有没有被 ship 第二次」—— v1 / v2 各被 ship 了两次。
  //
  // 三种情形对得很齐：
  //   本次打了              → git 里有 → 记录 tag
  //   tag 早就有了          → git 里有 → 记录 tag（沿用）
  //   真没有 / `--no-tag`  → git 里没有 → 记 null（不虚报）
  //
  // 注意 `--no-tag` 的语义是「**本次不创建** tag」，
  // 不是「抹掉这一版的 tag 记录」—— 后者又是同一个病灶。
  // tag 是否存在，一律以 git 里的事实为准。
  const tagExists = tagAlreadyExists(tag, process.cwd());
  const versionHasTag = tagExists;
  if (tagExists && !tagged) {
    f.out(`  ℹ️  tag "${tag}" 已存在 —— 沿用它（这一版的追溯锚点不变）。`);
  }

  // ── D3-C：ship 后在合入目标上重跑版本级验收（只提示不阻断）────────
  //
  // 版本分支上验过一遍了；合入时可能撞出集成缺口。
  // 这里在合入目标上再跑一次，把结论记进事件 —— 提示，不阻断。
  const cfg = loadConfigSafe();
  let mainAcceptance: { passed: boolean; results: Array<{ name: string; passed: boolean; code: number | null }> } | null = null;
  if (cfg && cfg.gate.commands.length > 0) {
    // D-63：标题里说真名 —— 「合入 main」在主仓停在 feat/xxx 时是假的。
    const targetLabel = result.targetBranch ?? '目标分支';
    f.out('');
    f.out(`── 合入后验收（${targetLabel}）──`);
    mainAcceptance = await runAcceptanceOnMain(cfg.gate.commands, cfg.gate.timeoutSec);
    if (!mainAcceptance.passed) {
      f.out('');
      f.out(`⚠️  合入 ${targetLabel} 后门禁没过 —— 集成缺口，已改动不回滚（ship 不回滚）：`);
      for (const r of mainAcceptance.results.filter((r) => !r.passed)) {
        f.out(`   - ${r.name}（exit ${r.code ?? 'signal'}）`);
      }
      f.out('');
      f.out(`   这是「版本分支验过、合入时撞出缺口」的典型情况。`);
      f.out('   处理：git revert 或修好后重新合。zelto 不自动回滚（ADR-018：合并不自动撤销）。');
    }
  }

  // 版本状态 → delivered
  //
  // 顺序要紧：先在**内存对象**上把 tag 写好，再落盘。
  //
  // 之前是先 `updateVersionStatus`（读盘 → 改 → 写盘），再 `save(targetPlan)`。
  // 但 `targetPlan` 是**旧对象**（status 还是 integrated）——
  // 后一次 save 把刚写进盘的 delivered 覆盖回了 integrated。
  // 结果：ship 完成了、tag 打了，状态却停在 integrated。
  // D-73：写计划里的 tag 用「这一版**有没有** tag」，不是「本次**有没有新打**」。
  //
  // 二次 ship 时 tag 已存在（tagVersion 返回 false）——
  // 旧写法 `version.tag = tagged ? tag : undefined` 会把已有的记录抹掉，
  // 事件里也记 tag: null，而 git 里 tag 好好地在那儿。
  // 两个证据打架 = 追溯链说假话。
  version.tag = versionHasTag ? tag : undefined;
  version.status = 'delivered';
  await versionStore.save(targetPlan);

  await events.append(versionEventKey(versionLabel), 'version.delivered', 'zelto', {
    version: versionLabel,
    branch: versionBranch,
    // D-73：tag 已存在也算「这一版有 tag」—— 事件不能因为「本次没新打」就否认它。
    tag: versionHasTag ? tag : null,
    shippedTo: result.targetBranch ?? 'main',
    // D-71：mergeCommit 只在**本次合并真的产生了提交**时才有值。
    // 空操作合并记 null —— 那是真话；拿 HEAD 顶替是假话。
    mergeCommit: result.mergeCommit,
    // 锚点：tag 打在哪个提交上（空操作时 = 包含本版本内容的那个提交）
    anchorCommit: result.anchorCommit,
    // 本次合并是空操作（没产生新提交）
    noop: result.noop,
    mainAcceptance: mainAcceptance
      ? {
          passed: mainAcceptance.passed,
          results: mainAcceptance.results.map((r) => ({
            name: r.name,
            passed: r.passed,
            code: r.code,
          })),
        }
      : null,
  });

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          version: versionLabel,
          branch: versionBranch,
          // D-73：与事件、计划一致 —— 「这一版有没有 tag」，不是「本次有没有新打」。
          tag: versionHasTag ? tag : null,
          // 本次是不是新打的（区分「打了」与「沿用已存在的」）
          tagCreated: tagged,
          mergeCommit: result.mergeCommit,
          anchorCommit: result.anchorCommit,
          noop: result.noop,
          mainAcceptance,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  f.out('');
  // D-63：说真名 —— 「已合入主干」在主仓停在 feat/xxx 时是假的。
  f.out(`✅ 版本 ${versionLabel} 已合入 ${result.targetBranch ?? '目标分支'}${versionHasTag ? `，tag "${tag}"` : ''}`);
  // D-71：空操作合并要说真话 —— 本次没产生新提交。
  if (result.noop) {
    f.out(`   本次合并是空操作 —— 产物早已在 ${result.targetBranch ?? '目标分支'} 上，没有产生新提交。`);
  }
  f.out(`   版本工作目录可清理：zelto version cleanup ${versionLabel}`);

  return 0;
}

/**
 * `zelto version cleanup` —— 清理版本工作目录。
 *
 * 只删**目录**，不删分支 —— 分支与 tag 是版本级追溯的锚点（D6-C），
 * 删不删由人决定。
 */
export async function handleVersionCleanup(
  args: string[],
  f: ReturnType<typeof getDefaultFormatter>,
): Promise<number> {
  const versionLabel = args[1];
  if (!versionLabel || versionLabel.startsWith('--')) {
    f.error('USAGE', 'Usage: zelto version cleanup <version-label> [--force]');
    return 1;
  }

  const manager = worktreeManager();
  if (!manager.versionExists(versionLabel)) {
    f.out(`版本 "${versionLabel}" 的工作目录不存在（${manager.versionRelativePathFor(versionLabel)}）`);
    return 0;
  }

  const force = args.includes('--force');
  try {
    await manager.removeVersionWorktree(versionLabel, { force });
    f.out(`✅ 已清理版本工作目录：${manager.versionRelativePathFor(versionLabel)}`);
    f.out(`   版本分支保留（追溯锚点）：${branchOfVersionLabel(versionLabel)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    f.error('FAILED', `清理版本工作目录失败：${msg}`);
    return 1;
  }
  return 0;
}

/** 从 label 派生分支名（cleanup 只知道 label） */
function branchOfVersionLabel(label: string): string {
  return versionBranchName(label);
}

/** 版本事件归属键（与 ai-pipeline.ts 一致） */
function versionEventKey(versionLabel: string): string {
  return `version-${versionLabel}`;
}

/** 读配置（ship 里配置读不到不该炸掉整个 ship） */
function loadConfigSafe(): {
  gate: { commands: Array<{ name: string; run: string }>; timeoutSec: number };
} | null {
  try {
    const cfg = loadConfig();
    return { gate: cfg.gate };
  } catch {
    return null;
  }
}

/** 在主仓跑门禁命令（只提示，不阻断） */
async function runAcceptanceOnMain(
  commands: Array<{ name: string; run: string }>,
  timeoutSec: number,
): Promise<{ passed: boolean; results: Array<{ name: string; passed: boolean; code: number | null }> }> {
  const { exec } = await import('node:child_process');
  const results: Array<{ name: string; passed: boolean; code: number | null }> = [];

  for (const cmd of commands) {
    process.stdout.write(`  ▸ ${cmd.name}: ${cmd.run}\n`);
    const code = await new Promise<number | null>((resolve) => {
      exec(
        cmd.run,
        { cwd: process.cwd(), timeout: timeoutSec * 1000, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
        (err) => {
          if (!err) return resolve(0);
          const c = (err as { code?: unknown }).code;
          resolve(typeof c === 'number' ? c : 1);
        },
      );
    });
    results.push({ name: cmd.name, passed: code === 0, code });
    process.stdout.write(`    ${code === 0 ? '✅' : '❌'} ${cmd.name}（exit ${code ?? 'signal'}）\n`);
  }

  return { passed: results.every((r) => r.passed), results };
}
