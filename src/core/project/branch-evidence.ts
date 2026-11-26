// ADR-114：分支可见性 —— 「这片做完了」是不是**在版本分支里**做完了
//
// 病灶（实测 nimrtc-v14，2026-11-25）：
//
//   `.zelto/version-worktrees/v3/.zelto/slices/` 里 15 片全是 completed，
//   而 `version/v3` 分支上 `git ls-tree .zelto/slices/` 只有 **3 片**基线。
//   `.zelto/` 整体在 .gitignore 里 —— 「切片状态」这件事默认只在**那台机器**
//   上存在；另外 12 片的「完成」没有任何进版本分支的证据，
//   换一台机器、换一个 worktree 就查不到。
//
//   驾驶舱原来只看盘上的 `state`，于是「15 片全完成」这句话
//   **说的是磁盘，不是分支**。ADR-112 解决了「看不见版本目录」，
//   这一层解决「看见了，但不知道它有没有进分支」。
//
// 判据（C3：确定性、只读、不触网）：
//
//   1. 所在根 `dir/.zelto/slices/<id>.json` 被 git 跟踪、且与 HEAD 内容一致
//      → `onBranch = true`，`committedState` = 提交里那份的 state
//   2. 没被跟踪（.gitignore / 从未 add）或与 HEAD 不一致（脏）
//      → `onBranch = false`，`committedState = null`
//   3. `dir` 不是 git 仓库（拿不到证据）
//      → `onBranch = null` —— 「不知道」不许说成「不在」（ADR-081 的口径）
//
// 不读版本计划：计划里的状态归 CLI（`zelto version status`）。
// 这里只说「盘 vs 分支」，两种事实各自独立、分开呈现。

import { execFileSync, spawn } from 'node:child_process';

/** git 事实来源（注入以便测试 —— 测试不该真去跑 git）。 */
export interface GitProbe {
  /** 这个目录里这个路径是否**被跟踪且与 HEAD 一致**；不是 git 仓库返回 null */
  trackedAtHead(dir: string, relPath: string): boolean | null;
  /** 这个路径在 HEAD 里的内容；没有返回 null */
  readAtHead(dir: string, relPath: string): string | null;
}

const exec = (args: string[], cwd: string): { ok: boolean; stdout: string } => {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      windowsHide: true,
    });
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: '' };
  }
};

/** 默认实现：直接问 git。结果在 `annotateBranchEvidence` 里按根缓存。 */
export const defaultGitProbe: GitProbe = {
  trackedAtHead(dir, relPath) {
    const inside = exec(REV_PARSE_ARGS, dir);
    if (!inside.ok || inside.stdout.trim() !== 'true') return null;
    // ls-files --error-unmatch 能同时回答「跟踪了吗」
    const tracked = exec(lsFilesArgs(relPath), dir);
    if (!tracked.ok) return false;
    // 与 HEAD 一致：diff --quiet HEAD -- <path>（退出码 0 = 无差异）
    const same = exec(diffArgs(relPath), dir);
    return same.ok;
  },
  readAtHead(dir, relPath) {
    const r = exec(['show', `HEAD:${relPath}`], dir);
    return r.ok ? r.stdout : null;
  },
};

/** 异步探针 —— 驾驶舱用。判据与 `GitProbe` 完全一致，只是不阻塞事件循环。 */
export interface AsyncGitProbe {
  /**
   * 这些路径里**哪些被跟踪且与 HEAD 一致**。
   *
   * 返回 `null` = 这个目录不是 git 仓库（拿不到证据）。
   * 被跟踪的路径进 `same`；未被跟踪的进 `notTracked`。
   */
  trackedAtHeadMany(
    dir: string,
    relPaths: string[],
  ): Promise<{ same: Set<string>; notTracked: Set<string> } | null>;
  /** 这些路径在 HEAD 里各自的内容；没有或读不出的记 null */
  readAtHeadMany(dir: string, relPaths: string[]): Promise<Map<string, string | null>>;
}

