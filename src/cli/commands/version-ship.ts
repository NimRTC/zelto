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
function shipBranch(versionBranch: string, repoRoot: string, log: (m: string) => void): {
  ok: boolean;
  mergeCommit: string | null;
  conflicts: string[];
  error: string | null;
} {
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
      return { ok: false, mergeCommit: null, conflicts: [], error: '主仓工作区不干净' };
    }
  }

  const current = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
  const target = current.ok ? current.stdout.trim() : 'HEAD';

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
    log('  ℹ️  主干已前进，改用合并提交（--no-ff）。');
  }

  const res = git(args, repoRoot);
  if (!res.ok) {
    const files = conflictedFiles(repoRoot);
    git(['merge', '--abort'], repoRoot);
    const message = res.stderr.trim() || res.stdout.trim() || '合并失败';
    return { ok: false, mergeCommit: null, conflicts: files, error: message };
  }

  const commitRes = git(['rev-parse', 'HEAD'], repoRoot);
  return {
    ok: true,
    mergeCommit: commitRes.ok ? commitRes.stdout.trim() : (head ?? null),
    conflicts: [],
    error: null,
  };
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
      f.out(`🔍 Dry-run —— 不会真的合入。`);
      f.out(`   版本分支：${versionBranch}`);
      f.out(`   合入目标：主仓当前分支`);
      f.out(`   标签：${noTag ? '（不打）' : versionTagName(versionLabel)}`);
    }
    return 0;
  }

  f.out(`── ship 版本 ${versionLabel} ──`);
  f.out(`   版本分支：${versionBranch}`);
  f.out(`   合入目标：主仓当前分支`);

  const result = shipBranch(versionBranch, process.cwd(), (m) => f.out(m));

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
      target: 'main',
    });
    return 1;
  }

  // ── D6-C：打不可变 tag ──
  const tag = version.tag ?? versionTagName(versionLabel);
  let tagged = false;
  if (!noTag && result.mergeCommit) {
    tagged = tagVersion(tag, result.mergeCommit, process.cwd(), (m) => f.out(m));
  }

  // ── D3-C：ship 后在主干重跑版本级验收（只提示不阻断）────────────
  //
  // 版本分支上验过一遍了；主干合入时可能撞出集成缺口。
  // 这里在主干再跑一次，把结论记进事件 —— 提示，不阻断。
  const cfg = loadConfigSafe();
  let mainAcceptance: { passed: boolean; results: Array<{ name: string; passed: boolean; code: number | null }> } | null = null;
  if (cfg && cfg.gate.commands.length > 0) {
    f.out('');
    f.out('── 主干验收（D3-C：只提示，不阻断）──');
    mainAcceptance = await runAcceptanceOnMain(cfg.gate.commands, cfg.gate.timeoutSec);
    if (!mainAcceptance.passed) {
      f.out('');
      f.out('⚠️  合入主干后门禁没过 —— 集成缺口，主干已改动（ship 不回滚）：');
      for (const r of mainAcceptance.results.filter((r) => !r.passed)) {
        f.out(`   - ${r.name}（exit ${r.code ?? 'signal'}）`);
      }
      f.out('');
      f.out('   这是「版本分支验过、主干合入时撞出缺口」的典型情况。');
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
  version.tag = tagged ? tag : undefined;
  version.status = 'delivered';
  await versionStore.save(targetPlan);

  await events.append(versionEventKey(versionLabel), 'version.delivered', 'zelto', {
    version: versionLabel,
    branch: versionBranch,
    tag: tagged ? tag : null,
    shippedTo: 'main',
    mergeCommit: result.mergeCommit,
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
          tag: tagged ? tag : null,
          mergeCommit: result.mergeCommit,
          mainAcceptance,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  f.out('');
  f.out(`✅ 版本 ${versionLabel} 已合入主干${tagged ? `，tag "${tag}"` : ''}`);
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
