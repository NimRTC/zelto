// zelto merge — 显式合并：签字之后的唯一归并路径
//
// ADR-018：签字只改状态，合并必须显式执行。
// 这里承接原先住在签字路径里的全部合并职责——提交 worktree 产物、
// 生成合并计划、执行、清理 worktree 与分支、按需推送。
//
// See docs/adr-012-parallel-coordination.md §3.7
// See docs/adr-018-no-auto-merge-on-sign.md
// C3: deterministic, no model calls, no network

import { join } from 'node:path';
import { formatMergePlan } from '../../core/sched/merge.js';
import { parseDependsOnArgs } from '../../core/sched/depgraph.js';
import { register, store, events, resolveSpecDir, ZELTO_DIR, worktreeManager, validateVersionLabelArg } from './shared.js';
import { SignManager } from '../../core/gate/sign.js';
import { buildMergePlan } from './merge-plan.js';
import { executeMergePlan, branchExists, verifyArtifactsInRef, type MergeSliceInfo } from './merge-executor.js';
import {
  collectMergeCandidates,
  commitPendingWorktrees,
  cleanupMergedSlices,
  pushCurrentBranch,
} from './merge-runner.js';
import {
  resolveSliceOwnership,
  AmbiguousOwnershipError,
  type SliceOwnership,
} from '../../core/version/branch.js';

/**
 * 从分支名反查它属于哪个版本。
 *
 * 显式 `--target version/v2` 时用得上 —— 归属解析会回填版本 label，
 * 但显式指定时没有这一步，这里按命名规则反查。
 */
function ownershipVersionOf(branch: string): string | null {
  if (!branch.startsWith('version/')) return null;
  return branch.slice('version/'.length) || null;
}

/**
 * zelto merge [<id1> <id2> ...] [--strategy <s>] [--target <branch>] [--plan <id>]
 *              [--plan-only] [--dry-run] [--push] [--json]
 * zelto merge plan <id1> [id2 ...] [--json]
 *
 * Merge orchestration for completed parallel slices.
 *
 * Subcommands:
 *   plan     Show merge plan without executing
 *   (default) Execute the merge plan
 *
 * Usage:
 *   zelto merge plan slice-a slice-b
 *   zelto merge slice-a slice-b --strategy merge_commit
 *   zelto merge slice-a slice-b --dry-run
 *   zelto merge                       (合并全部已批准且尚未合入的切片)
 *   zelto merge slice-a --push        (合并后推送当前分支)
 *   zelto merge slice-a --target main (强制合进主干，不走版本分支)
 */