/**
 * 异步 spawn 一次 git。
 *
 * `budgetMs` 是**总预算**：从 spawn 到 kill，超了就算「没拿到」。
 * 不给的话，一个等锁的 git 能让整条请求无限期挂着。
 */
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
        // 已经退了 —— 没什么可做的
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

const GIT_TIMEOUT_MS = 5000;

/** 同步版所用同一组 git 参数（两版必须逐字一致，否则判据会悄悄分叉）。 */
const REV_PARSE_ARGS = ['rev-parse', '--is-inside-work-tree'];
const lsFilesArgs = (p: string) => ['ls-files', '--error-unmatch', '--', p];
const diffArgs = (p: string) => ['diff', '--quiet', 'HEAD', '--', p];

/**
 * 默认异步实现：直接问 git（异步 spawn）。
 *
 * 为什么用 `spawn` 而不是 `execFileSync`：见 `annotateBranchEvidenceAsync`。
 *
 * 为什么每个根只起**两个**进程（而不是每行三个）：
 * 实测（nimrtc-v14，2026-11-26）单个 git 进程在这台机器上 30–200ms 且会抖，
 * 40 多行切片串行问 = 首屏等十几秒。
 *
 *   - 跟踪状态：`ls-files -z -- <paths>` 回答「哪些被跟踪」，
 *     `diff --name-only -z HEAD -- <paths>` 回答「哪些与 HEAD 不一致」；
 *     被跟踪且不在后者里 = `onBranch` 的判据，**与逐条判据逐字相同**。
 *   - HEAD 内容：`cat-file --batch` 一次读 N 个。
 */
export const defaultAsyncGitProbe: AsyncGitProbe = {
  async trackedAtHeadMany(dir, relPaths) {
    if (relPaths.length === 0) return { same: new Set(), notTracked: new Set() };
    const inside = await execAsync(REV_PARSE_ARGS, dir, GIT_TIMEOUT_MS);
    if (!inside.ok || inside.stdout.trim() !== 'true') return null;

    const trackedRes = await execAsync(['ls-files', '-z', '--', ...relPaths], dir, GIT_TIMEOUT_MS);
    if (!trackedRes.ok) return null; // ls-files 失败 = 没拿到证据，不说「没跟踪」
    const tracked = new Set(trackedRes.stdout.split('\0').filter((s) => s.length > 0));

    const dirtyRes = await execAsync(
      ['diff', '--name-only', '-z', 'HEAD', '--', ...relPaths],
      dir,
      GIT_TIMEOUT_MS,
    );
    // diff 的退出码恒为 0（`--quiet` 才用退出码）；失败只能是 git 层出问题
    if (!dirtyRes.ok) return null;
    const dirty = new Set(dirtyRes.stdout.split('\0').filter((s) => s.length > 0));

    const same = new Set<string>();
    const notTracked = new Set<string>();
    for (const p of relPaths) {
      if (!tracked.has(p)) notTracked.add(p);
      else if (!dirty.has(p)) same.add(p);
      else notTracked.add(p); // 被跟踪但与 HEAD 不一致 —— 与逐条版同为 false
    }
    return { same, notTracked };
  },
  async readAtHeadMany(dir, relPaths) {
    const out = new Map<string, string | null>(relPaths.map((p) => [p, null]));
    if (relPaths.length === 0) return out;
    const input = relPaths.map((p) => `HEAD:${p}`).join('\n') + '\n';
    const r = await catFileBatch(dir, input);
    if (!r.ok) return out;
    let offset = 0;
    const buf = r.stdout;
    for (const p of relPaths) {
      // 每段：`<oid> blob <size>\n<content>\n`，或 `<spec> missing\n`
      const nl = buf.indexOf('\n', offset);
      if (nl < 0) break;
      const header = buf.slice(offset, nl);
      offset = nl + 1;
      if (header.endsWith(' missing') || header.endsWith(' ambiguous')) continue;
      const m = / blob (\d+)$/.exec(header);
      if (!m) continue;
      const size = Number(m[1]);
      out.set(p, buf.slice(offset, offset + size));
      offset += size + 1; // 内容后的那个换行
    }
    return out;
  },
};

