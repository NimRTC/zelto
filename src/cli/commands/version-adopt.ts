// zelto version adopt —— 给老版本补建版本分支（ADR-056 迁移）
//
// 为什么需要这个命令（ADR-056 §8 的破坏性变更）：
//
// ADR-056 引入「版本分支」制度时，老项目**已经有**跑了一半的版本 ——
// 状态是 `in_progress`，切片产物早已合进 main，但**版本分支从不存在**
// （版本分支制度那时候还没有）。
//
// 后果：老项目**永远无法 ship**。
// - `version start` 只在 `planned` 时建分支，`in_progress` 会被拒
// - `version deliver` 走「分支不存在 → 按主干判」的兼容路径，能过
// - 但 `version ship` 要求版本分支存在 —— 报 NOT_FOUND
//
// `version start --retry-failed` 确实能顺带建出分支，但那是**副作用**：
// 命令名说的是「重跑失败的切片」，人不会想到它是迁移入口。
//
// 这个命令把这件事显式化：`zelto version adopt <ver>`。
//
// ── 基点怎么办（关键）─────────────────────────────────────────────
//
// 老项目**从来没有版本级基点**这个概念 —— 那是 ADR-056 引入的。
// 硬造一个「原始基点」是假的精确（切片之间基点都不统一，
// 有的切片 `baseCommit` 是 null、不是 null 的还各不相同）。
//
// 所以：基点取**当前主干 HEAD**，并**如实标注这是补建的基点**。
// 理由：
//
// 1. **内容是对的** —— 老项目的切片产物早已合进 main，
//    从 main HEAD 建的版本分支天然包含它们 → 迁移后 ship 是干净的快进。
// 2. **不假装精确** —— 计划里记 `adopted: true` + `adoptedAt`，
//    事后审计能看出「这个基点是补建的，不是原始基点」。
// 3. **可复现** —— 基点一旦钉死就不再重算（ADR-056 D1-A 的性质）。

import { execFileSync } from 'node:child_process';
import { register, events, ZELTO_DIR, worktreeManager, validateVersionLabelArg } from './shared.js';
import { VersionStore } from '../../core/version/store.js';
import type { VersionPlan } from '../../core/version/types.js';
import { branchOfVersion } from '../../core/version/branch.js';
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
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    return {
      ok: false,
      stdout: e.stdout ? String(e.stdout) : '',
      stderr: e.stderr ? String(e.stderr) : (e.message ?? ''),
    };
  }
}

/** 分支是否存在 */
function branchExists(branch: string, repoRoot: string): boolean {
  return git(['rev-parse', '--verify', `refs/heads/${branch}`], repoRoot).ok;
}

/**
 * `zelto version adopt <version-label> [--plan <plan-id>] [--dry-run]`
 *
 * 给一个**已有版本**补建版本分支与版本工作目录。
 *
 * 适用：老项目升级到 ADR-056 之后，版本状态是 `in_progress` /
 * `integrated`，但版本分支还不存在。
 */
