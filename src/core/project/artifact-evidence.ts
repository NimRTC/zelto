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
}

/** 探针（注入以便测试）。 */
export interface ArtifactEvidenceProbe {
  /**
   * 这个分支上，带 `Refs-Slice: <sliceId>` trailer 的提交。
   * 读不到（不是 git 仓库 / git 失败）返回 null。
   */
  findSliceCommits(dir: string, branch: string, sliceIds: string[]): Promise<Map<string, { hash: string; subject: string }> | null>;
}

const GIT_TIMEOUT_MS = 8000;

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
export const defaultArtifactProbe: ArtifactEvidenceProbe = {
  async findSliceCommits(dir, branch, sliceIds) {
    if (sliceIds.length === 0) return new Map();
    const inside = await execAsync(['rev-parse', '--is-inside-work-tree'], dir, GIT_TIMEOUT_MS);
    if (!inside.ok || inside.stdout.trim() !== 'true') return null;

    // 分支不存在（还没建 / 已删）→ 拿不到证据，不说「不在」
    const branchExists = await execAsync(['rev-parse', '--verify', `${branch}^{commit}`], dir, GIT_TIMEOUT_MS);
    if (!branchExists.ok) return null;

    const log = await execAsync(
      ['log', branch, '--format=%H%x00%s%x00%(trailers:key=Refs-Slice,valueonly)'],
      dir,
      GIT_TIMEOUT_MS * 3,
    );
    if (!log.ok) return null;

    const wanted = new Set(sliceIds);
    const found = new Map<string, { hash: string; subject: string }>();
    for (const line of log.stdout.split('\n')) {
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
  return rows.map((row) => {
    if (found === null) {
      return { ...row, onBranch: null, commit: null, subject: null };
    }
    const hit = found.get(row.id);
    return {
      ...row,
      onBranch: hit !== undefined,
      commit: hit?.hash ?? null,
      subject: hit?.subject ?? null,
    };
  });
}

/** 同步版 —— 测试用（不做真 I/O 时用假探针）。 */
export function annotateArtifactEvidenceSync<T extends { id: string }>(
  rows: T[],
  found: Map<string, { hash: string; subject: string }> | null,
): Array<T & SliceArtifactEvidence> {
  return rows.map((row) => {
    if (found === null) return { ...row, onBranch: null, commit: null, subject: null };
    const hit = found.get(row.id);
    return {
      ...row,
      onBranch: hit !== undefined,
      commit: hit?.hash ?? null,
      subject: hit?.subject ?? null,
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
