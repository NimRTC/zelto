// 执行目录（worktree）脉络 —— 「这场仗到底分成几条战线、每条各在哪」
//
// 为什么需要它（实测 nimrtc-v14，2026-11-26）：
//
//   驾驶舱 ADR-112 之后能看到「仓库根 + 每个 `.zelto/version-worktrees/<label>/`」，
//   但它看不见**执行场景本身**。实际上同一个仓库里同时躺着：
//
//     D:/MyOpen/nimrtc-v14                          ← 仓库根（人在的地方）
//     D:/MyOpen/_wt_v14_code                        ← 手工开的并行工作区
//     D:/MyOpen/_wt_v14_docs                        ← 同上
//     .zelto/version-worktrees/v4                    ← 版本集成目录
//     .zelto/worktrees/v4-n2-ice-tcp                 ← 切片执行目录（zelto run 建的）
//
//   前两类在驾驶舱里**完全不是一个概念**——列表里只有「仓库根 / 版本目录 v4」，
//   人看不出「这片是在一条独立战线里跑的」。
//
// 判据是**纯文件事实**（C3：确定性、只读、不调模型、不触网）：
//
//   - 版本集成目录：`.zelto/version-worktrees/<label>/`（ADR-056）；
//   - 切片执行目录：`.zelto/worktrees/<sliceId>/`，**目录存在**就算
//     （git 的元数据在 `.git/worktrees/` 里，我们只看 zelto 自己的目录约定）；
//   - 额外工作区：git 记录的 worktree（`git worktree list --porcelain`），
//     不属于上面两类、也不在 `.zelto/` 底下的，认作「额外工作区」。
//
// 额外工作区由调用方把 git 的事实传进来
// （与 ADR-114 的探针注入同一套做法：测试不该真去跑 git）。
// 唯一的例外是版本目录的兜底探测（`probeGitEntry`）：`git worktree list` 里
// 没有的版本目录（普通检出目录）仍要能问出分支 / HEAD，否则驾驶舱对这类
// 战线一律显示「不知道」—— 而那恰恰是 ADR-056 下最常见的形态。
//
// 「已并入主干」是另一个 git 事实（`merge-base --is-ancestor`），锚点取
// 本地 main/master，再退到远端 origin|ghssh|github/main。它只回答「这条战线的
// 提交是不是已经在主干里」，不判定版本交付状态（那归 `version status`）。

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isValidVersionLabel } from '../version/branch.js';
import { VERSION_WORKTREES_REL, WORKTREES_REL } from './cockpit-roots.js';

/** 一个工作区的种类。 */
export type WorktreeKind = 'root' | 'version' | 'slice' | 'extra';

/** git 记录的一条 worktree（`git worktree list --porcelain` 的一节）。 */
export interface GitWorktreeEntry {
  /** 绝对路径（已做路径分隔符归一） */
  path: string;
  /** 检出的分支（`refs/heads/x` 已去掉前缀）；detached 时为 null */
  branch: string | null;
  /** HEAD 提交（短哈希或全哈希，原样保留） */
  head: string | null;
  detachable: boolean;
}

/** 驾驶舱里的一条「战线」。 */
export interface WorktreeEntry {
  kind: WorktreeKind;
  /** 版本 label / 切片 id；仓库根与额外工作区为 null */
  label: string | null;
  /** 绝对路径 */
  dir: string;
  /** 这个工作区在 `.zelto` 里有没有自己的状态（切片 / 事件） */
  hasZeltoState: boolean;
  /** 分支（来自 git；未提供 git 事实或 detached 时为 null） */
  branch: string | null;
  /** HEAD（来自 git；没有时为 null） */
  head: string | null;
  /** 这一条的依据 —— 「怎么发现的」要说清楚，不然人不知道该信哪一层 */
  evidence: string;
  /**
   * 编码用：版本分支/HEAD 与主干的祖先关系。只对 kind='version' 有意义；
   * 未提供 git 事实（HEAD / 主干锚点都拿不到）时为 null。
   *
   *   'merged'  —— HEAD 是主干的祖先：这条战线的活已经在主干里
   *   'diverged' —— HEAD 有主干没有的提交（版本分支常比主干跑得快）
   *   null       —— 不知道（没有 git 事实），不许说成「未合并」
   *
   * 它只回答 git 事实，不判定版本交付状态本身（那归 `version status`）。
   * 为什么要单独区分 'diverged'（实测 nimrtc-v14，2026-11-26）：
   * v3 版本的 status 是 delivered，但 version/v3 比远端 main 还快 73 个提交 ——
   * 只报「有未合并提交」会和同一行的 delivered 摆在一起，人读成矛盾。
   */
  mergedIntoTrunk?: 'merged' | 'diverged' | null;
}

