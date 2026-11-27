// ADR-126：分支上的「产物证据」—— 「这片做完了」能不能在版本分支上查证
//
// 病灶（实测 nimrtc-v14，2026-11-26）：
//
//   ADR-114 给计划对照加了 `onBranch` 一列（切片**状态文件**是否已提交进
//   所属分支）。但 `.zelto/` 整体在 `.gitignore` 里 —— 状态文件**永远不会**
//   进版本分支。于是这列**恒为 0**：v1/v2/v3/v4 全部是 0，
//   没有信息量，却占着一个看起来很权威的位置。
//
//   更糟的是它给出的是一个**误导性**的结论：
//   「分支上完成 0 / 盘上完成 10」读起来像「这版什么都没做完」，
//   而真相是「这版的产物**就在**分支上，只是状态文件没进 git」。
//
// 判据（ADR-126）：
//
//   **产物证据** = 该切片 id 出现在版本分支的提交历史里，
//   以 `Refs-Slice: <id>` trailer 标记（AGENTS.md 规定的提交约定）。
//
//   为什么用 trailer 而不是「提交里改了哪些文件」：
//   - trailer 是**显式**的 —— 「这个提交属于哪一片」由提交者声明，
//     不靠猜文件路径（写集之外的改动会污染文件推断）；
//   - 一个片可能有多个提交（实现 + 测试 + 文档）—— trailer 全部相同，
//     「这一片在分支上」= 分支历史里出现过这个 trailer；
//   - 它**不依赖 `.zelto/` 是否进 git** —— 正好绕开上面那个死结。
//
// 口径（三态，与 ADR-114 同形）：
//   - `true`  = 这一片在**所属版本的分支**上出现过 trailer
//   - `false` = 分支上查不到（片还没合进去 / 合错了分支 / 没合）
//   - `null`  = 拿不到证据（不是 git 仓库 / 读分支失败）
//
// 「所属版本的分支」从版本计划算（ADR-121 的归属解析）——
// 不是「当前 HEAD」，也不是「哪个分支上有就在哪」：
// 归属错了要暴露出来，不能靠「哪儿有算哪儿」把错位藏起来。
//
// C1: 状态只落在文件里（这里只读 git）
// C2: core 零第三方依赖（只用 node:child_process）
// C3: 判定确定性（只读 git，纯计算）

import { execFileSync, spawn } from 'node:child_process';

/** 一个切片在分支上的产物证据。 */
export interface SliceArtifactEvidence {
  /** 这一片在所属分支上有没有产物（null = 不知道） */
  onBranch: boolean | null;
  /** 命中的提交（短哈希）—— 没有则 null */
  commit: string | null;
  /** 命中提交的信息首行 —— 没有则 null */
  subject: string | null;
  /**
   * 这一片的产物是不是在**所属分支的祖先**上（null = 不知道）。
   *
   * 「不在所属分支上、但在它的祖先上」= 这一片**已经**随祖先版本进入了本版，
   * 只是本版没有自己的 trailer 提交。栈式版本里绝大多数片都是这种形态 ——
   * `onBranch=false` 单独读会得出「这版没做」的假结论，必须并排展示。
   */
  ancestorOnBranch: boolean | null;
  /** 祖先分支上的命中提交（短哈希）—— 没有则 null */
  ancestorCommit: string | null;
}

/** 探针（注入以便测试）。 */
export interface ArtifactEvidenceProbe {
  /**
   * 这个分支上，带 `Refs-Slice: <sliceId>` trailer 的提交。
   * 读不到（不是 git 仓库 / git 失败）返回 null。
   */
  findSliceCommits(
    dir: string,
    branch: string,
    sliceIds: string[],
    memo?: ArtifactGitMemo,
  ): Promise<Map<string, { hash: string; subject: string }> | null>;
  /**
   * 这个分支的**祖先分支**上（不含它自己），带 trailer 的提交。
   * 「祖先分支」= 本地 `version/*` 中是本分支祖先、且不是本分支的那些。
   * 读不到返回 null。
   */
  findSliceCommitsOnAncestors(
    dir: string,
    branch: string,
    sliceIds: string[],
    memo?: ArtifactGitMemo,
  ): Promise<Map<string, { hash: string; subject: string; fromBranch: string }> | null>;
}

const GIT_TIMEOUT_MS = 8000;

