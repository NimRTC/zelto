// 待合并候选的判定 —— CLI 与 Web 驾驶舱共用
//
// 为什么从 `cli/commands/merge-runner.ts` 搬进 core：
//
// 「这片还合不合并」这个判据里藏着 **D-74 的整个教训**：
//
//   1. 判据是**事件 + git 事实双证**，不是「产物在不在目标上」
//      （ADR-071 那条判据一旦产物落地就永远成立 → 已交付的切片被反复列为「待合并」）；
//   2. 目标要**按切片自己的归属**比 —— 合进 `version/v1` ≠ 合进 `main`；
//   3. 「分支已合入但 worktree 还有未提交产物」→ 仍然**该合**
//      （产物在合并前才提交）。
//
// 这套判据复杂且易错 —— 留在 CLI 层，Web 驾驶舱要显示「待合并」时
// 只能再写一份，写歪了就会出现「CLI 说已合、驾驶舱说待合」。
//
// C3：只读文件与 git，不调模型、不触网。
// C2：core/ 内，不依赖 adapters/。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { EventStream } from '../events/stream.js';
import type { SliceStore } from '../slice/store.js';
import { resolveSliceOwnership } from '../version/branch.js';
import {
  buildBranchIndex,
  git,
  isBranchMergedIntoRef,
  verifyArtifactsWithTree,
  worktreeHasChangesAt,
  type BranchIndex,
  type RefTree,
} from '../git/facts.js';

/** 一个待合并候选的切片信息。 */
export interface MergeCandidate {
  id: string;
  /** 分支名，通常为 `slice/<id>` */
  branch: string;
  /** 切片冻结时的基点 commit */
  baseCommit: string | null;
  /** 写集路径 */
  writes: string[];
  /** 是否是「产物已在目标分支」的空操作合并（ADR-071） */
  noop: boolean;
}

/** 收集待合并候选所需的依赖（注入 —— core/ 不认识全局单例）。 */
export interface MergeCandidateSource {
  store: SliceStore;
  events: EventStream;
  /** 仓库根（跑 git 用） */
  repoRoot: string;
  /** 切片的 worktree 绝对路径；没有则 null */
  worktreePath(sliceId: string): string | null;
  /** 切片分支名 */
  branchFor(sliceId: string): string;
  /** 版本计划目录（`.zelto/versions`）—— 归属解析用 */
  versionsDir: string;
  /** `.zelto` 根目录 —— 签字请求（locks）在这里 */
  zeltoDir: string;
}

/** 合并目标（ADR-056 §3.3）。缺省 = 主仓 HEAD。 */
export interface MergeTarget {
  /** 目标分支名；null = 主仓当前检出的分支 */
  branch: string | null;
  /** 目标工作目录 */
  dir: string;
}

/**
 * 收集所有「已签字但尚未合入目标分支」的切片。
 *
 * 判据（全部来自文件与 git，不含内存状态）：
 * - 存在已批准的签字请求（`.zelto/locks/sign-*.json`，status=approved）
 * - **没有合过**（事件流 + git 事实双证，见 `alreadyLandedIn`）
 * - 该分支尚未合入目标分支，**或者** worktree 里还有未提交的产物
 *
 * @param target 合并目标。缺省 = 主仓 HEAD —— 改造前的行为。
 */