/** 路径归一：统一正斜杠、去掉末尾分隔符、Windows 下大小写不敏感。 */
export function normalizeDir(dir: string): string {
  let s = dir.replace(/\\/g, '/');
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function hasZeltoState(dir: string): boolean {
  const zeltoDir = join(dir, '.zelto');
  return (
    existsSync(join(zeltoDir, 'slices')) ||
    existsSync(join(zeltoDir, 'events'))
  );
}

/**
 * 列出所有「战线」。
 *
 * 顺序固定：仓库根 → 版本集成目录（按 label 字典序）→ 切片执行目录（按 id）
 * → 额外工作区（按路径）。同一路径只出现一次（先出现的赢）。
 *
 * @param repoRoot 仓库根
 * @param gitWorktrees git 记录的 worktree（`readGitWorktrees` 的结果）；
 *   不传 = 不认额外工作区（老行为，零变化）
 * @param trunkHead 主干锚点提交（调用方注入，`merge-base` 判祖先关系的远端）；
 *   不给 = 用 `resolveTrunk(repoRoot)` 现查；查不到就是 null（「不知道」）
 */
export function discoverWorktrees(
  repoRoot: string,
  gitWorktrees: GitWorktreeEntry[] = [],
  trunkHead?: string | null,
): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  const seen = new Set<string>();
  const push = (entry: WorktreeEntry) => {
    const key = normalizeDir(entry.dir);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  };

  const gitByPath = new Map<string, GitWorktreeEntry>();
  for (const g of gitWorktrees) gitByPath.set(normalizeDir(g.path), g);
  const gitOf = (dir: string) => gitByPath.get(normalizeDir(dir)) ?? null;

  const rootGit = gitOf(repoRoot);
  push({
    kind: 'root',
    label: null,
    dir: repoRoot,
    hasZeltoState: hasZeltoState(repoRoot),
    branch: rootGit?.branch ?? null,
    head: rootGit?.head ?? null,
    evidence: '仓库根（zelto web 的 cwd）',
  });

  // ── 版本集成目录 ──
  const versionBase = join(repoRoot, VERSION_WORKTREES_REL);
  let versionNames: string[] = [];
  try {
    versionNames = readdirSync(versionBase);
  } catch {
    // 没有版本目录 —— 老项目零行为变化
  }
  // 主干锚点：本地 main/master → 远端 origin/ghssh/github 的 main/master
  // （实测 nimrtc-v14：没有本地 main，developing 分支叫 feat/v14-turn-tls，
  //  版本合进的「主干」是远端 main —— 只认本地 refs/heads/main 会一条都判不出）
  const trunk = trunkHead === undefined ? resolveTrunk(repoRoot) : trunkHead;
  for (const label of versionNames
    .filter((n) => isValidVersionLabel(n))
    .filter((n) => isDirectory(join(versionBase, n)))
    .filter((n) => hasZeltoState(join(versionBase, n)))
    .sort()) {
    const dir = join(versionBase, label);
    // git worktree 登记里没有 → 就地探测（版本目录常常是普通检出目录）
    const git = gitOf(dir) ?? probeGitEntry(dir);
    push({
      kind: 'version',
      label,
      dir,
      hasZeltoState: true,
      branch: git?.branch ?? (null),
      head: git?.head ?? null,
      evidence: `.zelto/version-worktrees/${label}/ 下有 .zelto 状态（ADR-056 版本分支 version/${label}）`,
      mergedIntoTrunk: git ? isMergedInto(repoRoot, git.head, trunk) : null,
    });
  }

  // ── 切片执行目录 ──
  const sliceBase = join(repoRoot, WORKTREES_REL);
  let sliceNames: string[] = [];
  try {
    sliceNames = readdirSync(sliceBase);
  } catch {
    // 没有执行目录
  }
  for (const sliceId of sliceNames
    .filter((n) => !n.startsWith('.'))
    .filter((n) => isDirectory(join(sliceBase, n)))
    .sort()) {
    const dir = join(sliceBase, sliceId);
    const git = gitOf(dir);
    push({
      kind: 'slice',
      label: sliceId,
      dir,
      hasZeltoState: hasZeltoState(dir),
      branch: git?.branch ?? (null),
      head: git?.head ?? null,
      evidence: `.zelto/worktrees/${sliceId}/ 存在（zelto run 的切片执行目录，分支 slice/${sliceId}）`,
    });
  }

  // ── 额外工作区：git 认识、但不属于上面任何一类 ──
  for (const g of gitWorktrees) {
    const key = normalizeDir(g.path);
    if (seen.has(key)) continue;
    // `.zelto/` 底下的（版本目录 / 切片目录 / 临时 worktree）已经在上面的类别里；
    // 只认「zelto 自己建的」那两种位置之外的。
    const repoPrefix = normalizeDir(repoRoot);
    if (key.startsWith(`${repoPrefix}/.zelto/`)) continue;
    // 仓库根自己（git 一定列它）
    if (key === repoPrefix) continue;
    push({
      kind: 'extra',
      label: null,
      dir: g.path,
      hasZeltoState: hasZeltoState(g.path),
      branch: g.branch,
      head: g.head,
      evidence: 'git worktree 记录的额外工作区（不是 zelto 建的版本目录或执行目录）',
    });
  }

  return out;
}

