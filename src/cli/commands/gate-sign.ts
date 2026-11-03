// Gate and sign commands: gate, inbox, sign

import { createInterface } from 'node:readline';
import { GateExecutor } from '../../core/gate/executor.js';
import { SignManager } from '../../core/gate/sign.js';
import type { GateConfig } from '../../core/gate/types.js';
import { register } from './shared.js';
import { store, events, ZELTO_DIR, loadConfig, resolveTargetDir, existingWorktreePath, worktreeManager, removeWorktree, resolveSpecDir } from './shared.js';
import { SpecMdExecutor } from '../../core/spec/SpecMdExecutor.js';
import { buildMergePlan } from './merge-plan.js';
import { executeMergePlan, branchExists, isMergedIntoHead, type MergeSliceInfo } from './merge-executor.js';
import { resolve } from 'node:path';
import { readdir } from 'node:fs/promises';

// ─── gate ────────────────────────────────────────────────────────────────────

register('gate', async (args) => {
  const hasSpecMd = args.includes('--spec-md');

  // Handle `gate --spec-md` without a slice ID: run spec-md on all slices
  if (hasSpecMd && (!args[0] || args[0].startsWith('--'))) {
    return runSpecMdOnAllSlices();
  }

  const [id] = args;
  if (!id || id === '--help' || id === '-h') {
    if (!id && hasSpecMd) {
      // --spec-md without slice-id is handled above
      return 0;
    }
    console.error('Usage: zelto gate <slice-id> [--retry <N>] [--dry-run] [--spec-md] [--only <name>]');
    console.error('       zelto gate --spec-md                    (validate all specs)');
    return 1;
  }

  const isJson = args.includes('--json');
  const isDryRun = args.includes('--dry-run');
  const retryFlag = args.indexOf('--retry');
  const forceRetry = retryFlag >= 0 && args[retryFlag + 1] ? Math.max(0, parseInt(args[retryFlag + 1], 10) || 0) : -1;
  const onlyFlag = args.indexOf('--only');
  const onlyCommand = onlyFlag >= 0 && args[onlyFlag + 1] ? args[onlyFlag + 1] : null;

  try {
    const slice = await store.read(id);
    if (slice.state !== 'frozen') {
      if (forceRetry >= 0) {
        // Force re-run gate on any state
        console.log(`zelto gate ${id} — re-running gate② (forced, state=${slice.state})...`);
      } else {
        if (isJson) {
          console.log(JSON.stringify({ sliceId: id, passed: false, error: `Slice is in state "${slice.state}", must be "frozen"` }));
        } else {
          console.error(`Slice "${id}" is in state "${slice.state}". Must be "frozen" to run gate.`);
          console.error(`  Use --retry <N> to force re-run regardless of state.`);
        }
        return 1;
      }
    } else {
      console.log(`zelto gate ${id} — running gate②...`);
    }

    const config = loadConfig();

    // Resolve target project directory for cross-project execution
    const targetDir = resolveTargetDir();
    const gateCommands = targetDir && config.targetProject?.gate?.commands
      ? config.targetProject.gate.commands
      : config.gate.commands;
    const gateProfiles = targetDir && config.targetProject?.gate?.profiles
      ? config.targetProject.gate.profiles
      : config.gate.profiles;

    if (targetDir) {
      console.log(`  Target:   ${targetDir}`);
    }

    // Dry run: show what would be executed
    if (isDryRun) {
      if (isJson) {
        console.log(JSON.stringify({
          sliceId: id, dryRun: true,
          commands: gateCommands
            .filter((c) => !onlyCommand || c.name === onlyCommand)
            .map((c) => ({ name: c.name, run: c.run })),
          timeoutSec: config.gate.timeoutSec,
          retry: config.gate.retry,
          only: onlyCommand,
          targetDir,
        }));
      } else {
        const filteredCmds = gateCommands.filter((c) => !onlyCommand || c.name === onlyCommand);
        console.log(`  Dry-run for gate ${id}:`);
        console.log(`  Commands: ${filteredCmds.length}${onlyCommand ? ` (filtered: ${onlyCommand})` : ''}`);
        for (const c of filteredCmds) {
          console.log(`    - ${c.name}: ${c.run}`);
        }
        console.log(`  Timeout: ${config.gate.timeoutSec}s`);
        console.log(`  Retries: ${config.gate.retry.max}`);
        if (targetDir) console.log(`  CWD:     ${targetDir}`);
        console.log(`\n  Run without --dry-run to execute.`);
      }
      return 0;
    }

    const gateConfig = {
      commands: gateCommands
        .filter((c) => !onlyCommand || c.name === onlyCommand)
        .map((c) => ({ name: c.name, run: c.run })),
      profiles: gateProfiles,
      changedLineCoverage: 0.8,
      timeoutSec: config.gate.timeoutSec,
      retry: { max: forceRetry >= 0 ? forceRetry : config.gate.retry.max, budgetStepUsd: 0.05 },
    } satisfies GateConfig;

    if (onlyCommand && gateConfig.commands.length === 0) {
      console.error(`No gate command found with name "${onlyCommand}". Available: ${gateCommands.map((c) => c.name).join(', ')}`);
      return 1;
    }

    if (onlyCommand && !isJson) {
      console.log(`  Only:     ${onlyCommand}`);
    }

    // Run spec-md validation if --spec-md flag is set
    if (hasSpecMd) {
      const specMd = new SpecMdExecutor(resolve(process.cwd(), 'specs', 'slices'));
      const result = await specMd.validate(id);
      if (!result.valid) {
        if (isJson) {
          console.log(JSON.stringify({ sliceId: id, specMdValid: false, specMdErrors: result.errors }));
        } else {
          console.log(`  Spec-MD: ❌ ${id} spec file validation failed`);
          for (const err of result.errors) {
            console.log(`    - ${err}`);
          }
        }
        return 1;
      }
      if (!isJson) {
        console.log(`  Spec-MD: ✅ ${id} spec file validated`);
      }
    }

    const worktreePath = existingWorktreePath(id);
    const gateRoot = worktreePath ?? targetDir ?? undefined;
    const executor = new GateExecutor(store, events, gateConfig, gateRoot);
    const report = await executor.execute(id);
    if (worktreePath && !isJson) {
      console.log(`  Worktree: ${worktreePath}`);
    }

    if (isJson) {
      console.log(JSON.stringify({
        sliceId: id, passed: report.passed,
        commands: report.results.map((r) => ({
          command: r.command, passed: r.passed, exitCode: r.exitCode, durationMs: r.durationMs,
        })),
        retryCount: report.retryCount,
        totalDurationMs: report.totalDurationMs,
      }));
      return report.passed ? 0 : 1;
    }

    console.log(`  Commands: ${report.results.length}`);
    for (const r of report.results) {
      const icon = r.passed ? '✅' : '❌';
      console.log(`    ${icon} ${r.command} (${r.durationMs.toFixed(0)}ms, exit ${r.exitCode ?? 'signal'})`);
      if (!r.passed && r.stderr) {
        // Show truncated stderr for failure debugging
        const stderrLines = r.stderr.split('\n').filter((l) => l.trim()).slice(0, 5);
        for (const line of stderrLines) {
          console.log(`       ${line.slice(0, 200)}`);
        }
      }
    }

    if (report.retryCount > 0) {
      console.log(`  Retries:  ${report.retryCount}`);
    }

    if (report.passed) {
      console.log(`  Result:   ✅ Gate passed (${report.totalDurationMs.toFixed(0)}ms)`);
      const prevState = slice.state;
      await store.transit(id, 'GATE_PASS');
      await events.append(id, 'slice.state.changed', 'cli', {
        sliceId: id, from: prevState, to: 'completed', event: 'GATE_PASS',
      });
      console.log(`  State:    ✅ Slice transitioned to "completed"`);

      const signManager = new SignManager(ZELTO_DIR, events, store);
      const signReq = await signManager.request(id, 'zelto');
      console.log(`  Sign:     📋 Sign request created (${signReq.id})`);
      console.log(`  Next:     Run "zelto sign ${id} --approve" to approve`);
    } else {
      console.log(`  Result:   ❌ Gate failed (${report.totalDurationMs.toFixed(0)}ms)`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isJson) {
      console.log(JSON.stringify({ sliceId: id, error: msg }));
    } else {
      console.error(`Error running gate for "${id}": ${msg}`);
    }
    return 1;
  }
  return 0;
});

// ─── inbox ───────────────────────────────────────────────────────────────────

register('inbox', async (args) => {
  const signManager = new SignManager(ZELTO_DIR, events, store);
  const pending = await signManager.list('pending');

  if (args.includes('--list') || !process.stdout.isTTY) {
    if (pending.length === 0) {
      console.log('Inbox is empty. Nothing pending.');
      return 0;
    }
    console.log('Inbox — Pending Sign Requests:');
    console.log('');
    for (const req of pending) {
      console.log(`  [${req.id}]`);
      console.log(`    Slice:    ${req.sliceId}`);
      console.log(`    Requested: ${req.requestedAt}`);
      console.log(`    By:        ${req.requestedBy}`);
      console.log(`    Action:    zelto sign ${req.sliceId} --approve | --reject`);
      console.log('');
    }
    console.log(`${pending.length} pending request(s).`);
    return 0;
  }

  if (pending.length === 0) {
    console.log('📋 Inbox is empty. Nothing pending.');
    return 0;
  }

  console.log('📋 Inbox — Pending Sign Requests:');
  console.log('');
  for (let i = 0; i < pending.length; i++) {
    const req = pending[i];
    console.log(`  ${i + 1}. [${req.sliceId}] — requested ${req.requestedAt.slice(0, 10)}`);
  }
  console.log('');
  console.log('Enter number to review, or q to quit.');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question('> ', resolve);
  });
  rl.close();

  const idx = Number.parseInt(answer, 10) - 1;
  if (Number.isNaN(idx) || idx < 0 || idx >= pending.length) {
    if (answer === 'q' || answer === 'Q') {
      console.log('Bye.');
      return 0;
    }
    console.log('Invalid selection.');
    return 1;
  }

  const req = pending[idx];
  console.log('');
  console.log(`  Slice:    ${req.sliceId}`);
  console.log(`  Request:  ${req.requestedAt}`);
  console.log(`  By:       ${req.requestedBy}`);

  const rl2 = createInterface({ input: process.stdin, output: process.stdout });
  const decision = await new Promise<string>((resolve) => {
    rl2.question('  Approve? [Y/n] ', resolve);
  });
  rl2.close();

  if (decision === '' || decision.toLowerCase() === 'y' || decision.toLowerCase() === 'yes') {
    await signManager.approve(req.id, 'human', null);
    console.log(`  ✅ ${req.sliceId} approved`);
    await autoMergeSlice(req.sliceId);
  } else {
    const rl3 = createInterface({ input: process.stdin, output: process.stdout });
    const comment = await new Promise<string>((resolve) => {
      rl3.question('  Rejection comment: ', resolve);
    });
    rl3.close();
    await signManager.reject(req.id, 'human', comment || null);
    console.log(`  ❌ ${req.sliceId} rejected`);
  }

  return 0;
});