export async function collectMergeCandidates(
  source: MergeCandidateSource,
  target?: MergeTarget,
  /** 预建好的分支索引 —— 复用同一轮里已问过的 git 事实，省一次往返 */
  branchIndex?: BranchIndex,
): Promise<MergeCandidate[]> {
  const approved = await listApprovedSignRequests(source);
  const candidates: MergeCandidate[] = [];

  // ── 一次性把 git 事实问清 ──────────────────────────────────────
  //
  // 真实仓库里有上百个已批准的签字请求。逐片问 git
  // （分支存不存在 / 合没合进目标 / 产物在不在树上）
  // = 几百次子进程启动 —— 实测 `zelto next` 要跑 60 多秒，
  // Web 驾驶舱的待办接口直接超时。
  //
  // 现在：**一次 `for-each-ref` + 每个 ref 一次 `branch --merged`
  // + 每个 ref 一次 `ls-tree`** 答完全部问题，
  // 之后全是内存查询。判据没变（仍然是 git 事实），只是问法批量化。
  const index = branchIndex ?? buildBranchIndex(source.repoRoot);
  const treeCache = new Map<string, RefTree>();
  const deletedCache = new Map<string, Set<string>>();
  const reachableCache = new Map<string, Set<string>>();

  for (const req of approved) {
    const branch = source.branchFor(req.sliceId);

    // ── D-74：合过的切片不再列为候选 ──────────────────────────
    const ownTarget = resolveEffectiveTarget(source, req.sliceId, target);
    if (
      await alreadyLandedIn(
        source,
        req.sliceId,
        ownTarget,
        index,
        treeCache,
        deletedCache,
        reachableCache,
      )
    )
      continue;

    // ADR-071：**没有分支的切片**也要纳入候选 —— 它可能是
    // 「产物已由人直接提交到目标分支」的切片，合并对它是空操作。
    if (!index.branches.has(branch)) {
      // 已经空操作合过一次的不再重复列 —— 否则每次 `zelto merge`
      // 都会把它列一遍（产物一直在目标分支上，判据永远成立）。
      if (await hasNoopMergeEvent(source, req.sliceId)) continue;

      const noop = await isNoopCandidate(source, req.sliceId, target, treeCache, deletedCache);
      if (noop) {
        candidates.push({
          id: req.sliceId,
          branch,
          baseCommit: null,
          writes: noop.writes,
          noop: true,
        });
      }
      continue;
    }

    // 分支已合入目标 且 worktree 干净 —— 确实合完了。
    // 分支已合入但 worktree 还有改动 —— 产物没提交，得合。
    //
    // 「合没合入」走**批量索引**（`git branch --merged <ref>` 一次答完），
    // 不再是每片一次 `merge-base --is-ancestor`。
    const mergedAlready = target?.branch
      ? isBranchMergedIntoRef(index, branch, `refs/heads/${target.branch}`, target.dir)
      : index.mergedIntoHead.has(branch);
    if (mergedAlready && !worktreeHasChangesAt(source.worktreePath(req.sliceId))) continue;

    let baseCommit: string | null = null;
    let writes: string[] = [];
    try {
      const slice = await source.store.read(req.sliceId);
      baseCommit = slice.baseCommit;
      writes = slice.writes;
    } catch {
      // 切片文件读不到时仍然合并 —— 分支已经带着产物
    }

    candidates.push({ id: req.sliceId, branch, baseCommit, writes, noop: false });
  }

  return candidates;
}

/** 列出状态为 approved 的签字请求（真源是 `.zelto/locks/sign-*.json`）。 */
async function listApprovedSignRequests(
  source: MergeCandidateSource,
): Promise<Array<{ sliceId: string }>> {
  // 直接读 locks 目录 —— core/gate/sign.ts 的 SignManager 需要 events/store，
  // 而这里只需要「已批准的签字请求」这一个事实。
  const dir = join(source.zeltoDir, 'locks');
  if (!existsSync(dir)) return [];
  const out: Array<{ sliceId: string }> = [];
  for (const f of readdirSync(dir)) {
    if (!f.startsWith('sign-') || !f.endsWith('.json')) continue;
    try {
      const raw = readFileSync(join(dir, f), 'utf-8');
      const d = JSON.parse(raw.replace(/^\uFEFF/, '')) as {
        status?: string;
        sliceId?: string;
      };
      if (d?.status !== 'approved') continue;
      if (typeof d.sliceId !== 'string' || !d.sliceId) continue;
      out.push({ sliceId: d.sliceId });
    } catch {
      // 读不出就跳过（不猜）
    }
  }
  return out;
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
  source: MergeCandidateSource,
  sliceId: string,
  target?: MergeTarget,
): string | null {
  if (target?.branch) return target.branch;
  return ownMergeTargetOf(source, sliceId);
}

/**
 * 这个切片**自己的**合并目标是哪个分支。
 *
 * 归属解析（ADR-056 §3.2）：版本计划成员扫描 → 规格 frontmatter → 兜底主干。
 *
 * 归属解析不出来 → null（= 兜底主干）→ 与事件里缺 `target` 的历史事件对齐。
 */
