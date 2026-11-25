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

import { execFileSync } from 'node:child_process';

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
    const inside = exec(['rev-parse', '--is-inside-work-tree'], dir);
    if (!inside.ok || inside.stdout.trim() !== 'true') return null;
    // ls-files --error-unmatch 能同时回答「跟踪了吗」
    const tracked = exec(['ls-files', '--error-unmatch', '--', relPath], dir);
    if (!tracked.ok) return false;
    // 与 HEAD 一致：diff --quiet HEAD -- <path>（退出码 0 = 无差异）
    const same = exec(['diff', '--quiet', 'HEAD', '--', relPath], dir);
    return same.ok;
  },
  readAtHead(dir, relPath) {
    const r = exec(['show', `HEAD:${relPath}`], dir);
    return r.ok ? r.stdout : null;
  },
};

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
  // 按根缓存「是不是 git 仓库」与「已读过的 HEAD 内容」
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
    let committedState: string | null = null;
    if (content !== null) {
      try {
        const parsed = JSON.parse(content) as { state?: unknown };
        if (typeof parsed.state === 'string') committedState = parsed.state;
      } catch {
        // 提交里的那份坏了 —— 不知道就是不知道
      }
    }
    return { ...row, onBranch: true, committedState };
  });
}
