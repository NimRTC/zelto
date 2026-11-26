// 未跟踪文件挡住了合并 —— 处理「zelto 托管的规格文件」这一类
//
// C3: 纯 git 判定，不调模型、不触网
// C6: core/ 内，不依赖 adapters/
//
// ── 病灶（实测 nimrtc-zelto，2026-11-18）───────────────────────────────
//
// 主仓工作区里有几个**未跟踪**的规格文件：
//
//     ?? specs/slices/v3-chrome-waterfall.md
//     ?? specs/slices/v3-weaknet-verdict.md
//
// 合并守卫（merge-executor / version-ship）把它们算成「zelto 管理的规格文件」，
// **豁免**了 —— 报一句「不影响合并」就放过去了。
//
// 但 git 自己不认这个豁免：
//
//     error: The following untracked working tree files would be overwritten by merge:
//             specs/slices/v3-chrome-waterfall.md
//             specs/slices/v3-weaknet-verdict.md
//
// 合并直接失败。而失败信息是 git 的原话，**不说是哪个守卫放行了它**
// —— 人看到的是「ship 失败」，看不到「其实是 zelto 自己的豁免跟 git 的硬拦冲突」。
//
// ── 为什么这不是「让人先提交就好了」──────────────────────────────
//
// 规格文件是 zelto 的产物：人没改它，是 zelto 自己写的。
// 要求人手动提交这些文件才能 ship，等于把 zelto 自己的内部状态
// 甩给人 —— 而且下次 zelto 再写一份新规格，同样的坑再来一次。
//
// ── 判据 ────────────────────────────────────────────────────────────
//
// 只处理**同时满足**三条的路径：
//
//   1. 未跟踪（git status 报 `??`）；
//   2. zelto 托管的规格路径（`specs/slices/**`）——人的代码一律不碰；
//   3. 待合 ref 上**确实有**这个文件（git 说会被覆盖，说明目标 ref 有它）。
//
// 满足就**删掉工作区里那份未跟踪的副本**，让合并把 ref 上的版本落下来。
//
// 为什么删掉是安全的：那份副本是 zelto 自己写的产物，ref 上有它的
// 正式版本；合并落下来的就是同一份东西（本来就是同源）。
// 而且删之前会先比对内容 —— 内容不同就**先备份再删**，内容绝不丢。
//
// ── ZD-056：内容不同时「保留 + 请人确认」是**必然失败**的组合 ───────────
//
// 实测 nimrtc-v14 `v1-rtcp-processor-collaborator`（2026-11-26）：
// 切片分支上提交的规格**多出**「实施发现」一节（agent 在被丢弃的那一轮里补的，
// 规格第 12 条要求的就是这一节）；工作区副本是**更早的冻结版**（`zelto run`
// 开跑时把版本工作目录里的规格同步成冻结版，这是对的）。
// 原来的「内容不同 → 不删，请人确认」让 git merge 被未跟踪文件**必然**挡住。
//
// 判据：工作区里的那份副本**一定比分支版旧**（同步只发生在开跑时，而分支版
// 是那一轮里 agent 的产物）。所以内容不一致时：
//
//   - 工作区副本**先备份**到 `.zelto/backups/specs/<时间戳>/<原路径>`
//     （`.zelto/` 不进 git，不会污染工作区，也不进合并）；
//   - 再删掉工作区副本 —— 合并落下来的是分支上那份（本切片的正式产物）。
//
// 内容一模一样（只差行尾）时不备份，直接删。
//
// ── 保守方向 ─────────────────────────────────────────────────────────
//
// 判不出来（git 调用失败 / 备份失败）→ 一律不删、报出来。
// 删掉一份**没备份**的规格文件，比 ship 失败一次贵得多。

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isZeltoManagedSpecPath } from './managed-paths.js';

/** 一次处理的结论 */
export interface UntrackedSpecCleanupResult {
  /** 删掉的路径（相对仓库根，正斜杠） */
  removed: string[];
  /** 删不掉 / 判定不了的路径 —— 人要看 */
  conflicts: string[];
  /** 内容不一致、先备份再删的路径（ZD-056） */
  backups: Array<{ path: string; backup: string }>;
  /** 说明（给日志用） */
  notes: string[];
}

/** 跑一条 git 命令；失败返回 null（调用方按「判不出来」处理）。 */
function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
      cwd,
      encoding: 'utf-8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

