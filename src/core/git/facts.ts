// git 事实判定 —— CLI 与 Web 共用的一份
//
// 为什么单独收一份：
//
// 「分支存不存在」「合没合进目标」「产物在不在目标 ref 的树上」
// 「工作区脏不脏」这四类判据，以前散在
// `cli/commands/merge-executor.ts` 与 `cli/commands/merge-runner.ts` 里。
//
// Web 驾驶舱要自己算「待合并」时，只能再抄一份 —— 于是同一条判据
// 两处漂移。这正是 D-11 的老形状（合并的两条路径判据不一致，
// 症状离病因很远：一边说「已合」，另一边说「待合」）。
//
// **这里只放纯 git 事实**：只读、不调模型、不触网（C3），
// 不含任何 zelto 状态语义（状态语义在 `core/pending/`）。
//
// C2：core/ 内，不依赖 adapters/，只用 Node 内置。

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/** 一次 git 调用的结果。 */
export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * 执行 git 命令。退出码非 0 时**不抛异常**，返回 ok=false。
 *
 * `git merge-base --is-ancestor` 这类命令正是用退出码表达布尔结果，
 * 因此这里不能把非 0 当成异常。
 */
export function git(args: string[], cwd: string, timeoutMs = 60_000): GitResult {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: timeoutMs,
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

/** commit 是否存在于仓库中 */
export function commitExists(commit: string, repoRoot: string): boolean {
  return git(['rev-parse', '--verify', `${commit}^{commit}`], repoRoot).ok;
}

/**
 * 分支索引 —— **一次 git 调用**问清「有哪些分支」「哪些已合入某个 ref」。
 *
 * ── 为什么要有这个 ──────────────────────────────────────────────────────
 *
 * 「分支存不存在」「合没合进目标」这两个判据，原来是一条一个 git 调用。
 * 在真实仓库里（99 个已批准的签字请求）那是**几百次子进程启动** ——
 * 实测 `zelto next` 要跑 **60 多秒**，Web 驾驶舱的 `/api/pending-actions`
 * 直接超时，首屏永远停在「加载中…」。
 *
 * git 一次就能把全部分支列出来：
 *   - `git for-each-ref refs/heads/` → 所有分支
 *   - `git branch --merged <ref>`   → 已合入 `<ref>` 的所有分支
 *
 * 所以：**一次调用答完所有切片**，而不是每个切片问一次。
 *
 * ── 为什么仍然是确定性判定 ─────────────────────────────────────────────
 *
 * 判据没变 —— 仍然是「这个分支合没合进这个 ref」，
 * 只是**一次问完**而不是**一问一次**。同样的 git 事实，
 * 同样的结论（C3）。
 *
 * C2：core/ 内，不依赖 adapters/，只用 Node 内置。
 */
export interface BranchIndex {
  /** 所有本地分支名（不含 `refs/heads/` 前缀） */
  branches: Set<string>;
  /** 已合入 HEAD 的分支名 */
  mergedIntoHead: Set<string>;
  /** 按 ref 缓存的「已合入该 ref 的分支」 */
  mergedCache: Map<string, Set<string>>;
}

/**
 * 建一份分支索引 —— 两次 git 调用答完「有哪些分支」「哪些已合入 HEAD」。
 *
 * `git branch --merged HEAD` 与 `git merge-base --is-ancestor <branch> HEAD`
 * 是同一件事（前者是后者的批量形式）—— 所以判据没变，只是问法批量化。
 */
export function buildBranchIndex(repoRoot: string): BranchIndex {
  const branches = new Set<string>();
  const res = git(
    ['-c', 'core.quotePath=false', 'for-each-ref', '--format=%(refname:short)', 'refs/heads/'],
    repoRoot,
  );
  if (res.ok) {
    for (const line of res.stdout.split('\n')) {
      const b = line.trim();
      if (b) branches.add(b);
    }
  }
  return {
    branches,
    mergedIntoHead: listBranchesMergedInto('HEAD', repoRoot),
    mergedCache: new Map(),
  };
}

/**
 * 当前 HEAD 指的是哪个 ref —— 一次 git 调用。
 *
 * 分离头指针（detached HEAD）时返回 null。
 */
export function headRefName(repoRoot: string): string | null {
  const res = git(['symbolic-ref', '--quiet', 'HEAD'], repoRoot);
  if (!res.ok) return null;
  const r = res.stdout.trim();
  return r || null;
}

/**
 * 这个分支合没合入某个 ref（走索引，不起子进程）。
 *
 * @param index 分支索引（同一个索引内结果缓存）
 */
export function isBranchMergedIntoRef(
  index: BranchIndex,
  branch: string,
  ref: string,
  repoRoot: string,
): boolean {
  let merged = index.mergedCache.get(ref);
  if (!merged) {
    merged = new Set<string>();
    const res = git(
      ['-c', 'core.quotePath=false', 'branch', '--merged', ref, '--format=%(refname:short)'],
      repoRoot,
    );
    if (res.ok) {
      for (const line of res.stdout.split('\n')) {
        const b = line.trim();
        if (b) merged.add(b);
      }
    }
    index.mergedCache.set(ref, merged);
  }
  return merged.has(branch);
}

/**
 * 某个 ref 的**完整文件树** —— 一次 `ls-tree` 答完所有路径存在性问题。
 *
 * ── 为什么要有这个 ──────────────────────────────────────────────────────
 *
 * 「产物在不在目标 ref 的树上」原来是一条路径一次 `git ls-tree`。
 * 一片切片有 5 条写集、99 片就是几百次调用。
 *
 * `git ls-tree -r --name-only <ref>` 一次给出全部路径 ——
 * 之后全是**内存里的 Set 查询**，零子进程。
 */
export interface RefTree {
  /** ref 上的全部文件路径 */
  files: Set<string>;
  /** ref 上的全部目录路径（带尾斜杠） */
  dirs: Set<string>;
}

/** 取某个 ref 的文件树（按 ref 缓存 —— 同一轮里同一 ref 只查一次）。 */
export function refTree(
  cache: Map<string, RefTree>,
  ref: string,
  repoRoot: string,
): RefTree {
  const hit = cache.get(ref);
  if (hit) return hit;

  const files = new Set<string>();
  const dirs = new Set<string>();
  const res = git(
    ['-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', ref],
    repoRoot,
  );
  if (res.ok) {
    for (const raw of res.stdout.split('\n')) {
      const f = raw.trim();
      if (!f) continue;
      files.add(f);
      const parts = f.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/') + '/');
    }
  }
  const tree: RefTree = { files, dirs };
  cache.set(ref, tree);
  return tree;
}

/**
 * 列出全部本地分支 —— **一次 git 调用**。
 *
 * 与 `listBranchesMergedInto` 配套：这两个调用答完全部切片的分支判据，
 * 不再是「一个分支一次 git」。
 */
export function listLocalBranches(repoRoot: string): Set<string> {
  const branches = new Set<string>();
  const res = git(
    ['-c', 'core.quotePath=false', 'for-each-ref', '--format=%(refname:short)', 'refs/heads/'],
    repoRoot,
  );
  if (res.ok) {
    for (const line of res.stdout.split('\n')) {
      const b = line.trim();
      if (b) branches.add(b);
    }
  }
  return branches;
}

/**
 * 列出已合入某个 ref 的所有本地分支 —— **一次 git 调用**。
 *
 * 与 `listLocalBranches` 配套：前一个答「有哪些分支」，
 * 这个答「哪些已合入 <ref>」。两个调用答完全部切片的分支判据。
 */
export function listBranchesMergedInto(ref: string, repoRoot: string): Set<string> {
  const merged = new Set<string>();
  const res = git(
    ['-c', 'core.quotePath=false', 'branch', '--merged', ref, '--format=%(refname:short)'],
    repoRoot,
  );
  if (res.ok) {
    for (const line of res.stdout.split('\n')) {
      const b = line.trim();
      if (b) merged.add(b);
    }
  }
  return merged;
}

/** 分支是否存在 */
export function branchExists(branch: string, repoRoot: string): boolean {
  return git(['rev-parse', '--verify', `refs/heads/${branch}`], repoRoot).ok;
}

/**
 * 分支是否已经合入当前 HEAD。
 *
 * 用来判断某个切片的产物是否已经被合并过 —— 已合并的切片不该再次参与合并。
 */
export function isMergedIntoHead(branch: string, repoRoot: string): boolean {
  return git(['merge-base', '--is-ancestor', branch, 'HEAD'], repoRoot).ok;
}

/**
 * 分支是否已经合入指定 ref（ADR-056 §3.3）。
 *
 * 合进版本分支时，判据不能是「合入 HEAD」—— HEAD 是**主仓当前检出的分支**，
 * 与版本分支无关。要判的是「这个切片的产物进了 version/<label> 没有」。
 *
 * ref 可以是分支名、tag 或 commit。
 */
export function isMergedIntoRef(branch: string, ref: string, repoRoot: string): boolean {
  return git(['merge-base', '--is-ancestor', branch, ref], repoRoot).ok;
}

/** 某路径在某个 ref 的树上存不存在。 */
export function pathExistsInRef(path: string, ref: string, repoRoot: string): boolean {
  const res = git(['ls-tree', '-r', '--name-only', ref, '--', path], repoRoot);
  if (!res.ok) return false;
  return res.stdout.split('\n').some((l) => l.trim().length > 0);
}

/**
 * 某个 ref 的历史上**被删除过的路径** —— 一次 git 调用答完全部。
 *
 * ── 为什么要有这个 ──────────────────────────────────────────────────────
 *
 * 「这条写集路径在目标 ref 上不在，是不是因为它被删掉了？」
 * 原来是一条路径一次 `git log --diff-filter=D -- <path>`。
 * 一片切片 5 条写集、几十片就是上百次调用 ——
 * 实测 `zelto next` 里这一项就占了 11 秒。
 *
 * `git log --diff-filter=D --name-only --format= <ref>` 一次给出
 * 该 ref 历史上被删过的全部路径 —— 之后全是内存里的 Set 查询。
 *
 * 判据没变（仍然是「这个路径是不是被删掉了」），只是问法批量化。
 */
export function deletedPathsInRef(
  cache: Map<string, Set<string>>,
  ref: string,
  repoRoot: string,
): Set<string> {
  const hit = cache.get(ref);
  if (hit) return hit;

  const paths = new Set<string>();
  const res = git(
    [
      '-c',
      'core.quotePath=false',
      'log',
      '--diff-filter=D',
      '--name-only',
      '--format=',
      ref,
    ],
    repoRoot,
  );
  if (res.ok) {
    for (const line of res.stdout.split('\n')) {
      const p = line.trim();
      if (p) paths.add(p);
    }
  }
  cache.set(ref, paths);
  return paths;
}

/**
 * 核实切片的产物是否已经在目标 ref 上（ADR-071 §3 D1）。
 *
 * 适用场景：**切片没有 `slice/<id>` 分支**，但产物由人直接提交到了
 * 目标分支。此时合并是空操作 —— 产物已经在那儿了。
 *
 * 判据是**写集路径**：切片自己声明的产物清单。
 * 这是「无分支」情形下唯一还在的证据（没有基点、没有分支、没有 diff）。
 *
 * 逐条路径核实：
 * - 路径在目标 ref 上**存在** → 该条已就位
 * - 路径在目标 ref 上**不存在**，但它在历史上**被删过** → 视为
 *   「该路径已被删除」，也算已就位（搬迁类切片）
 * - 路径在目标 ref 上**不存在**，历史上也没删过 → 缺失（未合入）
 *
 * @returns 缺失的路径清单。空数组 = 产物已全部就位。
 */
export function verifyArtifactsInRef(
  writes: string[],
  ref: string,
  repoRoot: string,
): { missing: string[]; satisfied: string[] } {
  return verifyArtifactsWithTree(writes, ref, repoRoot, new Map());
}

/**
 * 核实产物是否在目标 ref 上 —— **走缓存的 ref 树**（批量版）。
 *
 * ── 为什么要有这个 ──────────────────────────────────────────────────────
 *
 * 逐条路径一次 `git ls-tree` 在真实仓库里是几百次子进程启动
 * （99 片 × 5 条写集），`zelto next` 实测跑 **60 多秒**。
 *
 * 这里改成：**一次 `ls-tree` 拿到整个 ref 的文件树**，
 * 之后所有路径查询都是内存里的 Set 查找。
 *
 * @param treeCache 按 ref 缓存的文件树（同一轮里同一 ref 只查一次）
 */
export function verifyArtifactsWithTree(
  writes: string[],
  ref: string,
  repoRoot: string,
  treeCache: Map<string, RefTree>,
  deletedCache: Map<string, Set<string>> = new Map(),
): { missing: string[]; satisfied: string[] } {
  const missing: string[] = [];
  const satisfied: string[] = [];

  // glob 写集无法逐个核实 —— 保守地认为它「已就位」，
  // 否则所有带 glob 写集的切片都会卡在这里（而 glob 写集的
  // 实际内容由运行时守卫逐写判定管着，见 C9）。
  const concrete = writes
    .map((raw) => raw.trim())
    .filter((p) => p && !p.includes('*') && !p.includes('?'));

  if (concrete.length === 0) {
    for (const raw of writes) {
      const p = raw.trim();
      if (p) satisfied.push(p);
    }
    return { missing, satisfied };
  }

  const tree = refTree(treeCache, ref, repoRoot);
  const deleted = deletedPathsInRef(deletedCache, ref, repoRoot);

  for (const path of concrete) {
    if (tree.files.has(path)) {
      satisfied.push(path);
      continue;
    }
    // 目录写集：看这个目录在目标 ref 上有没有内容
    if (path.endsWith('/') && tree.dirs.has(path)) {
      satisfied.push(path);
      continue;
    }

    // 目标 ref 上没有 —— 该路径是不是「已经被删掉了」？
    // 判据：它在目标 ref 的历史上被删除过（批量查一次即可）。
    if (deleted.has(path)) {
      satisfied.push(path);
      continue;
    }

    missing.push(path);
  }

  return { missing, satisfied };
}

/**
 * 工作区里有没有未提交的改动。
 *
 * agent 的产物先落在 worktree 的工作区里，签字不提交它 —— 提交发生在合并前。
 * 所以「分支是否已合入 HEAD」这个判据不足以回答「该不该合」：
 *
 *   切片冻结在基点 C，agent 改完文件但还没提交 → 分支指针仍停在 C，
 *   而 C 通常就是 HEAD。`isMergedIntoHead` 于是说「已合入」，这个切片
 *   从待合并清单里消失 —— 人跑到 `zelto merge` 才看见「没有待合并的切片」。
 *
 * 判据是 git 的真实工作区状态（确定性，C3）。
 *
 * 读不到状态就当作**没有改动** —— 宁可漏报也不误报。
 */
export function worktreeHasChangesAt(worktreePath: string | null): boolean {
  if (!worktreePath) return false;
  if (!existsSync(worktreePath)) return false;
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().length > 0;
  } catch {
    // 读不到状态就不算有改动 —— 宁可漏报也不误报
    return false;
  }
}