const catFileBatch = (
  cwd: string,
  input: string,
): Promise<{ ok: boolean; stdout: string }> =>
  new Promise((resolve) => {
    let out = '';
    let settled = false;
    let child: ReturnType<typeof spawn> | null = null;
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
    }, GIT_TIMEOUT_MS * 3);
    timer.unref?.();
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, stdout: out });
    };
    try {
      child = spawn('git', ['cat-file', '--batch'], {
        cwd,
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
      child.stdout?.setEncoding('utf-8');
      child.stdout?.on('data', (chunk: string) => {
        out += chunk;
      });
      child.stdin?.on('error', () => done(false));
      child.stdin?.end(input);
      child.on('error', () => done(false));
      child.on('close', (code) => done(code === 0));
    } catch {
      done(false);
    }
  });

/** 一行需要的证据（与 `SliceSummary` 的字段同形 —— 避免此处 import 导入环）。 */
interface BranchEvidenceRow {
  id: string;
  scope: 'root' | 'version';
  label: string | null;
  state: string;
  onBranch: boolean | null;
  committedState: string | null;
}

/** 根 → dir（与 `CockpitRoot` 同形的最小信息）。 */
interface RootLike {
  root: { scope: 'root' | 'version'; label: string | null; dir: string };
}

/**
 * 给一批切片行补上「分支可见性」证据。
 *
 * 判据取**这一行事实所在的根**（`scope + label`）—— 那是盘上那份的所在地，
 * 分支证据必须问同一个地方（ADR-112 决策三的精神：读可以合并，写不能含糊；
 * 这里连读证据也不能跨根拿）。
 *
 * 同一根内多个路径共用一次 `rev-parse` 结果（git 调用按根缓存）。
 *
 * **不改入参** —— 返回新数组（元素是新对象）。
 */
export function annotateBranchEvidence<T extends BranchEvidenceRow>(
  roots: RootLike[],
  rows: T[],
  probe: GitProbe = defaultGitProbe,
): T[] {
  // 同步探针是**测试用的假表**（不做真 I/O）。生产路径走
  // `annotateBranchEvidenceAsync` —— 理由见那个函数的注释：
  // 同步 spawn 会把事件循环卡住，驾驶舱的所有请求都被它拖死。
  const notRepo = new Set<string>();
  const headCache = new Map<string, string | null>();

  return rows.map((row) => {
    const ws = roots.find((r) => r.root.scope === row.scope && r.root.label === row.label);
    if (!ws) return { ...row, onBranch: null, committedState: null };
    const dir = ws.root.dir;
    const relPath = `.zelto/slices/${row.id}.json`;

    if (notRepo.has(dir)) return { ...row, onBranch: null, committedState: null };
    const same = probe.trackedAtHead(dir, relPath);
    if (same === null) {
      notRepo.add(dir);
      return { ...row, onBranch: null, committedState: null };
    }
    if (!same) return { ...row, onBranch: false, committedState: null };

    const key = `${dir}\n${relPath}`;
    let content: string | null;
    if (headCache.has(key)) {
      content = headCache.get(key) ?? null;
    } else {
      content = probe.readAtHead(dir, relPath);
      headCache.set(key, content);
    }
    return { ...row, onBranch: true, committedState: stateOf(content) };
  });
}