/**
 * git 调用备忘 —— **一轮判定里问过的 git 事实不再问第二次**。
 *
 * 病灶（实测本仓库 2026-11-27）：`/api/plan-coverage` 一次要 spawn
 * **63 个 git 进程**、耗时 **68 秒**（机器满载时更久）。拆开看：
 *
 *   25 × `rev-parse --is-inside-work-tree`   ← 全是**同一个目录**
 *   10 × `rev-parse --verify version/v2^{commit}`
 *    7 × `for-each-ref refs/heads/version/`  ← 全是**同一个目录**
 *    6 × `log <branch> --format=…trailers`
 *
 * 为什么重复这么多：`planCoverage` 对**每个版本的每个版本**分别问一次
 * 「这个分支在不在」「哪些分支是它的祖先」「祖先上有哪些 trailer」——
 * 而答案**只取决于目录和分支名**，跟「问的是第几片」毫无关系。
 *
 * 于是同一轮的 4 个版本把同样的问题问了 4 遍（`findSliceCommits` 与
 * `findSliceCommitsOnAncestors` 又各问一遍）。
 *
 * 这个备忘**只在一轮判定内有效**（由调用方创建、传进来）：
 * 跨轮复用会让「分支状态变了」看不到 —— 那就是拿过期事实说新话。
 *
 * 判据没变：git 事实还是 git 事实，只是**同一轮里问一次**。
 */
export class ArtifactGitMemo {
  private readonly seen = new Map<string, Promise<{ ok: boolean; stdout: string }>>();

  /**
   * 跑一条 git 命令；同一轮里 `(cwd, args)` 相同就复用上一次的结果。
   *
   * 并发也复用 —— 两个调用同时问同一件事时，**共用同一个进程**
   * （否则会同时抢 index.lock —— 那会把「读」变成偶发的失败）。
   */
  run(
    cwd: string,
    args: string[],
    budgetMs: number = GIT_TIMEOUT_MS,
  ): Promise<{ ok: boolean; stdout: string }> {
    const key = cwd + '\0' + args.join('\0');
    const hit = this.seen.get(key);
    if (hit) return hit;
    const p = execAsync(args, cwd, budgetMs);
    this.seen.set(key, p);
    return p;
  }
}

