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

    // ── D-74：合过的切片不再列为候选 ──────────────────────────
    //
    // 判据是**事件 + git 事实双证**（详见 `alreadyLandedIn`）：
    // 这个切片合过没有，且产物确实落在**它自己的合并目标**上。
    //
    // 为什么不能用「产物在不在目标上」单条判据：
    // 那条判据（ADR-071）是为「无分支切片」设计的 ——
    // 产物由人直接提交到目标分支，合并是空操作。
    // 它有致命漏洞：**产物一旦在目标上，就永远在**。
    //
    // 实测（nimrtc-zelto，2026-11-18）：8 个**已经交付**的切片
    // 被列为「待合并」—— 因为它们的产物在 main 上（ship 时带过去的），
    // 而收集候选时按 main 判「产物在不在」→ 在 → 判成「还没合」。
    //
    // 目标要**按切片自己的归属**比 —— 合进 `version/v1` ≠ 合进 `main`。
    const ownTarget = resolveEffectiveTarget(req.sliceId, target);
    if (await alreadyLandedIn(req.sliceId, ownTarget)) continue;

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
 * 这个切片对**它自己的合并目标**来说，还合不合并。（D-74）
 *
 * 判据是**事件流**（这个切片合过没有），不是「产物在不在目标上」。
 *
 * ── 病灶（实测 nimrtc-zelto，2026-11-18）────────────────────
 *
 * `collectMergeCandidates()` 判断「这个切片还合不合并」时，
 * 只看**产物在不在目标 ref 上**（ADR-071 的空操作判据）。
 * 这条判据有一个致命的漏洞：**产物一旦在目标上，就永远在**。
 *
 * 而切片合入的**目标**（`version/v1` / `version/v2` …）与
 * 收集候选时判的那个目标（默认 = 主仓 HEAD = `main`）**不是同一个**。
 *
 * 于是：
 *   1. v1-game-source 的产物被合进 `version/v1`（产物确实在 `version/v1` 上）；
 *   2. `version/v1` 后来 ship 进了 main（squash 合并后产物也在 main 上）；
 *   3. 收集候选时按 **main** 判「产物在不在」→ 在 → 判成「还没合」；
 *   4. 但它**明明已经合进版本分支、并且版本已经交付了**。
 *
 * 实测后果：`zelto merge --list` 列出 8 个「待合并」的切片，
 * 而这 8 个**全部已经交付**（v1 / v2 / v3 / v4 的切片）。
 * 人看到「待合并 8 个」，会以为还有活没干；
 * 实际去合，还会撞上「这批切片归属不同的合并目标，不能一次合」。
 *
 * 精确对应关系（实测）：
 *
 * | 切片的 merge.completed mode | 是否被列为待合并 |
 * |---------------------------|----------------|
 * | `merged`（合进版本分支）    | **是** ❌        |
 * | `noop`（产物已在目标上）     | 否 ✅            |
 * | 无事件（从没合过）           | 否 ✅            |
 *
 * 规律精确到「有没有 noop 事件」——
 * 因为 `hasNoopMergeEvent` 恰好把 noop 的排除了，而 merged 的没排除。
 *
 * ── 修法 ────────────────────────────────────────────────────
 *
 * 判据改成：**这个切片合过没有**（事件流里有 `merge.completed`），
 * 而不是「产物在不在目标上」。
 *
 * 目标要**按切片自己的归属**对齐 ——
 * 合进 `version/v1` 不等于合进 `main`。
 * 事件里记了 `target`，用它比。
 *
 * 为什么事件是可靠的判据：合并动作**必然**写 `merge.completed`
 * （ADR-071 §3 D3：空操作也写 —— 追溯链不因为「这次没搬东西」而断）。
 * 所以「有没有这个事件」就是「合过没有」的事实。
 *
 * C4：事件流是追溯的唯一证据载体，这里只读不算新判定。
 */
async function mergeHistoryFor(
  sliceId: string,
): Promise<Array<{ target?: string; mode?: string; mergeCommit?: string }>> {
  const list = await events.read(sliceId);
  return list
    .filter((e) => e.type === 'merge.completed')
    .map((e) => ({
      target: typeof e.payload?.target === 'string' ? e.payload.target : undefined,
      mode: typeof e.payload?.mode === 'string' ? e.payload.mode : undefined,
      mergeCommit:
        typeof e.payload?.mergeCommit === 'string' ? e.payload.mergeCommit : undefined,
    }));
}

/**
 * 这个切片**自己的**合并目标是哪个分支。
 *
 * 归属解析（ADR-056 §3.2）：版本计划成员扫描 → 规格 frontmatter → 兜底主干。
 *
 * 为什么要按切片**自己**的归属判「合过没有」（D-74）：
 * 切片合进的是 `version/v1`，而收集候选时可能正按 `main` 判。
 * 拿 `main` 去比 `version/v1` 的合并记录，当然对不上 ——
 * 于是已经合完的切片被反复列为「待合并」。
 *
 * 归属解析不出来 → null（= 兜底主干）→ 与事件里缺 `target` 的历史事件对齐。
 */