/**
 * 异步版 —— 驾驶舱用它，理由只有一个：**慢的是编译器，而驾驶舱不能攥着它**。
 *
 * 实测（nimrtc-v14，2026-11-26）：`execFileSync('git', …)` 在事件循环里
 * 一次能卡住数秒。列表里几十行 × 每行 3 次 git 调用，合计阻塞 **93 秒**，
 * 期间所有 HTTP 请求（包括 `/api/health`）全部排队，浏览器里的页面
 * 就一直停在「加载中…」。而同一时刻用异步 `spawn` 跑同样的 15 次调用，
 * 串行 954ms、并发 138ms —— **慢的不是 git，是我们拿主线程去等它**。
 *
 * 判据本身与同步版**逐字相同**（C3：只读文件、纯计算）。形状上的差别：
 *
 *   1. 不同根**并行**（根数 = 1 + 版本数，个位数）；
 *   2. 同根内「是不是被跟踪」串行问（每行 2 次：ls-files + diff），
 *      因为并发 git 在 Windows 上会抢 index.lock —— 那会把「读」
 *      变成偶发的失败；
 *   3. 「HEAD 里那份内容」**一次进程批量读**（`cat-file --batch`）——
 *      每个都在盘上时，逐条 `git show` 是 40ms × N。
 *
 * 结果顺序与入参一一对应；探针抛错 → 该行 `onBranch = null`（不知道）。
 */
export async function annotateBranchEvidenceAsync<T extends BranchEvidenceRow>(
  roots: RootLike[],
  rows: T[],
  probe: AsyncGitProbe = defaultAsyncGitProbe,
): Promise<T[]> {
  const rootKeyOf = (row: BranchEvidenceRow) =>
    roots.find((r) => r.root.scope === row.scope && r.root.label === row.label);

  // 按根分组（保持入参顺序：最后按 index 回填）
  const groups = new Map<string, { ws: RootLike; indexes: number[]; paths: string[] }>();
  rows.forEach((row, i) => {
    const ws = rootKeyOf(row);
    if (!ws) return;
    const dir = ws.root.dir;
    let g = groups.get(dir);
    if (!g) {
      g = { ws, indexes: [], paths: [] };
      groups.set(dir, g);
    }
    g.indexes.push(i);
    g.paths.push(`.zelto/slices/${row.id}.json`);
  });

  const perRow = new Map<number, { onBranch: boolean | null; committedState: string | null }>();

  await Promise.all(
    [...groups.values()].map(async ({ ws, indexes, paths }) => {
      const dir = ws.root.dir;
      let batch: { same: Set<string>; notTracked: Set<string> } | null;
      try {
        batch = await probe.trackedAtHeadMany(dir, paths);
      } catch {
        batch = null;
      }
      if (batch === null) {
        for (const i of indexes) perRow.set(i, { onBranch: null, committedState: null });
        return;
      }
      // 盘上没被跟踪的不用读 HEAD 内容
      const needHead: string[] = [];
      indexes.forEach((i, k) => {
        const p = paths[k];
        if (!batch.same.has(p)) perRow.set(i, { onBranch: false, committedState: null });
        else needHead.push(p);
      });
      let heads = new Map<string, string | null>();
      if (needHead.length > 0) {
        try {
          heads = await probe.readAtHeadMany(dir, needHead);
        } catch {
          heads = new Map();
        }
      }
      indexes.forEach((i, k) => {
        const p = paths[k];
        if (!batch.same.has(p)) return;
        perRow.set(i, { onBranch: true, committedState: stateOf(heads.get(p) ?? null) });
      });
    }),
  );

  return rows.map((row, i) => {
    const ev = perRow.get(i);
    if (!ev) return { ...row, onBranch: null, committedState: null };
    return { ...row, onBranch: ev.onBranch, committedState: ev.committedState };
  });
}

function stateOf(content: string | null): string | null {
  if (content === null) return null;
  try {
    const parsed = JSON.parse(content) as { state?: unknown };
    return typeof parsed.state === 'string' ? parsed.state : null;
  } catch {
    // 提交里的那份坏了 —— 不知道就是不知道
    return null;
  }
}
