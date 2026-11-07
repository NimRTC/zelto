// 合并运行时辅助 —— 合并真正需要的 git 动作
//
// 这些函数原先住在 `gate-sign.ts` 里，跟着「签字即合并」一起长大。
// ADR-018 把合并从签字路径里拆出来之后，它们跟着合并走，签字不再碰它们。
//
// C3: 这里只做 git 动作，不做判定——策略与冲突判定在 core/sched/merge.ts
// C4: 合并动作的事件由 merge-executor.ts 写
// C6: 本文件在 cli/ 层，不涉及 core/ 的依赖方向
//
// 见 docs/adr-018-no-auto-merge-on-sign.md

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { SignManager } from '../../core/gate/sign.js';
import { branchExists, isMergedIntoHead, type MergeSliceInfo } from './merge-executor.js';
import { store, events, ZELTO_DIR, worktreeManager, removeWorktree } from './shared.js';

/**
 * 暂存一组路径。返回是否至少暂存了一个路径。
 *
 * 路径可能不存在（比如切片没改那个文件），所以逐个 add 并忽略失败。
 */
export async function stagePaths(addPaths: string[], cwd: string): Promise<boolean> {
  const { execSync } = await import('node:child_process');
  let staged = false;
  for (const p of addPaths) {
    try {
      execSync(`git add -- ${p}`, { cwd, timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
      staged = true;
    } catch {
      // 路径可能不存在 —— 跳过
    }
  }
  return staged;
}

/** 提交时要 add 的路径：写集 + 切片文件 + 规格 + 验收测试 */
export async function buildAddPaths(sliceId: string): Promise<string[]> {
  let sliceWrites: string[] = [];
  let specPath = '';
  try {
    const slice = await store.read(sliceId);
    sliceWrites = slice.writes;
    specPath = slice.spec.path;
  } catch {
    // 切片读不到时退化成 git add -A
  }

  const addPaths: string[] = [];
  if (sliceWrites.length > 0) {
    addPaths.push(...sliceWrites);
  }
  addPaths.push(`.zelto/slices/${sliceId}.json`);
  if (specPath) addPaths.push(specPath);
  if (existsSync('tests')) {
    addPaths.push(`tests/acceptance/${sliceId}*`);
  }
  return addPaths;
}

/**
 * 在切片的 worktree 里提交改动。
 *
 * ADR-011 §3.6 —— worktree 装着 agent 的改动，主工作区从不被直接触碰，
 * 主仓库的当前分支也不会被切走。
 */
export async function commitWorktreeChanges(sliceId: string, worktreePath: string): Promise<void> {
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
 * 提交待合并切片各自 worktree 里尚未提交的改动。
 *
 * 合并的前提是分支上带着产物。签字只提交「当前这一个」切片的 worktree，
 * 其它同样已签字待合的切片，其 worktree 改动若不先提交，合并进来的分支
 * 就是空的——产物会静默丢失。
 */
export async function commitPendingWorktrees(ids: string[]): Promise<void> {
  const manager = worktreeManager();
  for (const id of ids) {
    if (!manager.exists(id)) continue;
    // 干净的 worktree 跳过——已签字的切片可能刚被提交过
    let dirty = true;
    try {
      const out = execFileSync('git', ['status', '--porcelain'], {
        cwd: manager.pathFor(id),
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
      await commitWorktreeChanges(id, manager.pathFor(id));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ⚠️  ${id}: worktree 提交失败：${msg}`);
      console.log(`     手动处理：cd ${manager.relativePathFor(id)} && git add -A && git commit`);
    }
  }
}

/**
 * worktree 里有没有未提交的改动。
 *
 * agent 的产物先落在 worktree 的工作区里，签字不提交它 —— 提交发生在合并前
 * （`commitPendingWorktrees`）。所以「分支是否已合入 HEAD」这个判据不足以
 * 回答「该不该合」：
 *
 *   切片冻结在基点 C，agent 改完文件但还没提交 → 分支指针仍停在 C，
 *   而 C 通常就是 HEAD。`isMergedIntoHead` 于是说「已合入」，这个切片
 *   从待合并清单里消失 —— 人跑到 `zelto merge` 才看见「没有待合并的切片」。
 *
 * 判据是 git 的真实工作区状态（确定性，C3）。
 */
export function worktreeHasChanges(sliceId: string): boolean {
  const manager = worktreeManager();
  const path = manager.pathFor(sliceId);
  if (!existsSync(path)) return false;
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd: path,
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.trim().length > 0;
  } catch {
    // 读不到状态就不算有改动 —— 宁可漏报也不误报
    return false;
  }
}

/**
 * 收集所有「已签字但尚未合入主分支」的切片。
 *
 * 判据（全部来自文件与 git，不含内存状态）：
 * - 存在已批准的签字请求（`.zelto/locks/sign-*.json`，status=approved）
 * - 对应的 `slice/<id>` 分支存在
 * - 该分支尚未合入当前 HEAD，**或者** worktree 里还有未提交的产物
 *   （产物在合并前才提交，见 `worktreeHasChanges`）
 */
export async function collectMergeCandidates(): Promise<MergeSliceInfo[]> {
  const signManager = new SignManager(ZELTO_DIR, events, store);
  const approved = await signManager.list('approved');
  const repoRoot = process.cwd();
  const candidates: MergeSliceInfo[] = [];

  for (const req of approved) {
    const manager = worktreeManager();
    const branch = manager.branchFor(req.sliceId);
    if (!branchExists(branch, repoRoot)) continue;
    // 分支已合入 HEAD 且 worktree 干净 —— 确实合完了。
    // 分支已合入但 worktree 还有改动 —— 产物没提交，得合。
    if (isMergedIntoHead(branch, repoRoot) && !worktreeHasChanges(req.sliceId)) continue;

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
 * 合并成功后清理 worktree 与分支。
 *
 * 清理失败只提示、不吞异常——分支还在，人还能自己收。
 */
export async function cleanupMergedSlices(ids: string[]): Promise<void> {
  const manager = worktreeManager();
  for (const id of ids) {
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

/**
 * 把当前分支推到远端。
 *
 * 只在合并成功后调用——推的必须是合并结果，而不是签字那一刻的分支状态。
 */
export async function pushCurrentBranch(): Promise<void> {
  try {
    const { execSync } = await import('node:child_process');
    console.log(`  Push:    pushing to remote...`);

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