function ownMergeTargetOf(sliceId: string): string | null {
  try {
    const slice = storeSyncRead(sliceId);
    const ownership = resolveSliceOwnership(sliceId, {
      versionsDir: join(ZELTO_DIR, 'versions'),
      specPath: slice?.spec.path ?? null,
    });
    return ownership.branch;
  } catch {
    // 归属解析不出来（歧义 / 计划坏了）→ 按主干判。
    // 不猜 —— 归属不明时，最保守的读法是「合到主干」。
    return null;
  }
}

/** 同步读一个切片（只拿规格路径）。读不到就返回 null。 */
function storeSyncRead(sliceId: string): { spec: { path: string } } | null {
  const path = join(ZELTO_DIR, 'slices', `${sliceId}.json`);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw.replace(/^\uFEFF/, '')) as { spec: { path: string } };
  } catch {
    return null;
  }
}

/**
 * 这个切片**合过没有**，且产物**确实落在**该落的地方。（D-74 判据）
 *
 * @param sliceId 切片 id
 * @param ownTarget 该切片**自己**的合并目标（由归属解析得出）
 */
async function alreadyLandedIn(
  sliceId: string,
  ownTarget: string | null,
): Promise<boolean> {
  const history = await mergeHistoryFor(sliceId);
  if (history.length === 0) return false; // 从没合过

  const label = ownTarget ?? 'main';
  for (const h of history) {
    // 事件记了落点 → 直接比
    if (h.target !== undefined) {
      if (h.target === label) return true;
      continue;
    }

    // 历史事件没记落点 → 用 mergeCommit 的祖先关系验证（git 事实，不猜）
    if (h.mergeCommit) {
      if (isAncestorOfRef(h.mergeCommit, ownTarget)) return true;
      // mergeCommit 不在目标上 —— 可能是历史重写/rebase 导致的孤儿 commit。
      //
      // 此时的兜底判据是**产物是否在目标 ref 的树上**（写集核实）——
      // 这是 git 事实，与 ADR-071 的空操作判据同源，但只在这里
      // 作为「历史事件 + 孤儿 commit」的**降级**用。
      //
      // 注意它与 ADR-071 的差别：那边是**唯一**判据（所以漏判），
      // 这边是**降级**判据（前面已经有「合过没有」这个前提把着）。
      if (await artifactsPresentOn(sliceId, ownTarget)) return true;
      continue;
    }

    // 又没落点又没 commit → 只剩空操作事件可作证
    if (h.mode === 'noop' && label === 'main') return true;
  }
  return false;
}

/**
 * 切片的写集产物是不是已经在目标 ref 的树上。
 *
 * 与 `isNoopCandidate` 同源，但判的是**自己的归属目标**，
 * 且不要求分支缺失 —— 它是「历史事件 + 孤儿 commit」的降级判据。
 */
async function artifactsPresentOn(
  sliceId: string,
  ownTarget: string | null,
): Promise<boolean> {
  let writes: string[] = [];
  try {
    const slice = await store.read(sliceId);
    writes = slice.writes;
  } catch {
    return false;
  }
  if (writes.length === 0) return false;

  const repoRoot = process.cwd();
  const ref = ownTarget ? `refs/heads/${ownTarget}` : 'HEAD';
  const { missing } = verifyArtifactsInRef(writes, ref, repoRoot);
  return missing.length === 0;
}

/**
 * 一个 commit 是不是某个 ref 的祖先。
 *
 * ref 用分支名（`version/v1`）或 null（= 主仓 HEAD）。
 * 分支不存在时退化到同名 tag（版本交付后分支可能被删）。
 */
function isAncestorOfRef(commit: string, ref: string | null): boolean {
  const repoRoot = process.cwd();
  const candidates =
    ref === null ? ['HEAD'] : [`refs/heads/${ref}`, ...versionTagRefsFor(ref)];

  for (const candidate of candidates) {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', commit, candidate], {
        cwd: repoRoot,
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: 15_000,
      });
      return true;
    } catch {
      // 不是祖先 —— 试下一个候选 ref
    }
  }
  return false;
}

/** `version/<label>` 分支对应的 tag ref 候选（版本交付后分支可能被删）。 */
function versionTagRefsFor(branch: string): string[] {
  if (!branch.startsWith('version/')) return [];
  const label = branch.slice('version/'.length).trim();
  if (!label) return [];
  return [`refs/tags/${label}`];
}

/**
 * 这个切片**本次应该合到哪**（D-74）。
 *
 * 显式给了 `--target` → 就按它判（人的显式意图最高）。
 * 没给 → 按切片**自己的归属**判（版本计划成员扫描 → 规格 frontmatter → 兜底主干）。
 *
 * 为什么不能一律按「本次收集的默认目标」判：
 * 那正是 D-74 的病灶 —— 收集时默认按主仓 HEAD（`main`）判，
 * 而切片合进的是 `version/v1`。两个目标对不上，
 * 已经交付的切片就被反复列为「待合并」。
 */
function resolveEffectiveTarget(
  sliceId: string,
  target?: { branch: string | null; dir: string },
): string | null {
  if (target?.branch) return target.branch;
  return ownMergeTargetOf(sliceId);
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
      console.log(`     Remove it manually: git worktree remove --force ${manager.pathFor(id)}`);
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
      console.log(
        `  ℹ️  Could not delete branch "${sliceBranch}": it still has changes not merged into ${upstream ?? 'HEAD'}.`,
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
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ℹ️  Could not delete branch "${sliceBranch}" (${msg.split('\n')[0]})`);
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