register('merge', async (args) => {
  const subCmd = args[0];
  // 带值的选项 —— 它们的值不是切片 id，必须从 ids 里排除
  //
  // 之前只排除了以 `--` 开头的参数，于是 `--target version/v2` 的
  // 「version/v2」被当成了切片 id，合并时报「Slice(s) not found: version/v2」。
  const VALUE_OPTIONS = ['--strategy', '--target', '--plan', '--depends-on'];

  const ids = args.filter((a, i) => {
    if (a.startsWith('--')) return false;
    if (a === 'plan') return false;
    // 前一个参数是带值选项 → 这个是它的值
    const prev = args[i - 1];
    if (prev && VALUE_OPTIONS.includes(prev)) return false;
    return true;
  });
  const asJson = args.includes('--json');
  const isDryRun = args.includes('--dry-run');
  const isPlanOnly = subCmd === 'plan';
  const doPush = args.includes('--push');

  // --depends-on parsing for dependency graph
  const cliDeps = parseDependsOnArgs(args);

  // Check for --strategy override
  const strategyIdx = args.indexOf('--strategy');
  let strategyOverride: string | undefined;
  if (strategyIdx >= 0 && strategyIdx + 1 < args.length) {
    strategyOverride = args[strategyIdx + 1];
  }

  // --target（ADR-056 §3.2）：显式指定合并目标分支
  const targetIdx = args.indexOf('--target');
  const targetOverride: string | null =
    targetIdx >= 0 && targetIdx + 1 < args.length ? args[targetIdx + 1] : null;

  // --plan（ADR-056 §3.2）：归属解析命中多个计划时消歧
  const planArgIdx = args.indexOf('--plan');
  const planArg: string | null =
    planArgIdx >= 0 && planArgIdx + 1 < args.length ? args[planArgIdx + 1] : null;

  // ── 合并目标解析（ADR-056 §3.2）────────────────────────────────
  //
  // 目标要先算出来 —— 「不带 id 合并全部」的候选收集要用它判
  // 「已合入目标没有」（ADR-056 §3.3）。
  //
  // 四级回退：
  //   1. `--target` 显式指定
  //   2. 版本计划成员扫描
  //   3. 规格 frontmatter 的 `version:` 字段
  //   4. 兜底：合进主仓当前分支（= 改造前的行为，老项目无感）
  const manager = worktreeManager();

  /**
   * 解析一个切片的归属。显式 `--target` 时直接用它。
   */
  const resolveOwnership = (id: string): SliceOwnership => {
    const slice = slices.get(id);
    return resolveSliceOwnership(id, {
      versionsDir: join(ZELTO_DIR, 'versions'),
      specPath: slice?.spec.path ?? null,
      planId: planArg,
      targetBranch: targetOverride,
    });
  };

  /**
   * 由目标分支算出合并目标的工作目录与标识。
   */
  const resolveTarget = (branch: string | null): { dir: string; label: string } => {
    if (!branch) return { dir: process.cwd(), label: 'main' };
    // 版本分支 → 版本工作目录
    const label = ownershipVersionOf(branch);
    if (!label) {
      console.error(`❌ 目标分支 "${branch}" 找不到对应的版本，无法定位版本工作目录。`);
      process.exit(1);
    }
    // label 是从**分支名反查**来的（`--target version/<label>`），
    // 不是从版本计划里读的真源 —— 所以它可能压根不是合法 label。
    // 不校验的话，`version/..` 这种目标分支会让工作目录指到 base 之外。
    if (!validateVersionLabelArg(label, { error: (code, msg) => console.error(`❌ ${msg}`) })) {
      console.error(`   （来自目标分支 "${branch}"）`);
      process.exit(1);
    }
    if (!manager.versionExists(label)) {
      console.error(`❌ 版本 "${label}" 的工作目录不存在：${manager.versionRelativePathFor(label)}`);
      console.error('   先跑 zelto version start ' + label + ' —— 它会建这个目录。');
      process.exit(1);
    }
    return { dir: manager.versionPathFor(label), label: branch };
  };

  if (ids.length === 0 && !isPlanOnly) {
    // ADR-018 §3.1：不带 id 时合并全部「已批准且尚未合入」的切片。
    //
    // 有 `--target` 时按那个目标判「已合入」（ADR-056 §3.3）；
    // 没有时按主仓 HEAD 判 —— 与改造前一致。
    const explicitTarget = targetOverride && targetOverride !== 'main' && targetOverride !== 'HEAD';
    let candidates: MergeSliceInfo[];

    if (explicitTarget) {
      const target = resolveTarget(targetOverride);
      candidates = await collectMergeCandidates({ branch: targetOverride, dir: target.dir });
    } else {
      candidates = await collectMergeCandidates();
    }

    if (candidates.length === 0) {
      console.error('没有待合并的切片（已批准且尚未合入主分支的都合并完了）。');
      console.error('用法：zelto merge <slice-id> [slice-id ...] [--strategy <s>] [--dry-run] [--push] [--json]');
      console.error('      zelto merge plan <slice-id-1> [slice-id-2 ...] [--json]');
      return 1;
    }
    console.log(`待合并的已批准切片：${candidates.map((c) => c.id).join(', ')}`);
    for (const c of candidates) {
      ids.push(c.id);
    }
  }

  if (ids.length === 0) {
    console.error('Usage: zelto merge plan <slice-id-1> [slice-id-2 ...] [--json]');
    console.error('       zelto merge <slice-id-1> [slice-id-2 ...] [--strategy <s>] [--dry-run] [--push] [--json]');
    console.error('');
    console.error('Subcommands:');
    console.error('  plan     Show merge plan without executing');
    console.error('');
    console.error('Strategies: sequential_ff, merge_commit, rebase_onto, manual');
    return 1;
  }

  // Read slice data
  const slices = new Map<string, import('../../core/slice/store.js').SliceData>();
  const mergeInfos: MergeSliceInfo[] = [];
  const notFound: string[] = [];

  for (const id of ids) {
    try {
      const slice = await store.read(id);
      slices.set(id, slice);
      mergeInfos.push({
        id,
        branch: `slice/${id}`,
        baseCommit: slice.baseCommit,
        writes: slice.writes,
      });
    } catch {
      notFound.push(id);
    }
  }

  if (notFound.length > 0) {
    console.error(`Slice(s) not found: ${notFound.join(', ')}`);
    return 1;
  }

  // ── ADR-018 §3.1：签字门 ───────────────────────────────────────────
  //
  // 合并的前提是「这片签过字」。不带 id 的路径靠
  // `collectMergeCandidates` 过滤（它只收 approved 的签字请求），
  // 但**显式给 id 的路径是直连**——只要 id 存在就直接往下走。
  //
  // 实测缺陷 D-6：`zelto merge <id> --plan <plan-id>` 在切片尚未签字时
  // 直接提交并合并了。`--plan` 只是「归属消歧」的透传参数（ADR-056 §3.2），
  // 却被当成了「这条路径已验证过」的信号。
  //
  // 所以这里无条件校验：没有任何一片有 approved 的签字请求 → 拒绝合并。
  // 判据只读 `.zelto/locks/sign-*.json`（文件状态，C1），不调模型（C3）。
  const signManager = new SignManager(ZELTO_DIR, events, store);
  const approvedSigns = await signManager.list('approved');
  const approvedSliceIds = new Set(approvedSigns.map((r) => r.sliceId));

  const unapproved = ids.filter((id) => !approvedSliceIds.has(id));
  if (unapproved.length > 0) {
    console.error('❌ 以下切片没有已批准的签字，不能合并（ADR-018：签字与合并必须分开执行）：');
    for (const id of unapproved) {
      const slice = slices.get(id);
      const state = slice?.state ?? '未知';
      console.error(`   - ${id}（状态：${state}）`);
    }
    console.error('');
    console.error('   先签字：zelto sign <id> --approve');
    console.error('   再合并：zelto merge <id>');
    return 1;
  }

  // ── 合并目标解析（ADR-056 §3.2）────────────────────────────────
  //
  // 每个切片要合进哪里？四级回退：
  //   1. `--target` 显式指定
  //   2. 版本计划成员扫描
  //   3. 规格 frontmatter 的 `version:` 字段
  //   4. 兜底：合进主仓当前分支（= 改造前的行为，老项目无感）
  //
  // 同一个批次里的切片必须合进同一个地方 —— 合到两个分支去，
  // 「版本分支」就名存实亡了。所以这里取**第一个切片的归属**作为
  // 整批的目标，并检查其余切片是否一致。
  const ownerships: SliceOwnership[] = [];
  for (const id of ids) {
    let ownership: SliceOwnership;
    try {
      ownership = resolveOwnership(id);
    } catch (err) {
      if (err instanceof AmbiguousOwnershipError) {
        console.error(`❌ ${err.message}`);
        return 1;
      }
      throw err;
    }
    ownerships.push(ownership);
  }

  const firstOwnership = ownerships[0];
  const divergent = ownerships.filter((o) => o.branch !== firstOwnership.branch);
  if (divergent.length > 0) {
    console.error('❌ 这批切片归属不同的合并目标，不能一次合：');
    for (let i = 0; i < ownerships.length; i++) {
      const o = ownerships[i];
      console.error(`   - ${ids[i]} → ${o.branch ?? 'main（主干）'}`);
    }
    console.error('');
    console.error('   分开跑：zelto merge <id> --target <branch>');
    return 1;
  }

  const targetBranch = firstOwnership.branch;
  const target = resolveTarget(targetBranch);
  const targetDir = target.dir;
  const targetLabel = target.label;

  if (targetBranch) {
    const versionLabel = ownershipVersionOf(targetBranch);
    console.log(
      `合并目标：${targetBranch}（工作目录 ${manager.versionRelativePathFor(versionLabel ?? '')}）`,
    );
  }

  // ── 两条路径的判据对齐（D-11 / ADR-059 §6）────────────────────
  //
  // 不带 id 的路径（`collectMergeCandidates`）会跳过「分支不存在」的切片。
  // 带 id 的路径原先不查 —— 于是同一个切片，两条路径的处置不一致。
  //
  // 而且分支不存在时合并根本无从下手：计划会列出来，
  // 执行阶段才发现合不了 —— 到那时已经跑了 `commitPendingWorktrees`（有副作用）。
  //
  // 所以在这里就拒掉，并说清楚是哪个切片缺分支。
  //
  // ── ADR-071：判据从「分支存在」改成「产物是否已在目标分支」──
  //
  // 有一类切片**天然没有** `slice/<id>` 分支：产物由人直接提交到
  // 目标分支的切片（人自己改了代码、写集撞保护域时 agent 本来也过不了门禁①）。
  //
  // 对这类切片，合并是**空操作** —— 产物已经在目标分支里。
  // 拒绝它等于让人去手工改状态，追溯链断在这里（实测缺陷 D-32）。
  //
  // 但也不能一律放行：「分支不存在就跳过」会让真正合不了的切片
  // 悄悄通过（产物既不在目标分支、又没分支 = 什么都没做）——
  // D-11 刚把「假成功」当严重缺陷修过一轮。
  //
  // 所以：**按写集路径核实产物是否已在目标 ref 上**。
  // 全部就位 → 空操作合并；有任何缺失 → 仍然拒绝。
  const targetRef = targetLabel === 'main' ? 'HEAD' : `refs/heads/${targetLabel}`;
  const noopSlices = new Set<string>();
  const missingBranchIds = ids.filter((id) => !branchExists(`slice/${id}`, process.cwd()));

  if (missingBranchIds.length > 0) {
    const unverifiable: Array<{ id: string; missing: string[] }> = [];

    for (const id of missingBranchIds) {
      const slice = slices.get(id);
      const writes = slice?.writes ?? [];
      const { missing } = verifyArtifactsInRef(writes, targetRef, target.dir);
      if (missing.length === 0) {
        noopSlices.add(id);
      } else {
        unverifiable.push({ id, missing });
      }
    }

    if (unverifiable.length > 0) {
      console.error('❌ 以下切片既没有对应分支，产物也不在目标分支，无法合并：');
      for (const { id, missing } of unverifiable) {
        console.error(`   - ${id}（缺分支 slice/${id}，且这些产物尚未合入：${missing.join('、')}）`);
      }
      console.error('');
      console.error('   分支通常在 `zelto run` 成功后创建。若切片已跑过，');
      console.error('   先确认 worktree 还在：zelto slices');
      console.error('');
      console.error('   若产物已由人工直接提交到目标分支，合并会走空操作路径 ——');
      console.error('   请确认上面的「尚未合入」清单为空（写集路径与目标分支对不上）。');
      return 1;
    }

    for (const id of missingBranchIds) {
      console.log(`  ℹ️  ${id}: 无 slice 分支，但产物已在 ${targetLabel} 上 —— 走空操作合并`);
    }
  }

  // 空操作切片：标记到 mergeInfos 上，执行阶段跳过 git merge
  for (const info of mergeInfos) {
    if (noopSlices.has(info.id)) info.noop = true;
  }

  // ADR-018 §3.2：分支必须先带上产物，否则合并进来的是空分支。
  await commitPendingWorktrees(ids);

  // Generate merge plan — dependencies come from the spec's "前置切片" section,
  // overridable with --depends-on.
  let plan;
  try {
    plan = await buildMergePlan({
      ids,
      slices,
      specDir: resolveSpecDir(),
      cliDeps,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`❌ ${msg}`);
    return 1;
  }

  // Apply strategy override if specified
  if (strategyOverride) {
    const validStrategies = ['sequential_ff', 'merge_commit', 'rebase_onto', 'manual'];
    if (!validStrategies.includes(strategyOverride)) {
      console.error(`Invalid strategy: "${strategyOverride}". Valid: ${validStrategies.join(', ')}`);
      return 1;
    }
    plan.strategy = strategyOverride as typeof plan.strategy;
    for (const phase of plan.phases) {
      phase.strategy = strategyOverride as typeof phase.strategy;
    }
    // Clear estimated conflicts if strategy overridden to merge_commit
    if (strategyOverride === 'merge_commit' || strategyOverride === 'sequential_ff') {
      plan.estimatedConflicts = [];
    }
  }

  if (asJson) {
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  }

  if (isPlanOnly) {
    console.log(formatMergePlan(plan));
    return 0;
  }

  console.log(formatMergePlan(plan));

  if (plan.strategy === 'manual') {
    console.log('');
    console.log('⚠️  Manual intervention required:');
    if (plan.estimatedConflicts.length > 0) {
      console.log(`   Write-set conflicts detected:`);
      for (const f of plan.estimatedConflicts) {
        console.log(`     - ${f}`);
      }
    }
    console.log('');
    console.log('   To resolve:');
    console.log('   1. Manually merge the conflicting files');
    console.log('   2. Create a merge commit');
    console.log('   3. Run zelto merge with --strategy merge_commit after resolution');
    return 1;
  }

  if (isDryRun) {
    console.log('');
    console.log('🔍 Dry-run — no changes made.');
    console.log(`   Run without --dry-run to execute the merge.`);
    return 0;
  }

  console.log('');
  console.log(`Executing merge (strategy: ${plan.strategy})...`);

  const result = await executeMergePlan(plan, mergeInfos, {
    events,
    repoRoot: process.cwd(),
    targetDir,
    targetLabel,
    log: (m) => console.log(m),
  });

  if (result.aborted) {
    console.log('');
    // D-11：中止原因分两类 —— 冲突与「工作区脏」。排查方向完全不同，
    // 而且「工作区脏」这条曾经被报成「✅ Merge complete」，是**假成功**。
    if (result.abortReason) {
      console.log(`❌ Merge aborted — ${result.abortReason}. The target branch was not modified.`);
    } else {
      console.log(`❌ Merge aborted — ${result.conflicts.length} slice(s) conflicted. The target branch was not modified.`);
    }
    return 1;
  }

  // 合并成功的切片：清理 worktree 与分支
  await cleanupMergedSlices(result.merged, targetBranch, targetDir);

  console.log('');
  if (result.merged.length === 0) {
    // 计划里有切片，但一个都没合进去 —— 这不是成功。
    // 「✅ Merge complete (0 slices)」是假成功的话术（D-11）。
    console.log(`⚠️  Merge finished but no slice was merged (${plan.phases.length} phases, 0 slices).`);
    console.log(`   目标分支未被修改。`);
    return 1;
  }
  console.log(`✅ Merge complete (${plan.phases.length} phases, ${result.merged.length} slices)`);

  // ADR-018 §3.3：推送发生在合并之后，推的是合并结果。
  if (doPush) {
    await pushCurrentBranch();
  }

  return 0;
});
