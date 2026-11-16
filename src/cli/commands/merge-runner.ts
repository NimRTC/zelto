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
import { branchExists, isMergedIntoHead, isMergedIntoRef, verifyArtifactsInRef, type MergeSliceInfo } from './merge-executor.js';
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
 *
 * **提交的是 agent 的产物，所以按 agent 口径判定**（D-24）：
 * 环境里显式注入 `ZELTO_SLICE_ID` / `ZELTO_SESSION_ID`，
 * 让 pre-commit hook 知道「这次提交的内容来自 agent」——
 * 保护域对它仍然生效。
 *
 * 不这么做会怎样：合并流程跑在**人的 shell** 里（没有 agent 标记），
 * hook 按「人提交」放行 → agent 越界改的保护域文件借合并流程进了主干。
 * 写集审计（ADR-014 §5）本来就能拦住越界写入，但那是**运行后**的兜底；
 * 这里多一道**提交时**的判据，两道独立。
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
      {
        cwd: worktreePath,
        timeout: 15000,
        // 按 agent 口径判定（D-24）：提交的是 agent 的产物，
        // 保护域对它仍然生效。合并流程跑在人的 shell 里，
        // 不标记就会被当成「人提交」而放行。
        env: {
          ...process.env,
          ZELTO_SLICE_ID: sliceId,
          ZELTO_SESSION_ID: `merge-${sliceId}`,
        },
      },
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
 * 收集所有「已签字但尚未合入目标分支」的切片。
 *
 * 判据（全部来自文件与 git，不含内存状态）：
 * - 存在已批准的签字请求（`.zelto/locks/sign-*.json`，status=approved）
 * - 对应的 `slice/<id>` 分支存在
 * - 该分支尚未合入目标分支，**或者** worktree 里还有未提交的产物
 *   （产物在合并前才提交，见 `worktreeHasChanges`）
 *
 * @param target 合并目标（ADR-056 §3.3）。缺省 = 主仓 HEAD —— 改造前的行为。
 *   传版本分支时，「已合入」按那个分支判，不按 main 判。
 */
export async function collectMergeCandidates(
  target?: { branch: string | null; dir: string },
): Promise<MergeSliceInfo[]> {
  const signManager = new SignManager(ZELTO_DIR, events, store);
  const approved = await signManager.list('approved');
  const repoRoot = process.cwd();
  const candidates: MergeSliceInfo[] = [];

  for (const req of approved) {
    const manager = worktreeManager();
    const branch = manager.branchFor(req.sliceId);

    // ADR-071：**没有分支的切片**也要纳入候选 —— 它可能是
    // 「产物已由人直接提交到目标分支」的切片，合并对它是空操作。
    //
    // 判据：按写集路径核实产物是否已在目标 ref 上。
    // 已就位 → 空操作合并候选；没就位 → 真的合不了，跳过。
    if (!branchExists(branch, repoRoot)) {
      // 已经空操作合过一次的不再重复列 —— 否则每次 `zelto merge`
      // 都会把它列一遍（产物一直在目标分支上，判据永远成立），
      // 人会以为它没合过。
      if (await hasNoopMergeEvent(req.sliceId)) continue;

      const noop = await isNoopCandidate(req.sliceId, target);
      if (noop) {
        candidates.push({ id: req.sliceId, branch, baseCommit: null, writes: noop.writes, noop: true });
      }
      continue;
    }

    // 分支已合入目标 且 worktree 干净 —— 确实合完了。
    // 分支已合入但 worktree 还有改动 —— 产物没提交，得合。
    const mergedAlready = target?.branch
      ? isMergedIntoRef(branch, `refs/heads/${target.branch}`, target.dir)
      : isMergedIntoHead(branch, repoRoot);
    if (mergedAlready && !worktreeHasChanges(req.sliceId)) continue;

    let baseCommit: string | null = null;
    let writes: string[] = [];
    try {
      const slice = await store.read(req.sliceId);
      baseCommit = slice.baseCommit;
      writes = slice.writes;
    } catch {
      // 切片文件读不到时仍然合并——分支已经带着产物
    }

    candidates.push({ id: req.sliceId, branch, baseCommit, writes });
  }

  return candidates;
}

/**
 * 这个切片是不是已经空操作合过一次（ADR-071）。
 *
 * 判据：事件流里有 `mode: 'noop'` 的 `merge.completed`。
 *
 * 为什么需要这条：空操作切片的产物**已经在**目标分支上，
 * 判据「产物在目标分支上」永远成立 —— 不加这条，
 * 每次 `zelto merge` 都会把它重新列一遍，
 * 人会以为它一直没合过。
 *
 * C4：事件流是追溯的唯一证据载体，这里只读不算新判定。
 */
async function hasNoopMergeEvent(sliceId: string): Promise<boolean> {
  const list = await events.read(sliceId);
  return list.some(
    (e) => e.type === 'merge.completed' && e.payload?.mode === 'noop',
  );
}