/**
 * 版本战线的活是不是已经在主干里了。
 *
 * 判据是 git 祖先关系：HEAD 是主干某提交的祖先 = 已合并。
 * 只做「知道 / 不知道」的降级 —— 问不出来就返回 null，
 * 不按「未合并」装一个确定的答案出来。
 */
function isMergedInto(
  repoRoot: string,
  head: string | null,
  trunk: string | null,
): 'merged' | 'diverged' | null {
  if (!head || !trunk) return null;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', head, trunk], {
      cwd: repoRoot,
      stdio: 'ignore',
      timeout: 5000,
    });
    return 'merged';
  } catch (e) {
    // 退出 1 = 不是祖先（知道了，这就是 diverged）；超时 / 对象不存在 = 不知道
    return (e as { status?: number }).status === 1 ? 'diverged' : null;
  }
}

/**
 * 版本目录的 git 事实：`git worktree list` 里没有它的条目时，就地探测。
 *
 * 为什么需要：`.zelto/version-worktrees/<label>/` 是**普通目录**，
 * 未必登记成 git worktree —— 实测 nimrtc-v14 里 v1..v3 的目录都是普通检出目录
 * （v3 的 worktree 建完合完就被 `worktree remove` 了，状态目录却留在主干检出里，
 * 正是 ADR-056「.zelto 不进 git，任何检出都可以有」的形态）。
 * 这些目录本身仍是 git 认识的工作树 —— 分支 / HEAD 照样能问出来。
 *
 * 只读、确定性（C3）：失败就当「不知道」（null），不猜。
 */
function probeGitEntry(dir: string): { branch: string | null; head: string | null } | null {
  try {
    let branch = '';
    try {
      branch = execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
        cwd: dir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      }).trim();
    } catch {
      // detached HEAD：没有分支名
    }
    const head = execFileSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    if (!head) return null;
    return { branch: branch || null, head };
  } catch {
    return null;
  }
}

/**
 * 主干锚点（提交哈希）。
 *
 * 顺序：本地 `main` / `master`，再是远端跟踪分支
 * `origin|ghssh|github/main(master)`。远端也要认的理由：
 * 实测 nimrtc-v14 没有本地 main（人在 `feat/v14-turn-tls` 上开发），
 * 版本合进的「主干」是远端 main —— 只认本地 refs 会一条都判不出。
 *
 * 都找不到 → null（「不知道主干是谁」，不猜）。
 */