const execAsync = (
  args: string[],
  cwd: string,
  budgetMs: number,
): Promise<{ ok: boolean; stdout: string }> =>
  new Promise((resolve) => {
    let out = '';
    let settled = false;
    let child: ReturnType<typeof spawn> | null = null;
    const timer = setTimeout(() => {
      try {
        child?.kill();
      } catch {
        /* 已经退了 */
      }
      if (!settled) {
        settled = true;
        resolve({ ok: false, stdout: '' });
      }
    }, budgetMs);
    timer.unref?.();
    const done = (r: { ok: boolean; stdout: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    try {
      child = spawn('git', args, {
        cwd,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      child.stdout?.setEncoding('utf-8');
      child.stdout?.on('data', (chunk: string) => {
        out += chunk;
      });
      child.on('error', () => done({ ok: false, stdout: '' }));
      child.on('close', (code) => done({ ok: code === 0, stdout: out }));
    } catch {
      done({ ok: false, stdout: '' });
    }
  });

/**
 * 默认探针 —— 一次 `git log` 拿全部分支历史里的 trailer。
 *
 * 为什么要**一次**拿全量而不是逐片问：
 *   `git log --grep` 逐片问 = N 次进程（实测 nimrtc-v14 一次 30–200ms，
 *   25 片就是几秒）。一次 `git log` + 格式化成 `%H%x00%s%x00%(trailers…)`
 *   一次读全量，几十毫秒。
 */
const parseTrailerLog = (
  stdout: string,
  wanted: Set<string>,
  found: Map<string, { hash: string; subject: string }> = new Map(),
): Map<string, { hash: string; subject: string }> => {
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\0');
    const hash = parts[0];
    const subject = parts[1] ?? '';
    const trailer = parts.slice(2).join(' ');
    if (!hash) continue;
    // trailer 可能是 `a, b` 或 `a b` —— 两种分隔都认
    for (const id of trailer.split(/[,\s]+/).filter(Boolean)) {
      if (!wanted.has(id)) continue;
      // 取**最新**的那个提交（git log 是新→旧，第一次命中就是最新的）
      if (!found.has(id)) found.set(id, { hash: hash.slice(0, 8), subject });
    }
  }
  return found;
};

/**
 * 这些 id 的命中提交里，哪些**已经在 `branch` 的祖先版本分支上**。
 *
 * 判定方式与 `findSliceCommitsOnAncestors` 相同（本地 `version/*` 中
 * 是 `branch` 祖先的分支），但按**提交**判而不是按分支 tip 判 ——
 * 祖先分支上较新的提交（`--not` 能排除）与较旧的提交（只能这样排除）都要对上。
 * 读不到返回 null。
 */
const ancestorsContaining = async (
  dir: string,
  branch: string,
  sliceIds: string[],
  memo?: ArtifactGitMemo,
): Promise<Set<string> | null> => {
  const run = memo
    ? (args: string[], budgetMs: number) => memo.run(dir, args, budgetMs)
    : (args: string[], budgetMs: number) => execAsync(args, dir, budgetMs);
  const refs = await run(['for-each-ref', '--format=%(refname:short)', 'refs/heads/version/'], GIT_TIMEOUT_MS);
  if (!refs.ok) return null;
  const ancestors: string[] = [];
  for (const ref of refs.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
    if (ref === branch) continue;
    const a = await run(['merge-base', '--is-ancestor', ref, branch], GIT_TIMEOUT_MS);
    if (a.ok) ancestors.push(ref);
  }
  if (ancestors.length === 0) return new Set();
  const log = await run(
    ['log', ...ancestors, '--format=%H%x00%s%x00%(trailers:key=Refs-Slice,valueonly)'],
    GIT_TIMEOUT_MS * 3,
  );
  if (!log.ok) return null;
  return new Set(parseTrailerLog(log.stdout, new Set(sliceIds)).keys());
};

/**
 * 默认探针 —— 一次 `git log` 拿全部分支历史里的 trailer。
 *
 * 为什么要**一次**拿全量而不是逐片问：
 *   `git log --grep` 逐片问 = N 次进程（实测 nimrtc-v14 一次 30–200ms，
 *   25 片就是几秒）。一次 `git log` + 格式化成 `%H%x00%s%x00%(trailers…)`
 *   一次读全量，几十毫秒。
 */
export const defaultArtifactProbe: ArtifactEvidenceProbe = {
  async findSliceCommits(dir, branch, sliceIds, memo) {
    if (sliceIds.length === 0) return new Map();
    const run = memo
      ? (args: string[], budgetMs: number) => memo.run(dir, args, budgetMs)
      : (args: string[], budgetMs: number) => execAsync(args, dir, budgetMs);
    const inside = await run(['rev-parse', '--is-inside-work-tree'], GIT_TIMEOUT_MS);
    if (!inside.ok || inside.stdout.trim() !== 'true') return null;

    // 分支不存在（还没建 / 已删）→ 拿不到证据，不说「不在」
    const branchExists = await run(['rev-parse', '--verify', `${branch}^{commit}`], GIT_TIMEOUT_MS);
    if (!branchExists.ok) return null;

    const log = await run(
      ['log', branch, '--format=%H%x00%s%x00%(trailers:key=Refs-Slice,valueonly)'],
      GIT_TIMEOUT_MS * 3,
    );
    if (!log.ok) return null;

    // 先解析全量，再看每个 id 的**首个**提交是不是本版自己的（祖先带来的不算）——
    // 用 `--not <ancestors>` 会让同一 id 的「本版提交比祖先提交旧」时落到祖先去，
    // 判错归属。这里逐 id 判定：首个命中提交若已在本分支祖先上，就不算本版产物。
    const all = parseTrailerLog(log.stdout, new Set(sliceIds));
    if (all.size === 0) return new Map();
    const ancHas = await ancestorsContaining(dir, branch, [...all.keys()], memo);
    const found = new Map<string, { hash: string; subject: string }>();
    for (const [id, hit] of all) {
      if (ancHas === null) return null;
      if (!ancHas.has(id)) found.set(id, { hash: hit.hash, subject: hit.subject });
    }
    return found;
  },

  async findSliceCommitsOnAncestors(dir, branch, sliceIds, memo) {
    if (sliceIds.length === 0) return new Map();
    const run = memo
      ? (args: string[], budgetMs: number) => memo.run(dir, args, budgetMs)
      : (args: string[], budgetMs: number) => execAsync(args, dir, budgetMs);
    const inside = await run(['rev-parse', '--is-inside-work-tree'], GIT_TIMEOUT_MS);
    if (!inside.ok || inside.stdout.trim() !== 'true') return null;
    const branchExists = await run(['rev-parse', '--verify', `${branch}^{commit}`], GIT_TIMEOUT_MS);
    if (!branchExists.ok) return null;

    // 本地 version/* 分支里，是本分支祖先且不是本分支本身的那些
    const refs = await run(
      ['for-each-ref', '--format=%(refname:short)', 'refs/heads/version/'],
      GIT_TIMEOUT_MS,
    );
    if (!refs.ok) return null;
    const ancestors: string[] = [];
    for (const ref of refs.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
      if (ref === branch) continue;
      const a = await run(['merge-base', '--is-ancestor', ref, branch], GIT_TIMEOUT_MS);
      if (a.ok) ancestors.push(ref);
    }
    if (ancestors.length === 0) return new Map();

    const log = await run(
      ['log', branch, '--format=%H%x00%s%x00%(trailers:key=Refs-Slice,valueonly)'],
      GIT_TIMEOUT_MS * 3,
    );
    if (!log.ok) return null;
    // `--not <ancestors>`：只看「本分支有、祖先没有」的提交 —— 一个 trailer
    // 若只在祖先分支上，它就不是本版自己的产物，交给 ancestorOnBranch 那列。
    const hits = parseTrailerLog(log.stdout, new Set(sliceIds));
    // 同一提交可能同时挂在多个祖先分支上 —— 取分支名最短的那个（version/v1 < version/v10 的边界情况）
    const fromBranch = [...ancestors].sort((a, b) => a.length - b.length)[0];
    const found = new Map<string, { hash: string; subject: string; fromBranch: string }>();
    for (const [id, hit] of hits) found.set(id, { ...hit, fromBranch });
    return found;
  },
};

/**
 * 给一批切片行补上「产物证据」。
 *
 * @param dir 问 git 的目录（仓库根）
 * @param branch 所属版本的分支名（如 `version/v1`）
 * @param rows 要标注的行（每行带 `id`）
 */
export async function annotateArtifactEvidence<T extends { id: string }>(
  dir: string,
  branch: string,
  rows: T[],
  probe: ArtifactEvidenceProbe = defaultArtifactProbe,
): Promise<Array<T & SliceArtifactEvidence>> {
  const ids = rows.map((r) => r.id);
  const found = await probe.findSliceCommits(dir, branch, ids);
  if (found === null) {
    return rows.map((row) => ({
      ...row,
      onBranch: null,
      commit: null,
      subject: null,
      ancestorOnBranch: null,
      ancestorCommit: null,
    }));
  }
  const missing = ids.filter((id) => !found.has(id));
  let onAncestors: Map<string, { hash: string; subject: string }> | null = new Map();
  if (missing.length > 0) {
    onAncestors = (await probe.findSliceCommitsOnAncestors(dir, branch, missing)) ?? null;
  }
  return rows.map((row) => {
    const hit = found.get(row.id);
    const anc = hit ? undefined : onAncestors?.get(row.id);
    return {
      ...row,
      onBranch: hit !== undefined,
      commit: hit?.hash ?? null,
      subject: hit?.subject ?? null,
      ancestorOnBranch: onAncestors === null ? null : anc !== undefined,
      ancestorCommit: anc?.hash ?? null,
    };
  });
}

/** 同步版 —— 测试用（不做真 I/O 时用假探针）。 */
export function annotateArtifactEvidenceSync<T extends { id: string }>(
  rows: T[],
  found: Map<string, { hash: string; subject: string }> | null,
  onAncestors: Map<string, { hash: string; subject: string }> | null = new Map(),
): Array<T & SliceArtifactEvidence> {
  return rows.map((row) => {
    if (found === null) {
      return { ...row, onBranch: null, commit: null, subject: null, ancestorOnBranch: null, ancestorCommit: null };
    }
    const hit = found.get(row.id);
    const anc = hit ? undefined : onAncestors?.get(row.id);
    return {
      ...row,
      onBranch: hit !== undefined,
      commit: hit?.hash ?? null,
      subject: hit?.subject ?? null,
      ancestorOnBranch: onAncestors === null ? null : anc !== undefined,
      ancestorCommit: anc?.hash ?? null,
    };
  });
}

/** 给「命中提交」拼一句人话 —— 给界面用。 */
export function describeArtifactHit(
  hit: { commit: string | null; subject: string | null } | null,
): string {
  if (!hit || !hit.commit) return '查不到产物提交';
  return hit.subject ? `${hit.commit} ${hit.subject}` : hit.commit;
}
