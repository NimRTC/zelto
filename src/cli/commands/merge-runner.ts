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
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SignManager } from '../../core/gate/sign.js';
import { branchExists, isMergedIntoHead, isMergedIntoRef, verifyArtifactsInRef, type MergeSliceInfo } from './merge-executor.js';
import { collectMergeCandidates as collectMergeCandidatesCore } from '../../core/pending/merge-candidates.js';
import { resolveSliceOwnership } from '../../core/version/branch.js';
import { store, events, ZELTO_DIR, worktreeManager, removeWorktree } from './shared.js';

/**
 * 暂存一组路径。返回是否至少暂存了一个路径。
 *
 * 路径可能不存在（比如切片没改那个文件），所以逐个 add 并忽略失败。
 */
export async function stagePaths(addPaths: string[], cwd: string): Promise<boolean> {
  let staged = false;
  for (const p of addPaths) {
    try {
      // D-69：同样不用 execSync。路径里带空格 / 特殊字符时，
      // shell 字符串会被拆成多个参数，add 的就不是那个路径了。
      execFileSync('git', ['add', '--', p], { cwd, timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
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
  const manager = worktreeManager();
  const branch = manager.branchFor(sliceId);
  const addPaths = await buildAddPaths(sliceId);

  console.log(`  Staging: committing changes in worktree (${manager.relativePathFor(sliceId)})...`);
  const staged = await stagePaths(addPaths, worktreePath);
  if (!staged) {
    execFileSync('git', ['add', '-A'], { cwd: worktreePath, timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
  }

  try {
    // D-69：这里必须用 execFileSync + 参数数组，不能用 execSync + shell 字符串。
    //
    // execSync 在 Windows 上走 cmd.exe，命令里的换行会被 cmd 吞掉：
    // `git commit -m "a\n\nb"` 实际提交的信息只剩第一行 `a`，
    // trailer（Refs-Slice: <id>）被静默丢掉 —— 追溯链断在这里，
    // 而提交照样成功，没人看得见（slice commit 的 trailer 缺失实测）。
    //
    // 追溯是这个工具的立身之本，trailer 丢了不能只是"少一行字"。
    // 多个 -m 参数由 git 自己拼段落，同样能避开 cmd 的换行处理。
    execFileSync(
      'git',
      [
        'commit',
        '-m',
        `feat(${sliceId}): slice approved`,
        '-m',
        'Auto-commit from zelto run',
        '-m',
        `Refs-Slice: ${sliceId}`,
      ],
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
 * **判据在 `core/pending/merge-candidates.ts`** —— 这里只做转接。
 *
 * 为什么要搬进 core：
 *   这套判据里藏着 **D-74 的整个教训**（事件 + git 事实双证、
 *   目标按切片自己的归属比、分支已合但 worktree 还有产物时仍然该合）。
 *   它复杂且易错 —— 留在 CLI 层，Web 驾驶舱要显示「待合并」时
 *   只能再写一份，写歪了就会出现「CLI 说已合、驾驶舱说待合」。
 *
 * @param target 合并目标（ADR-056 §3.3）。缺省 = 主仓 HEAD —— 改造前的行为。
 *   传版本分支时，「已合入」按那个分支判，不按 main 判。
 */
export async function collectMergeCandidates(
  target?: { branch: string | null; dir: string },
): Promise<MergeSliceInfo[]> {
  const manager = worktreeManager();
  const candidates = await collectMergeCandidatesCore({
    store,
    events,
    repoRoot: process.cwd(),
    worktreePath: (sliceId: string) => (manager.exists(sliceId) ? manager.pathFor(sliceId) : null),
    branchFor: (sliceId: string) => manager.branchFor(sliceId),
    versionsDir: join(ZELTO_DIR, 'versions'),
    zeltoDir: ZELTO_DIR,
  }, target);

  // core 的候选形状与 CLI 的 MergeSliceInfo 同构 —— 但 `noop` 在 core 里
  // 是必填布尔，CLI 侧是可选字段。显式转换，别让两个形状漂移。
  return candidates.map((c) => ({
    id: c.id,
    branch: c.branch,
    baseCommit: c.baseCommit,
    writes: c.writes,
    ...(c.noop ? { noop: true } : {}),
  }));
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
 * @param targetDir 合并目标的工作目录（版本分支 = 版本工作目录）。
 *   判「已合入」必须在**这个目录**里做 —— 见 D-40。
 */
export async function cleanupMergedSlices(
  ids: string[],
  targetBranch?: string | null,
  targetDir?: string | null,
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
      // ZD-016：补救命令必须**真的能删掉目录**。
      //
      // 原来这里给的是 `git worktree remove --force <path>` —— 但
      // `git worktree remove` 是「先摘 git 侧登记，再删目录」的：
      // 目录删不掉时**登记已经被摘掉了**，于是这条命令重跑必然报
      // 「fatal: '<path>' is not a working tree」。
      //
      // 人照着做 → 报一个看不懂的错 → 目录还在（几个 GB）。
      //
      // 给两条：一条是 git 侧（登记可能还在），一条是直接删目录
      // （目录才是真正占地方的东西）。
      console.log(`     If git still tracks it:  git worktree remove --force ${manager.pathFor(id)}`);
      console.log(`     Or delete the directory:  rmdir /s /q "${manager.pathFor(id)}"`);
    }

    // ADR-071：空操作合并的切片**从来没有分支**（产物由人直接提交到
    // 目标分支）。这时不该报「删不掉分支」—— 那会把「本来就没有」
    // 说成「有但删不掉」，两种情形的排查方向完全不同。
    if (!branchExists(manager.branchFor(id), process.cwd())) {
      continue;
    }

    // D-40：判「已合入」必须在**合并目标的工作目录**里做。
    //
    // 原来这里用的是 `git branch -d <切片分支> <目标分支>` —— 这个形式有
    // 两个问题，第二个是**危险**的：
    //
    //   1. `git branch -d A B` 会**同时删掉 A 和 B**。实测：切片分支删掉了，
    //      目标分支 `version/v1` 也进了删除列表 —— 只因为它正被版本 worktree
    //      占用才没删成。哪天那个 worktree 不在了，版本分支就会被误删。
    //   2. 「已合并」的判据仍然是 **HEAD**，不是 A 与 B 的关系 ——
    //      所以在版本分支场景下它照样拒删，然后报出误导性的
    //      「The slice's work is merged elsewhere」（其实没合到别处，
    //      就合在目标分支里，是判据选错了）。
    //
    // 正确做法：在目标目录里做「目标分支是否已是切片分支的祖先」判定，
    // 已合入就 `git branch -d <切片分支>`（单一参数、判据是当前 HEAD），
    // 没合入就如实说「分支上还有未合入的内容」——
    // 那才是真正需要人处理的情形（D-33 的两类要分开）。
    const sliceBranch = manager.branchFor(id);
    const dir = targetDir && existsSync(targetDir) ? targetDir : process.cwd();
    const upstream = targetBranch ?? null;
    const merged = upstream
      ? isMergedIntoRef(sliceBranch, `refs/heads/${upstream}`, dir)
      : isMergedIntoHead(sliceBranch, dir);

    if (!merged) {
      // ── 失败之一：**判据没过** ──
      // 分支上还有未合入目标分支的内容 —— 这是真需要人处理的情形
      // （要么先合，要么人工确认后强制删）。
      console.log(
        `  ℹ️  分支 "${sliceBranch}" 上还有未合入 "${upstream ?? 'HEAD'}" 的内容 —— 先合，或确认后手动 \`git branch -D ${sliceBranch}\``,
      );
      console.log(`     先合或先查；确认要删再手动执行：git branch -D ${sliceBranch}`);
      continue;
    }

    try {
      const { execSync } = await import('node:child_process');
      // worktree 删掉之后 git 才肯放分支；再 prune 一次清掉残留登记。
      execSync('git worktree prune', { cwd: process.cwd(), timeout: 5000, stdio: 'ignore' });
      // 在目标目录里执行：`git branch -d` 的「已合并」判据是**当前 HEAD**，
      // 在版本 worktree 里跑，判据就是「已并入版本分支」。
      execFileSync('git', ['branch', '-d', sliceBranch], { cwd: dir, timeout: 5000 });
      console.log(`  ✅ Deleted branch "${sliceBranch}"`);
    } catch (err) {
      // ── 失败之二：**git 拒绝删** ──
      // 判据已经通过（分支确实合入了目标分支），但 git 自己拒绝删除。
      // 原因通常是 worktree 还占着、或者被别的进程锁住。
      //
      // 这与上面「还有未合入的内容」是**两种不同情形**，排查方向也不同：
      // 前者要「去合」，后者要「去查锁」。
      const msg = err instanceof Error ? err.message : String(err);
      const reason = msg.split('\n')[0];
      console.log(
        `  ℹ️  分支已合入 "${upstream ?? 'HEAD'}"，但 git 拒绝删除（原因：${reason}）—— 通常是 worktree 还没释放；确认后手动 \`git branch -D ${sliceBranch}\``,
      );
      console.log(`     Delete manually: git branch -D ${sliceBranch}`);
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

    execFileSync('git', ['push', 'origin', currentBranch], {
      cwd: process.cwd(), timeout: 30000, stdio: 'pipe',
    });
    console.log(`  ✅ Pushed "${currentBranch}" → origin/${currentBranch}`);
  } catch (pushErr) {
    const msg = pushErr instanceof Error ? pushErr.message : String(pushErr);
    console.log(`  ⚠️  Push failed: ${msg}`);
    console.log(`       To push manually: git push`);
  }
}