function resolveTrunk(repoRoot: string): string | null {
  const candidates: string[] = [];
  for (const name of ['main', 'master']) candidates.push(`refs/heads/${name}`);
  for (const remote of ['origin', 'ghssh', 'github'])
    for (const name of ['main', 'master']) candidates.push(`refs/remotes/${remote}/${name}`);
  for (const ref of candidates) {
    try {
      const r = execFileSync('git', ['rev-parse', '--verify', '--quiet', ref], {
        cwd: repoRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      }).trim();
      if (r) return r;
    } catch {
      // 没有这个 ref，试下一个
    }
  }
  return null;
}

// ─── git worktree 事实 ───────────────────────────────────────────────────────

/**
 * 主干锚点，**异步**版：驾驶舱每一条请求都走这条路径，同步 spawn 会卡事件循环
 * （ZD-045）。失败同样是 null（「不知道」），不猜。
 */
export async function resolveTrunkAsync(repoRoot: string): Promise<string | null> {
  const candidates: string[] = [];
  for (const name of ['main', 'master']) candidates.push(`refs/heads/${name}`);
  for (const remote of ['origin', 'ghssh', 'github'])
    for (const name of ['main', 'master']) candidates.push(`refs/remotes/${remote}/${name}`);
  // 逐条问：`rev-parse --verify` 一次给多个 ref 时**任一**不存在就整体退出非零，
  // 已存在的 ref 也不输出 —— 批量问等于永远拿不到（实测 rev-parse 多参）。
  for (const ref of candidates) {
    const r = await runGit(['rev-parse', '--verify', '--quiet', ref], repoRoot, 5_000);
    const rev = r.ok ? r.stdout.trim() : '';
    if (rev) return rev;
  }
  return null;
}

/**
 * 「这条战线在 git 眼里长什么样」—— 一次 `git worktree list --porcelain`。
 *
 * 为什么住在这里：执行目录脉络要的是「分支 / HEAD / 是不是已并入主干」这些
 * **git 事实**，它们与发现逻辑是一体的。探测失败 / 不是仓库 → `[]`
 * （调用方按「没有 git 事实」处理，不许把「不知道」说成「没有」）。
 */
export async function readGitWorktrees(repoRoot: string): Promise<GitWorktreeEntry[]> {
  const r = await runGit(['worktree', 'list', '--porcelain'], repoRoot, 10_000);
  if (!r.ok) return [];
  const out: GitWorktreeEntry[] = [];
  let cur: { path?: string; head?: string; branch?: string | null; bare?: boolean; detached?: boolean } = {};
  const flush = () => {
    if (!cur.path || cur.bare) {
      cur = {};
      return;
    }
    out.push({
      path: cur.path,
      branch: cur.branch ?? null,
      head: cur.head ?? null,
      detachable: cur.detached === true,
    });
    cur = {};
  };
  for (const line of r.stdout.split('\n')) {
    const t = line.trim();
    if (t === '') {
      flush();
      continue;
    }
    const sp = t.indexOf(' ');
    const key = sp < 0 ? t : t.slice(0, sp);
    const value = sp < 0 ? '' : t.slice(sp + 1);
    if (key === 'worktree') cur.path = value;
    else if (key === 'HEAD') cur.head = value;
    else if (key === 'branch') cur.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'detached') cur.detached = true;
    else if (key === 'bare') cur.bare = true;
  }
  flush();
  return out;
}

/**
 * 异步跑一次 git（带总预算）。
 *
 * 为什么驾驶舱不许用 `execFileSync`：实测单个 git 进程 30–200ms 且会抖，
 * 串行问几十次 = 事件循环被卡住，所有 HTTP 请求排队，首屏一直转圈。
 */
function runGit(
  args: string[],
  cwd: string,
  budgetMs: number,
): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    let child: ChildProcess | null = null;
    const timer = setTimeout(() => {
      try {
        child?.kill();
      } catch {
        // 已经退了
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
      child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
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
}
