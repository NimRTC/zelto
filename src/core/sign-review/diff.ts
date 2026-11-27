// 签字复查的 diff 事实 —— CLI 与 Web 驾驶舱共用
//
// 为什么搬进 core（并从 `cli/commands/diff.ts` 抽出来）：
//
// 「这片改了什么」这件事，zelto 以前有**两份**互不知情的实现：
//
// | 位置 | 基准 | 粒度 |
// |---|---|---|
// | `cli/commands/diff.ts` | `baseCommit ?? HEAD`（无 worktree 时 `base..HEAD`） | 文件级 + 全文 |
// | `core/sign-review/collect.ts` | `HEAD` | **只有三个数字** |
//
// 后果有两处，都很实际：
//
//  1. **基准不一致** —— 签字复查说「改了 3 个文件」，`zelto diff` 列出 7 个。
//      人签字时看到的数字与点进去看到的清单对不上，
//      「签字前确认」就变成了走形式（ADR-072 §5.2 的四项确认之一）。
//  2. **签字时看不到文件** —— 只有 `filesChanged` / `addedLines` / `deletedLines`
//      三个数。人要判断「这个改动该不该签」时，最需要的是**哪些文件**，
//      然后才是「改了多少」。
//
// 现在：基准由**一处**解析（`resolveDiffBase`），事实由**一处**收集
// （`collectDiffFacts`），CLI 的 `zelto diff` 与签字复查都调它 ——
// 同一个结论，两处呈现。
//
// C3：只读文件与 git，不调模型、不触网。

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { commitExists as gitFactsCommitExists } from '../git/facts.js';

/** 一个文件的改动状态。 */
export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'unknown';

/** 一个文件的改动事实。 */
export interface DiffFile {
  /** 仓库相对路径 */
  path: string;
  /** 改动类型 */
  status: DiffFileStatus;
  /** 新增行数；二进制文件为 null（git 给的是 `-`） */
  added: number | null;
  /** 删除行数；二进制文件为 null */
  deleted: number | null;
}

/** 一片切片的改动事实。 */
export interface DiffFacts {
  /**
   * diff 的基准 ref（commit hash 或 ref 名）。
   *
   * `null` = 查不到基准（切片的 baseCommit 为空且找不到冻结点）——
   * 这时按 `HEAD` 算，**并在这里说明**（不静默）。
   */
  baseRef: string | null;
  /** 基准是怎么定出来的（人话）—— 签字时要能说清「相对什么算的」 */
  baseNote: string;
  /** 变更文件数 */
  filesChanged: number;
  /** 新增行数 */
  addedLines: number;
  /** 删除行数 */
  deletedLines: number;
  /** 逐个文件的事实 */
  files: DiffFile[];
}

/** diff 收集所需的上下文。 */
export interface DiffSource {
  /** 切片 id（用于找冻结点） */
  sliceId: string;
  /** 切片冻结时的基点 commit；没有则 null */
  baseCommit: string | null;
  /** 切片 worktree 的绝对路径；没有则 null（退回仓库根） */
  worktreePath: string | null;
  /** 仓库根（跑 git 用） */
  repoRoot: string;
}

/**
 * 解析 diff 的基准 ref —— **一处**说了算。
 *
 * 优先级：
 *  1. 切片文件里的 `baseCommit` —— 冻结时记下的基点，最准；
 *  2. 规格文件被**首次提交**的那个 commit —— 冻结点没记下来时的兜底；
 *  3. `HEAD` —— 实在找不到就按 HEAD 算，并**说清**（baseNote）。
 *
 * 为什么第 2 条要「首次提交」而不是「最近提交」：
 * 规格文件后来可能被改过 —— 最近的那个 commit 已经不是冻结点了，
 * 拿它当基准会把冻结后的改动算丢。
 *
 * @param cwd 跑 git 的目录（worktree 或仓库根）
 */
export function resolveDiffBase(sliceId: string, sliceBaseCommit: string | null, cwd: string): {
  baseRef: string | null;
  baseNote: string;
} {
  if (sliceBaseCommit) {
    // 记下来的基点**必须真的存在** —— 切片可能是在别的克隆/别的 worktree
    // 里冻结的，那个 commit 在当前仓库里可能压根没有。
    //
    // 基准指向一个不存在的 ref 时，`git diff <ref>` 会直接失败 ——
    // 而 diff 读不到就**按 0 算**，于是签字时看到的是「没改动」。
    // 那是最坏的结果：**沉默的假阴性**。
    if (commitExists(sliceBaseCommit, cwd)) {
      return {
        baseRef: sliceBaseCommit,
        baseNote: `切片冻结时的基点 ${shortRef(sliceBaseCommit)}`,
      };
    }
    // 记的基点查不到 → 继续往下兜底，但**说清楚发生了什么**。
    return resolveFallbackBase(sliceId, cwd, `切片记的基点 ${shortRef(sliceBaseCommit)} 在当前仓库里不存在`);
  }

  return resolveFallbackBase(sliceId, cwd, null);
}