export async function handleVersionAdopt(
  args: string[],
  f: ReturnType<typeof getDefaultFormatter>,
): Promise<number> {
  const versionLabel = args[1];
  if (!versionLabel || versionLabel.startsWith('--')) {
    f.error('USAGE', 'Usage: zelto version adopt <version-label> [--plan <plan-id>] [--dry-run] [--json]');
    return 1;
  }
  if (!validateVersionLabelArg(versionLabel, f)) return 1;

  const planIdx = args.indexOf('--plan');
  const planId = planIdx + 1 < args.length ? args[planIdx + 1] : null;
  const isDryRun = args.includes('--dry-run');
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
      f.error('NOT_FOUND', 'No confirmed plans found.');
      return 1;
    }
    targetPlan = await versionStore.read(confirmed[0].id);
  }

  const version = targetPlan.versions.find((v) => v.version === versionLabel);
  if (!version) {
    f.error('NOT_FOUND', `Version "${versionLabel}" not found in plan "${targetPlan.id}".`);
    return 1;
  }

  const manager = worktreeManager();
  if (!manager.isGitRepo()) {
    f.error('INVALID_STATE', 'Not in a git repository —— 版本分支不可用。');
    return 1;
  }

  const repoRoot = process.cwd();
  const versionBranch = branchOfVersion(version);

  // 已经有分支了 —— 说明早就 adopt 过（或本来就是新项目）
  if (branchExists(versionBranch, repoRoot)) {
    f.out(`ℹ️  版本分支 "${versionBranch}" 已存在 —— 无需补建。`);
    if (!manager.versionExists(versionLabel)) {
      f.out(`   但版本工作目录不存在，将重建。`);
      await adoptWorktree(versionLabel, versionBranch, targetPlan, version, f, repoRoot);
    }
    return 0;
  }

  // 前置版本必须已 integrated/delivered —— 依赖链没满足就别建
  for (const dep of version.dependsOn) {
    const depVersion = targetPlan.versions.find((v) => v.version === dep);
    if (depVersion && depVersion.status !== 'integrated' && depVersion.status !== 'delivered') {
      f.error(
        'BLOCKED',
        `前置版本 "${dep}" 还没 integrated（当前 ${depVersion.status}）—— 先交付它。`,
      );
      return 1;
    }
  }

  const head = git(['rev-parse', 'HEAD'], repoRoot);
  if (!head.ok) {
    f.error('INVALID_STATE', '读不到仓库 HEAD —— 无法确定基点。');
    return 1;
  }
  const baseCommit = head.stdout.trim();

  if (isDryRun) {
    f.out(`🔍 Dry-run —— 不会真的建。`);
    f.out(`   版本分支：${versionBranch}`);
    f.out(`   基点：${baseCommit.slice(0, 8)}（当前主干 HEAD）`);
    f.out(`   工作目录：${manager.versionRelativePathFor(versionLabel)}`);
    return 0;
  }

  f.out(`── adopt 版本 ${versionLabel} ──`);
  f.out(`   这是一个**已有版本**（状态 ${version.status}），补建它的版本分支。`);
  f.out('');
  f.out('   ℹ️  基点取当前主干 HEAD —— 老项目没有版本级基点概念，');
  f.out('      补建的基点是「补建时刻」的主干位置，不是原始基点。');
  f.out('      切片产物早已合进主干，所以版本分支天然包含它们。');
  f.out('');

  const ok = await adoptWorktree(versionLabel, versionBranch, targetPlan, version, f, repoRoot);
  if (ok !== 0) return ok;

  // 基点钉死 + 标记为「补建的」
  version.baseCommit = baseCommit;
  version.adopted = true;
  version.adoptedAt = new Date().toISOString();
  await versionStore.save(targetPlan);

  await events.append(`version-${versionLabel}`, 'version.adopted', 'zelto', {
    version: versionLabel,
    branch: versionBranch,
    baseCommit,
    planId: targetPlan.id,
  });

  f.out('');
  f.out(`✅ 版本 ${versionLabel} 已补建版本分支 "${versionBranch}"（基点 ${baseCommit.slice(0, 8)}）`);
  f.out(`   接下来：zelto version deliver ${versionLabel}   # 验收（跑在版本工作目录）`);
  f.out(`           zelto version ship ${versionLabel}     # 合入主干 + 打 tag`);

  if (asJson) {
    console.log(JSON.stringify({
      version: versionLabel,
      branch: versionBranch,
      baseCommit,
      adopted: true,
      planId: targetPlan.id,
    }, null, 2));
  }

  return 0;
}

/**
 * 建分支 + 建版本工作目录。
 *
 * 分支从 `baseCommit` 建 —— 不带 `-b` 之外的特殊处理；
 * 若分支已存在（并发场景），复用即可。
 */
async function adoptWorktree(
  versionLabel: string,
  versionBranch: string,
  targetPlan: VersionPlan,
  version: VersionPlan['versions'][number],
  f: ReturnType<typeof getDefaultFormatter>,
  repoRoot: string,
): Promise<number> {
  const manager = worktreeManager();

  // 分支：从当前 HEAD 建
  if (!branchExists(versionBranch, repoRoot)) {
    const head = git(['rev-parse', 'HEAD'], repoRoot);
    const res = git(['branch', versionBranch, head.stdout.trim()], repoRoot);
    if (!res.ok) {
      f.error('FAILED', `建版本分支 "${versionBranch}" 失败：${res.stderr.trim().slice(0, 200)}`);
      return 1;
    }
    f.out(`   ✅ 已建分支 ${versionBranch}`);
  }

  // 工作目录
  try {
    const info = await manager.createVersionWorktree(versionLabel, { branch: versionBranch });
    f.out(`   ✅ 工作目录 ${manager.versionRelativePathFor(versionLabel)}`);

    await events.append(`version-${versionLabel}`, 'worktree.created', 'zelto', {
      sliceId: versionLabel,
      path: manager.versionRelativePathFor(versionLabel),
      branch: versionBranch,
      baseCommit: info.baseCommit,
      kind: 'version',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    f.error('FAILED', `创建版本工作目录失败：${msg}`);
    return 1;
  }

  return 0;
}