function ownMergeTargetOf(source: MergeCandidateSource, sliceId: string): string | null {
  try {
    const slice = storeSyncRead(source, sliceId);
    const ownership = resolveSliceOwnership(sliceId, {
      versionsDir: source.versionsDir,
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
function storeSyncRead(
  source: MergeCandidateSource,
  sliceId: string,
): { spec: { path: string } } | null {
  const path = join(source.store.slicesDir, `${sliceId}.json`);
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
 * 判据是**事件流**（这个切片合过没有），不是「产物在不在目标上」。
 *
 * 目标要**按切片自己的归属**对齐 —— 合进 `version/v1` 不等于合进 `main`。
 * 事件里记了 `target`，用它比。
 *
 * C4：事件流是追溯的唯一证据载体，这里只读不算新判定。
 */
async function alreadyLandedIn(
  source: MergeCandidateSource,
  sliceId: string,
  ownTarget: string | null,
  branchIndex: BranchIndex,
  treeCache: Map<string, RefTree>,
  deletedCache: Map<string, Set<string>>,
  reachableCache: Map<string, Set<string>>,
): Promise<boolean> {  const history = await mergeHistoryFor(source, sliceId);
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
      if (isAncestorOfRef(h.mergeCommit, ownTarget, source.repoRoot, reachableCache)) return true;
      // mergeCommit 不在目标上 —— 可能是历史重写/rebase 导致的孤儿 commit。
      // 此时的兜底判据是**产物是否在目标 ref 的树上**（写集核实）。
      if (await artifactsPresentOn(source, sliceId, ownTarget, treeCache, deletedCache)) return true;
      continue;
    }

    // 又没落点又没 commit → 只剩空操作事件可作证
    if (h.mode === 'noop' && label === 'main') return true;
  }
  void branchIndex;
  return false;
}

/** 这个切片的合并历史（事件流里 `merge.completed` 的关键字段）。 */
async function mergeHistoryFor(
  source: MergeCandidateSource,
  sliceId: string,
): Promise<Array<{ target?: string; mode?: string; mergeCommit?: string }>> {
  const list = await source.events.read(sliceId);
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
 * 切片的写集产物是不是已经在目标 ref 的树上。
 *
 * 与 `isNoopCandidate` 同源，但判的是**自己的归属目标**，
 * 且不要求分支缺失 —— 它是「历史事件 + 孤儿 commit」的降级判据。
 */
async function artifactsPresentOn(
  source: MergeCandidateSource,
  sliceId: string,
  ownTarget: string | null,
  treeCache: Map<string, RefTree>,
  deletedCache: Map<string, Set<string>>,
): Promise<boolean> {
  let writes: string[] = [];
  try {
    const slice = await source.store.read(sliceId);
    writes = slice.writes;
  } catch {
    return false;
  }
  if (writes.length === 0) return false;

  const ref = ownTarget ? `refs/heads/${ownTarget}` : 'HEAD';
  const { missing } = verifyArtifactsWithTree(writes, ref, source.repoRoot, treeCache, deletedCache);
  return missing.length === 0;
}

/**
 * 一个 commit 是不是某个 ref 的祖先。
 *
 * ref 用分支名（`version/v1`）或 null（= 主仓 HEAD）。
 * 分支不存在时退化到同名 tag（版本交付后分支可能被删）。
 *
 * **批量**：用 `git rev-list <ref>` 一次拿到该 ref 能到达的**全部** commit，
 * 之后「是不是祖先」变成一次 Set 查询。
 *
 * 逐条 commit 一次 `merge-base --is-ancestor` 在几十片历史切片上
 * 就是几十次子进程启动（`zelto next` 实测这一项占 8 秒）。
 * 判据没变 —— `rev-list` 的可达性集合与 `merge-base --is-ancestor`
 * 问的是同一件事（C3）。
 */
function isAncestorOfRef(
  commit: string,
  ref: string | null,
  repoRoot: string,
  reachableCache: Map<string, Set<string>>,
): boolean {
  const key = ref ?? 'HEAD';
  let reachable = reachableCache.get(key);
  if (!reachable) {
    reachable = new Set<string>();
    const targets = ref === null ? ['HEAD'] : [`refs/heads/${ref}`, ...versionTagRefsFor(ref)];
    for (const target of targets) {
      const res = git(['-c', 'core.quotePath=false', 'rev-list', target], repoRoot);
      if (!res.ok) continue;
      for (const line of res.stdout.split('\n')) {
        const c = line.trim();
        if (c) reachable.add(c);
      }
    }
    reachableCache.set(key, reachable);
  }
  return reachable.has(commit);
}

/** `version/<label>` 分支对应的 tag ref 候选（版本交付后分支可能被删）。 */
function versionTagRefsFor(branch: string): string[] {
  if (!branch.startsWith('version/')) return [];
  const label = branch.slice('version/'.length).trim();
  if (!label) return [];
  return [`refs/tags/${label}`];
}

/**
 * 这个切片是不是已经空操作合过一次（ADR-071）。
 *
 * 判据：事件流里有 `mode: 'noop'` 的 `merge.completed`。
 *
 * C4：事件流是追溯的唯一证据载体，这里只读不算新判定。
 */
async function hasNoopMergeEvent(
  source: MergeCandidateSource,
  sliceId: string,
): Promise<boolean> {
  const list = await source.events.read(sliceId);
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
  source: MergeCandidateSource,
  sliceId: string,
  target?: MergeTarget,
  treeCache: Map<string, RefTree> = new Map(),
  deletedCache: Map<string, Set<string>> = new Map(),
): Promise<{ writes: string[] } | null> {
  let writes: string[] = [];
  try {
    const slice = await source.store.read(sliceId);
    writes = slice.writes;
  } catch {
    // 读不到切片 → 没有写集可核实 → 不算空操作
    return null;
  }
  if (writes.length === 0) return null;

  const repoRoot = target?.dir ?? source.repoRoot;
  const targetRef = target?.branch ? `refs/heads/${target.branch}` : 'HEAD';
  const { missing } = verifyArtifactsWithTree(writes, targetRef, repoRoot, treeCache, deletedCache);
  if (missing.length > 0) return null;
  return { writes };
}