/**
 * 归一化内容用于比对。
 *
 * 只归一化**行尾**（CRLF → LF）与末尾空白 —— 这两样是同一份文本在
 * Windows / Linux 上的两种写法，不是有意义的差异。
 *
 * 别的差异一律保留：内容真的不一样就是不一样。
 */
function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trimEnd();
}

/**
 * 待合 ref 上某个路径的内容（blob）。
 *
 * 读不出来返回 null —— 调用方按「判不出来」处理。
 */
function contentAtRef(repoRoot: string, ref: string, path: string): string | null {
  const out = git(['show', `${ref}:${path}`], repoRoot);
  return out === null ? null : out;
}

/**
 * 把「未跟踪的 zelto 规格文件副本」清掉，让合并能落下来。
 *
 * 判据见文件头注释。**不碰**任何不是 zelto 托管规格的路径。
 *
 * 内容与待合 ref 一致 → 直接删；不一致（工作区那份是更早的冻结版）→
 * **先备份再删**（ZD-056），备份落在 `.zelto/backups/specs/<时间戳>/` 下。
 *
 * @param repoRoot 仓库根（主仓）
 * @param ref 待合 ref（如 `refs/heads/version/v3`）
 * @param opts.backupStamp 备份目录的时间戳（缺省用当前时间；测试可注入）
 */
export function clearUntrackedManagedSpecs(
  repoRoot: string,
  ref: string,
  opts: { backupStamp?: string } = {},
): UntrackedSpecCleanupResult {
  const result: UntrackedSpecCleanupResult = {
    removed: [],
    conflicts: [],
    backups: [],
    notes: [],
  };
  const backupRoot = join(
    repoRoot,
    '.zelto',
    'backups',
    'specs',
    opts.backupStamp ?? new Date().toISOString().replace(/[:.]/g, '-'),
  );

  const status = git(['status', '--porcelain', '--untracked-files=all'], repoRoot);
  if (status === null) {
    result.notes.push('读不到 git status —— 未跟踪规格文件未处理');
    return result;
  }

  for (const line of status.split('\n')) {
    if (!line.startsWith('?? ')) continue;
    const path = line.slice(3).trim();
    if (!path) continue;
    if (!isZeltoManagedSpecPath(path)) continue;

    // ref 上没有这个文件 → 合并不会覆盖它 → 不用管
    const atRef = contentAtRef(repoRoot, ref, path);
    if (atRef === null) {
      // 读不出来有两种可能：ref 上没有 / git 调用失败。
      // 用 ls-tree 再确认一次 —— 确认不了就不动（保守）。
      const listing = git(['ls-tree', '--name-only', ref, '--', path], repoRoot);
      if (listing === null || listing.trim().length === 0) continue;
      result.conflicts.push(path);
      result.notes.push(`${path}：读不到 ${ref} 上的内容，未处理`);
      continue;
    }

    // 工作区里这份副本
    const localPath = join(repoRoot, path);
    if (!existsSync(localPath)) continue;
    let local: string;
    try {
      local = readFileSync(localPath, 'utf-8');
    } catch {
      result.conflicts.push(path);
      result.notes.push(`${path}：读不到工作区里的副本，未处理`);
      continue;
    }

    // 内容不一样 → 工作区那份是更早的冻结版（ZD-056）：先备份，再让它让位。
    // 分支版是**本切片的正式产物**（已由门禁与签字覆盖）；工作区副本由
    // `zelto run` 在开跑时同步成冻结版，必然比分支版旧。内容不丢，只是挪个地方。
    if (normalizeContent(local) !== normalizeContent(atRef)) {
      const backup = join(backupRoot, path);
      try {
        mkdirSync(dirname(backup), { recursive: true });
        copyFileSync(localPath, backup);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.conflicts.push(path);
        result.notes.push(`${path}：工作区副本与 ${ref} 上的版本不同，且备份失败（${msg}），已保留`);
        continue;
      }
      result.backups.push({ path, backup });
      result.notes.push(
        `${path}：工作区副本与 ${ref} 上的版本不同（工作区是更早的冻结版，分支版是本切片产物）；已备份到 ${backup}，以分支版为准`,
      );
    }

    // 内容一致（只差行尾）→ 删掉未跟踪副本，让合并把 ref 上的版本落下来
    try {
      rmSync(localPath, { force: true });
      result.removed.push(path);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.conflicts.push(path);
      result.notes.push(`${path}：删除失败（${msg}）`);
    }
  }

  return result;
}