/**
 * 兜底解析基准 —— 切片没记基点，或记的基点在这个仓库里不存在。
 *
 * 依次尝试：
 *  1. 规格文件**首次**被提交的 commit（= 冻结点）；
 *  2. `HEAD`（降级，并明说）。
 */
function resolveFallbackBase(sliceId: string, cwd: string, why: string | null): {
  baseRef: string | null;
  baseNote: string;
} {
  // 兜底一：规格文件首次被提交的 commit（= 冻结点）
  try {
    const out = execFileSync(
      'git',
      ['log', '--all', '--oneline', '--diff-filter=A', '--', `specs/slices/${sliceId}.md`],
      {
        cwd,
        encoding: 'utf-8',
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    const first = out.trim().split('\n')[0]?.trim();
    if (first) {
      const hash = first.split(' ')[0];
      if (hash && commitExists(hash, cwd)) {
        return {
          baseRef: hash,
          baseNote: why
            ? `规格首次提交 ${shortRef(hash)}（${why}，改用冻结点）`
            : `规格首次提交 ${shortRef(hash)}（切片没记 baseCommit，用冻结点）`,
        };
      }
    }
  } catch {
    // 不是 git 仓库 / 没提交过 —— 走下面的兜底
  }

  // 兜底二：HEAD（并说清这是降级）
  const prefix = why ? `${why}，` : '';
  return {
    baseRef: null,
    baseNote: `基准取 HEAD —— ${prefix}切片没记 baseCommit，也没找到冻结点（相对 HEAD 算）`,
  };
}

/**
 * 这个 commit 在当前仓库里存在吗？
 *
 * **为什么必须查**：基准指向不存在的 ref 时 `git diff <ref>` 直接失败，
 * 而 diff 读不到就按 0 算 —— 签字时看到「没改动」。
 * 那是**沉默的假阴性**，比「查不到」危险得多。
 *
 * 复用 `core/git/facts.ts` 的同一份实现 —— git 事实判定只该有一处
 * （D-11 教训：两处各判一套必然漂移）。
 */
function commitExists(commit: string, cwd: string): boolean {
  return gitFactsCommitExists(commit, cwd);
}

/**
 * 收集一片切片的 diff 事实。
 *
 * **基准与 `zelto diff` 同一份**（`resolveDiffBase`）——
 * 签字时看到的数字与 `zelto diff` 列出的清单必须对得上。
 *
 * 只读文件与 git，不改任何状态（C1/C3/C4）。
 */
export function collectDiffFacts(source: DiffSource): DiffFacts {
  const cwd = source.worktreePath ?? source.repoRoot;
  const { baseRef, baseNote } = resolveDiffBase(source.sliceId, source.baseCommit, cwd);

  // diff 目标：
  //   - 有基准 → `<baseRef>`（比较**工作区**与基准 —— 已提交与未提交都算进去）
  //   - 无基准 → `HEAD`
  //
  // 为什么用「工作区 vs 基准」而不是「基准..HEAD」：
  // agent 的产物在 worktree 里**常常还没提交**（提交发生在合并前，
  // 见 `merge-runner.ts:commitPendingWorktrees`）。
  // 只比 `base..HEAD` 会把未提交的产物整段漏掉 —— 签字看到的会是「没改动」。
  const target = baseRef ?? 'HEAD';

  const files: DiffFile[] = [];
  let addedLines = 0;
  let deletedLines = 0;

  // ── 未跟踪文件：agent 新建但还没 git add 的 ──
  //
  // `git diff` **不报**未跟踪文件 —— 只看 diff 会漏掉 agent 新建的整个文件。
  // 而「新建了一个文件」恰恰是最该被签字人看见的改动。
  const untracked = collectUntracked(cwd);
  files.push(...untracked);

  // ── 已跟踪文件的改动 ──
  const tracked = collectTracked(cwd, target);
  files.push(...tracked.files);

  // 行数只从**文件列表**汇总一次 —— 不要既加 tracked.added 又逐文件加，
  // 那会把已跟踪文件的行数算两遍。
  for (const f of files) {
    addedLines += f.added ?? 0;
    deletedLines += f.deleted ?? 0;
  }

  return {
    baseRef,
    baseNote,
    filesChanged: files.length,
    addedLines,
    deletedLines,
    files: sortFiles(files),
  };
}

/** 跑 `git diff <target> --numstat` 拿已跟踪文件的增删。 */
function collectTracked(
  cwd: string,
  target: string,
): { files: DiffFile[]; added: number; deleted: number } {
  const files: DiffFile[] = [];
  let added = 0;
  let deleted = 0;

  // `--name-status` 与 `--numstat` 分两次跑：前者给状态，后者给行数。
  // 合成一次拿不全 —— `--numstat` 的第一列是行数，不是状态字母。
  const statusByPath = new Map<string, DiffFileStatus>();
  try {
    const out = execFileSync(
      'git',
      ['-c', 'core.quotePath=false', 'diff', target, '--name-status'],
      {
        cwd,
        encoding: 'utf-8',
        timeout: 20_000,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    for (const line of out.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const parts = t.split('\t');
      if (parts.length < 2) continue;
      const code = parts[0];
      // 重命名/复制：`R100\told\tnew` —— 取新路径
      const path = parts.length >= 3 ? parts[2] : parts[1];
      statusByPath.set(path, statusFromCode(code));
    }
  } catch {
    // git 读不到 → 下面 numstat 也读不到，返回空
  }

  try {
    const out = execFileSync(
      'git',
      ['-c', 'core.quotePath=false', 'diff', target, '--numstat'],
      {
        cwd,
        encoding: 'utf-8',
        timeout: 20_000,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    for (const line of out.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const cols = t.split('\t');
      if (cols.length < 3) continue;
      const add = cols[0] === '-' ? null : Number.parseInt(cols[0], 10) || 0;
      const del = cols[1] === '-' ? null : Number.parseInt(cols[1], 10) || 0;
      const path = cols.slice(2).join('\t');
      files.push({
        path,
        status: statusByPath.get(path) ?? 'modified',
        added: add,
        deleted: del,
      });
      added += add ?? 0;
      deleted += del ?? 0;
    }
  } catch {
    // 读不到 → 空（查不到就说查不到）
  }

  return { files, added, deleted };
}

/** 未跟踪文件（agent 新建但还没 `git add` 的）。 */
function collectUntracked(cwd: string): DiffFile[] {
  const out: DiffFile[] = [];
  let paths: string[];
  try {
    const raw = execFileSync(
      'git',
      ['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard'],
      {
        cwd,
        encoding: 'utf-8',
        timeout: 20_000,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    paths = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    // 读不到 → 空
    return out;
  }

  for (const p of paths) {
    // 未跟踪文件的行数：**数出来**，不要留空。
    //
    // 「新增了 3 个文件 +0 -0」是自相矛盾的展示 ——
    // 人看到 +0 会以为「没改几行」，而实际上那是三个新文件。
    // 数字回答不了「改了什么」，但至少不能**说假话**（ADR-059）。
    const lines = countLines(cwd, p);
    out.push({ path: p, status: 'untracked', added: lines, deleted: 0 });
  }
  return out;
}

/**
 * 数一个文件的行数 —— 未跟踪文件的「新增行数」。
 *
 * 读不到（二进制、已被删、权限问题）→ null（「查不到就是查不到」，
 * 不编一个 0 冒充「没有新增」）。
 */
function countLines(cwd: string, relPath: string): number | null {
  try {
    const buf = readFileSync(resolve(cwd, relPath));
    // 二进制文件（有 NUL 字节）不算行 —— git 对二进制也不给行数
    if (buf.includes(0)) return null;
    if (buf.length === 0) return 0;
    const text = buf.toString('utf-8');
    // 末行没有换行符时，行数 = 换行符数 + 1
    const newlines = (text.match(/\n/g) ?? []).length;
    return text.endsWith('\n') ? newlines : newlines + 1;
  } catch {
    return null;
  }
}

/** git 的状态字母 → 我们的词汇。 */
function statusFromCode(code: string): DiffFileStatus {
  const c = code.trim().charAt(0).toUpperCase();
  switch (c) {
    case 'A':
      return 'added';
    case 'M':
    case 'T':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'U':
    case 'X':
    case 'B':
      return 'unknown';
    default:
      return 'unknown';
  }
}

/**
 * 文件排序 —— **先看该看的**。
 *
 * 排序键：状态重要度 → 增删行数 → 路径字典序。
 *
 * 为什么要排：签字人一眼要抓住的是「删了什么」「新增了什么」，
 * 而不是按路径字母序排列的一堆 src/ 开头的文件。
 *
 * 确定性：同键按路径字典序 —— 同样的事实两次渲染完全一样（C3）。
 */
export function sortFiles(files: DiffFile[]): DiffFile[] {
  const weight: Record<DiffFileStatus, number> = {
    deleted: 0,
    untracked: 1,
    added: 2,
    renamed: 3,
    copied: 4,
    modified: 5,
    unknown: 6,
  };
  return [...files].sort((a, b) => {
    const wa = weight[a.status] ?? 9;
    const wb = weight[b.status] ?? 9;
    if (wa !== wb) return wa - wb;
    const la = (a.added ?? 0) + (a.deleted ?? 0);
    const lb = (b.added ?? 0) + (b.deleted ?? 0);
    if (la !== lb) return lb - la;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
}

/** 短 hash（给人看的）。 */
function shortRef(ref: string): string {
  return ref.length > 8 ? ref.slice(0, 8) : ref;
}