/**
 * 这个没有分支的切片是不是「产物已在目标分支」的空操作切片（ADR-071）。
 *
 * 判据与 `merge.ts` 的前置守卫同源：**按写集路径核实产物**。
 * 两处必须一致 —— 不一致会出现「不带 id 时列得出来、
 * 带上 id 时说合不了」的分裂。
 */
async function isNoopCandidate(
  sliceId: string,
  target?: { branch: string | null; dir: string },
): Promise<{ writes: string[] } | null> {
  let writes: string[] = [];
  try {
    const slice = await store.read(sliceId);
    writes = slice.writes;
  } catch {
    // 读不到切片 → 没有写集可核实 → 不算空操作
    return null;
  }
  if (writes.length === 0) return null;

  const repoRoot = target?.dir ?? process.cwd();
  const targetRef = target?.branch ? `refs/heads/${target.branch}` : 'HEAD';
  const { missing } = verifyArtifactsInRef(writes, targetRef, repoRoot);
  if (missing.length > 0) return null;
  return { writes };
}

/**
 * 合并成功后清理 worktree 与分支。
 *
 * 清理失败只提示、不吞异常——分支还在，人还能自己收。
 *
 * @param ids 合入的切片 id
 * @param targetBranch 合并目标分支（ADR-056 §3.3）。给了就按它判
 *   「分支已合入」—— 合进版本分支时，HEAD 是主仓当前分支，
 *   `git branch -d` 会因为「没合入 HEAD」而拒绝删。
 */
export async function cleanupMergedSlices(
  ids: string[],
  targetBranch?: string | null,
): Promise<void> {
  const manager = worktreeManager();
  for (const id of ids) {
    try {
      if (manager.exists(id)) {
        // 强制删除：到这一步这个切片已经合进目标分支了，worktree 里剩下的
        // 未跟踪文件是 zelto 自己放的托管文件（规格副本、约束包镜像），
        // 不是 agent 的产物 —— agent 的产物在合并前已经提交并合入。
        // 不带 force 的话 `git worktree remove` 会拒绝删，worktree 与
        // 分支双双残留（分支还因为被 worktree 占用而删不掉）。
        await removeWorktree(id, { force: true });
        console.log(`  ✅ Removed worktree ${manager.relativePathFor(id)}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ⚠️  Worktree removal failed: ${msg}`);
      console.log(`     Remove it manually: git worktree remove --force ${manager.pathFor(id)}`);
    }

    // ADR-071：空操作合并的切片**从来没有分支**（产物由人直接提交到
    // 目标分支）。这时不该报「删不掉分支」—— 那会把「本来就没有」
    // 说成「有但删不掉」，两种情形的排查方向完全不同。
    if (!branchExists(manager.branchFor(id), process.cwd())) {
      continue;
    }

    try {
      const { execSync } = await import('node:child_process');
      // worktree 删掉之后 git 才肯放分支；再 prune 一次清掉残留登记。
      execSync('git worktree prune', { cwd: process.cwd(), timeout: 5000, stdio: 'ignore' });
      if (targetBranch) {
        // 合进版本分支时，`-d` 会以「没合入 HEAD」拒绝 —— 显式指定目标 ref。
        execSync(`git branch -d ${manager.branchFor(id)} ${targetBranch}`, {
          cwd: process.cwd(),
          timeout: 5000,
        });
      } else {
        execSync(`git branch -d ${manager.branchFor(id)}`, { cwd: process.cwd(), timeout: 5000 });
      }
      console.log(`  ✅ Deleted branch "${manager.branchFor(id)}"`);
    } catch (err) {
      // D-33：区分「分支没合到当前分支」与「分支有未合入的改动」。
      //
      // 原来两种情况都是同一句「may have unmerged changes」——
      // 而它们要人做的事完全不同：
      //   - 「没合到当前分支」：产物已经合进**别的**分支（典型是版本分支），
      //     这里只是 `git branch -d` 的默认判据（按 HEAD）不认。
      //     人要做的：确认目标分支对不对，或者用 `-D` 强删。
      //   - 「有未合并的改动」：分支上真有没合进去的东西，
      //     人要做的：先合或先查。
      const msg = err instanceof Error ? err.message : String(err);
      if (/not fully merged|not merged/i.test(msg)) {
        console.log(`  ℹ️  Could not delete branch "${manager.branchFor(id)}": not fully merged into ${targetBranch ?? 'HEAD'}.`);
        console.log(`     The slice's work is merged elsewhere — delete manually if intended: git branch -D ${manager.branchFor(id)}`);
      } else {
        console.log(`  ℹ️  Could not delete branch "${manager.branchFor(id)}" (${msg.split('\n')[0]})`);
        console.log(`     Delete manually: git branch -D ${manager.branchFor(id)}`);
      }
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