// ─── auto-merge (shared helper) ──────────────────────────────────────────────

/**
 * Stage the slice's write-set paths inside a directory.
 * Returns true when at least one path was staged.
 */
async function stagePaths(addPaths: string[], cwd: string): Promise<boolean> {
  const { execSync } = await import('node:child_process');
  let staged = false;
  if (addPaths.length > 0) {
    for (const p of addPaths) {
      try {
        execSync(`git add -- ${p}`, { cwd, timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
        staged = true;
      } catch {
        // Path may not exist — skip
      }
    }
  }
  return staged;
}

/** Build the scoped git add paths: write-set + slice file + spec + acceptance tests */
async function buildAddPaths(sliceId: string): Promise<string[]> {
  let sliceWrites: string[] = [];
  let specPath = '';
  try {
    const slice = await store.read(sliceId);
    sliceWrites = slice.writes;
    specPath = slice.spec.path;
  } catch {
    // Fall back to git add -A if slice can't be read
  }

  const addPaths: string[] = [];
  if (sliceWrites.length > 0) {
    addPaths.push(...sliceWrites);
  }
  addPaths.push(`.zelto/slices/${sliceId}.json`);
  if (specPath) addPaths.push(specPath);
  const { existsSync } = await import('node:fs');
  if (existsSync('tests')) {
    addPaths.push(`tests/acceptance/${sliceId}*`);
  }
  return addPaths;
}

/**
 * Commit inside the slice's worktree, then fast-forward the main repo onto the
 * slice branch, then remove the worktree.
 *
 * ADR-011 §3.6 — the worktree holds the agent's changes; the main worktree is
 * never touched directly, and the main repo's branch is not switched.
 */
async function commitWorktreeChanges(sliceId: string, worktreePath: string): Promise<void> {
  const { execSync } = await import('node:child_process');
  const manager = worktreeManager();
  const branch = manager.branchFor(sliceId);
  const addPaths = await buildAddPaths(sliceId);

  console.log(`  Staging: committing changes in worktree (${manager.relativePathFor(sliceId)})...`);
  const staged = await stagePaths(addPaths, worktreePath);
  if (!staged) {
    execSync('git add -A', { cwd: worktreePath, timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
  }

  try {
    execSync(
      `git commit -m "feat(${sliceId}): slice approved

Auto-commit from zelto run

Refs-Slice: ${sliceId}"`,
      { cwd: worktreePath, timeout: 15000 },
    );
    console.log(`  ✅ Committed in worktree branch "${branch}"`);
  } catch {
    console.log(`  ℹ️  Nothing to commit in worktree`);
  }
}

/**
 * 收集所有「已签字但尚未合入主分支」的切片。
 *
 * 判据（全部来自文件与 git，不含内存状态）：
 * - 存在已批准的签字请求（`.zelto/locks/sign-*.json`，status=approved）
 * - 对应的 `slice/<id>` 分支存在
 * - 该分支尚未合入当前 HEAD
 */
async function collectMergeCandidates(): Promise<MergeSliceInfo[]> {
  const signManager = new SignManager(ZELTO_DIR, events, store);
  const approved = await signManager.list('approved');
  const repoRoot = process.cwd();
  const candidates: MergeSliceInfo[] = [];

  for (const req of approved) {
    const manager = worktreeManager();
    const branch = manager.branchFor(req.sliceId);
    if (!branchExists(branch, repoRoot)) continue;
    if (isMergedIntoHead(branch, repoRoot)) continue;

    let baseCommit: string | null = null;
    try {
      const slice = await store.read(req.sliceId);
      baseCommit = slice.baseCommit;
    } catch {
      // 切片文件读不到时仍然合并——分支已经带着产物
    }

    candidates.push({ id: req.sliceId, branch, baseCommit });
  }

  return candidates;
}

/**
 * 提交所有待合并切片各自 worktree 里尚未提交的改动。
 *
 * 合并的前提是分支上带着产物。签字只提交「当前这一个」切片的 worktree，
 * 其它同样已签字待合的切片，其 worktree 改动若不先提交，合并进来的分支
 * 就是空的——产物会静默丢失。
 */
async function commitPendingWorktrees(candidates: MergeSliceInfo[]): Promise<void> {
  const manager = worktreeManager();
  const { execFileSync } = await import('node:child_process');
  for (const c of candidates) {
    if (!manager.exists(c.id)) continue;
    // 干净的 worktree 跳过——已签字的切片可能刚被提交过
    let dirty = true;
    try {
      const out = execFileSync('git', ['status', '--porcelain'], {
        cwd: manager.pathFor(c.id),
        encoding: 'utf-8',
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      dirty = out.trim().length > 0;
    } catch {
      // 读不到状态就当作有改动，交给 commit 流程处理
    }
    if (!dirty) continue;

    try {
      await commitWorktreeChanges(c.id, manager.pathFor(c.id));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ⚠️  ${c.id}: worktree 提交失败：${msg}`);
      console.log(`     手动处理：cd ${manager.relativePathFor(c.id)} && git add -A && git commit`);
    }
  }
}

/**
 * 合入所有待合并切片。
 *
 * 走 `MergePlanner` 生成计划（依赖关系来自规格「前置切片」章节），
 * 再由 `executeMergePlan` 执行。冲突时主分支回滚到合并前状态，
 * 并列出冲突文件——不删分支、不吞异常。
 */
async function mergePendingSlices(): Promise<void> {
  const candidates = await collectMergeCandidates();
  if (candidates.length === 0) return;

  // 分支必须先带上产物，否则合并进来的是空分支
  await commitPendingWorktrees(candidates);

  const ids = candidates.map((c) => c.id);
  const slices = new Map<string, import('../../core/slice/store.js').SliceData>();
  for (const id of ids) {
    try {
      slices.set(id, await store.read(id));
    } catch {
      // 读不到就跳过——写集分析对该切片退化为空
    }
  }

  let plan;
  try {
    plan = await buildMergePlan({
      ids,
      slices,
      specDir: resolveSpecDir(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ⚠️  无法生成合并计划：${msg}`);
    console.log(`     手动合并：git merge ${candidates.map((c) => c.branch).join(' ')}`);
    return;
  }

  const result = await executeMergePlan(plan, candidates, {
    events,
    repoRoot: process.cwd(),
    log: (m) => console.log(m),
  });

  if (result.aborted) {
    console.log(`  ⚠️  合并中止：${result.conflicts.length} 个切片存在冲突，主分支未改变。`);
    return;
  }

  // 合并成功的切片：清理 worktree 与分支
  for (const id of result.merged) {
    const manager = worktreeManager();
    try {
      if (manager.exists(id)) {
        await removeWorktree(id);
        console.log(`  ✅ Removed worktree ${manager.relativePathFor(id)}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ⚠️  Worktree removal failed: ${msg}`);
      console.log(`     Remove it manually: git worktree remove --force ${manager.pathFor(id)}`);
    }

    try {
      const { execSync } = await import('node:child_process');
      execSync(`git branch -d ${manager.branchFor(id)}`, { cwd: process.cwd(), timeout: 5000 });
      console.log(`  ✅ Deleted branch "${manager.branchFor(id)}"`);
    } catch {
      console.log(`  ℹ️  Could not delete branch "${manager.branchFor(id)}" (may have unmerged changes)`);
    }
  }
}

async function autoMergeSlice(sliceId: string): Promise<void> {
  try {
    const { execSync } = await import('node:child_process');

    // Isolated path: the slice ran in its own worktree
    const worktreePath = existingWorktreePath(sliceId);
    if (worktreePath) {
      await commitWorktreeChanges(sliceId, worktreePath);

      const mainBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        encoding: 'utf-8', timeout: 5000, cwd: process.cwd(),
      }).trim();

      if (mainBranch !== 'main' && mainBranch !== 'master') {
        console.log(`  ℹ️  Main repo is on "${mainBranch}" (not main/master) — 合并已跳过。`);
        console.log(`     手动合并：git merge ${worktreeManager().branchFor(sliceId)}`);
        return;
      }

      await mergePendingSlices();
      return;
    }

    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8', timeout: 5000,
    }).trim();

    const addPaths = await buildAddPaths(sliceId);

    if (currentBranch === 'main' || currentBranch === 'master') {
      // On main branch — commit changes directly with slice attribution
      console.log(`  Staging: committing changes to ${currentBranch}...`);
      const staged = await stagePaths(addPaths, process.cwd());
      if (!staged) {
        execSync('git add -A', { cwd: process.cwd(), timeout: 15000 });
      }
      try {
        execSync(`git commit -m "feat(${sliceId}): slice approved

Auto-commit after sign approval for slice ${sliceId}

Refs-Slice: ${sliceId}"`, {
          cwd: process.cwd(), timeout: 15000,
        });
        console.log(`  ✅ Committed to ${currentBranch}`);
      } catch {
        console.log(`  ℹ️  Nothing to commit`);
      }
    } else {
      // On a feature branch — commit then merge to main
      console.log(`  Merging: staging changes...`);
      const staged = await stagePaths(addPaths, process.cwd());
      if (!staged) {
        execSync('git add -A', { cwd: process.cwd(), timeout: 15000 });
      }

      // Commit on feature branch first, then merge to main
      try {
        execSync(`git commit -m "feat(${sliceId}): slice approved

Auto-commit from zelto run

Refs-Slice: ${sliceId}"`, {
          cwd: process.cwd(), timeout: 15000,
        });
      } catch {
        console.log(`  ℹ️  Nothing to commit on feature branch`);
      }

      try {
        execSync('git rev-parse --verify main', { timeout: 3000 });
        execSync(`git checkout main && git merge --ff-only ${currentBranch}`, {
          cwd: process.cwd(), timeout: 15000,
        });
        console.log(`  ✅ Merged "${currentBranch}" → main`);

        // Delete the feature branch
        try {
          execSync(`git branch -d ${currentBranch}`, { cwd: process.cwd(), timeout: 5000 });
          console.log(`  ✅ Deleted branch "${currentBranch}"`);
        } catch {
          console.log(`  ℹ️  Could not delete branch "${currentBranch}" (may have unmerged changes)`);
        }

        // Try to create a GitHub PR if gh CLI is available
        try {
          execSync('gh --version', { stdio: 'ignore', timeout: 3000 });
          const remoteUrl = execSync('git remote get-url origin', { encoding: 'utf-8', timeout: 3000 }).trim();
          if (remoteUrl && remoteUrl.includes('github.com')) {
            console.log(`  ℹ️  PR not created automatically. Create one:`);
            console.log(`     gh pr create --fill --base main`);
          }
        } catch {
          // gh CLI not available — skip
        }
      } catch {
        console.log(`  ℹ️  No main branch to merge into. Current: ${currentBranch}`);
      }
    }
  } catch (mergeErr) {
    console.log(`  ⚠️  Auto-merge skipped: ${mergeErr}`);
  }
}

// ─── spec-md on all slices (for gate --spec-md without slice-id) ──────────────

async function runSpecMdOnAllSlices(): Promise<number> {
  const { readFile } = await import('node:fs/promises');
  const slicesDir = resolve(process.cwd(), 'specs', 'slices');
  const executor = new SpecMdExecutor(slicesDir);
  try {
    const entries = await readdir(slicesDir);
    const mdFiles = entries.filter((f) => f.endsWith('.md'));
    if (mdFiles.length === 0) {
      console.log('No spec files found in specs/slices/.');
      return 0;
    }
    let validated = 0;
    let skipped = 0;
    let allValid = true;
    for (const file of mdFiles) {
      const sliceId = file.replace(/\.md$/, '');
      // Skip old-format spec files that don't have ## Spec section
      const content = await readFile(resolve(slicesDir, file), 'utf-8');
      if (!content.includes('## Spec')) {
        skipped++;
        continue;
      }
      const result = await executor.validate(sliceId);
      if (result.valid) {
        console.log(`  ✅ ${sliceId}`);
        validated++;
      } else {
        console.error(`  ❌ ${sliceId}`);
        for (const err of result.errors) {
          console.error(`     - ${err}`);
        }
        allValid = false;
      }
    }
    if (allValid) {
      console.log(`\n✅ ${validated} spec files validated (spec-md). ${skipped > 0 ? `${skipped} old-format skipped.` : ''}`);
    } else {
      console.error(`\n❌ Some spec files failed validation (spec-md). ${skipped > 0 ? `${skipped} old-format skipped.` : ''}`);
      return 1;
    }
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error running spec-md on all slices: ${msg}`);
    return 1;
  }
}

// ─── auto-push after sign (shared helper) ────────────────────────────────

async function autoPushAfterSign(sliceId: string): Promise<void> {
  try {
    const { execSync } = await import('node:child_process');
    console.log(`  Push:    pushing to remote...`);

    // First check if there's a remote configured
    try {
      execSync('git remote get-url origin', { stdio: 'pipe', timeout: 5000 });
    } catch {
      console.log(`  ℹ️  No remote "origin" configured — skipping push`);
      return;
    }

    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8', timeout: 5000,
    }).trim();

    execSync(`git push origin ${currentBranch}`, {
      cwd: process.cwd(), timeout: 30000, stdio: 'pipe',
    });
    console.log(`  ✅ Pushed "${currentBranch}" → origin/${currentBranch}`);
  } catch (pushErr) {
    const msg = pushErr instanceof Error ? pushErr.message : String(pushErr);
    console.log(`  ⚠️  Push failed: ${msg}`);
    console.log(`       To push manually: git push`);
  }
}

// ─── sign ────────────────────────────────────────────────────────────────────

register('sign', async (args) => {
  const [id, action] = args;
  if (!id || !action) {
    console.error('Usage: zelto sign <slice-id> [--approve|--reject] [--comment <text>] [--push]');
    return 1;
  }

  const isJson = args.includes('--json');
  const doPush = args.includes('--push');
  const signManager = new SignManager(ZELTO_DIR, events, store);
  const commentIndex = args.indexOf('--comment');
  const comment = commentIndex >= 0 ? args[commentIndex + 1] : null;

  try {
    if (action === '--approve') {
      const pending = await signManager.list('pending');
      const req = pending.find((r) => r.sliceId === id);
      if (!req) {
        const newReq = await signManager.request(id, 'human');
        await signManager.approve(newReq.id, 'human', comment);
        if (isJson) {
          console.log(JSON.stringify({ sliceId: id, action: 'approved', autoRequested: true }));
        } else {
          console.log(`zelto sign ${id} -- ✅ Approved (auto-requested)`);
        }
      } else {
        await signManager.approve(req.id, 'human', comment);
        if (isJson) {
          console.log(JSON.stringify({ sliceId: id, action: 'approved' }));
        } else {
          console.log(`zelto sign ${id} -- ✅ Approved`);
        }
      }

      // Auto-merge: stage, commit, and merge to main
      if (!isJson) await autoMergeSlice(id);

      // Auto-push if --push flag is set
      if (doPush) {
        await autoPushAfterSign(id);
      }
    } else if (action === '--reject') {
      const pending = await signManager.list('pending');
      const req = pending.find((r) => r.sliceId === id);
      if (!req) {
        if (isJson) {
          console.log(JSON.stringify({ sliceId: id, action: 'rejected', error: 'No pending sign request' }));
        } else {
          console.error(`No pending sign request for slice "${id}".`);
        }
        return 1;
      }
      await signManager.reject(req.id, 'human', comment);
      if (isJson) {
        console.log(JSON.stringify({ sliceId: id, action: 'rejected' }));
      } else {
        console.log(`zelto sign ${id} -- ❌ Rejected`);
      }
    } else {
      if (isJson) {
        console.log(JSON.stringify({ error: `Unknown action: ${action}` }));
      } else {
        console.error(`Unknown action: ${action}`);
        console.error('Usage: zelto sign <slice-id> [--approve|--reject]');
      }
      return 1;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isJson) {
      console.log(JSON.stringify({ sliceId: id, error: msg }));
    } else {
      console.error(`Error processing sign for "${id}": ${msg}`);
    }
    return 1;
  }
  return 0;
});
