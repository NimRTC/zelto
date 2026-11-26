// 版本工作目录里的计划副本**保鲜** —— 让副本跟上真源
//
// ── 病灶（实测 nimrtc-v14，2026-11-27）───────────────────────────────
//
//   仓库根的 `.zelto/versions/<id>.json` 是**运行时真源**；
//   版本工作目录 `.zelto/version-worktrees/<label>/.zelto/versions/<id>.json`
//   是它的**副本**（ADR-121 建版时复制进去的）。
//
//   实测 ADR-127 修完归属之后：
//
//     根真源： v1=3  v2=1  v3=12  v4=3  v5=1     ← 已按规格归属修正
//     v5 副本：v1=10 v2=1  v3=5   v4=3  v5=1     ← 修正前的旧副本
//
//   副本**没有任何保鲜机制** —— 它是建版那一刻复制进去的，
//   之后 `zelto plan patch` 改真源，它不动。
//
//   后果不是「多显示一点旧信息」，是**归属解析被污染**：
//
//   `resolveSliceOwnership` 读的是**当前目录**下的 `.zelto/versions/`。
//   在版本工作目录里跑 `zelto merge` 时，读到的就是那份陈旧副本：
//
//     切片 v1-ice-recovery
//       根真源归属：v3   ← 规格自己写明归 v3，ADR-127 已修正
//       v5 副本归属：v1   ← 陈旧副本说的
//
//   于是「这片的基点从哪个版本分支 tip 起」「该合到哪条分支」
//   全部按**错误的归属**算 —— 追溯链说的和实际落点对不上。
//
// ── 为什么之前没人发现 ──────────────────────────────────────────────
//
//   因为 ADR-121 的原始病灶是「副本**根本不存在**」（`.zelto/versions/` 是空的），
//   修的时候只补了「建版时复制进去」。**复制**解决了「没有」，
//   但没解决「复制之后就再也不动了」。
//
//   这跟 ADR-110 缺陷四是同一个形状：「声明与现实不一致」——
//   只不过那次的副本是 CI 读的，这次是归属解析读的。
//
// ── 修法 ─────────────────────────────────────────────────────────────
//
//   真源一改，就把副本**同步**到所有已存在的版本工作目录。
//
//   为什么在「改计划」这一刻做，而不是「读计划」那一刻：
//   - 读的那一刻做 = 每个读点都要记得同步 = 漏一个就错一个；
//   - 改的那一刻做 = 一次写，所有副本同时跟上 = 不可能漏。
//
//   为什么**不**反过来让版本目录里的副本成为真源：
//   ADR-121 明确「计划文件是这一版的真源」—— 版本工作目录是**集成目录**，
//   同一个计划会同时存在于多个版本目录里（v3/v4/v5 各一份），
//   「谁是权威」会变成一个新问题。真源必须唯一。
//
// C1: 状态只在文件里（本模块只读文件、只写文件，不持有内存状态）
// C3: 确定性 —— 纯文件复制与内容比对，不调模型、不触网

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 一个计划副本的保鲜结果。 */
export interface PlanCopyRefresh {
  /** 版本工作目录（绝对路径） */
  worktreePath: string;
  /** 版本 label */
  label: string;
  /** 副本现在是不是与真源一致 */
  synced: boolean;
  /** 不一致时的原因（供人看） */
  reason?: string;
}

/** 版本工作目录里放计划副本的子目录（相对版本工作目录）。 */
export const VERSION_PLAN_SUBDIR = join('.zelto', 'versions');

/**
 * 版本工作目录的**基准目录**（相对仓库根）。
 *
 * 与 `core/worktree/manager.ts` 的 `VERSION_WORKTREE_BASE_DIR` 同源，
 * 但这里只需要相对路径，不碰 worktree 管理器（避免依赖方向倒置）。
 */
export const VERSION_WORKTREES_REL = join('.zelto', 'version-worktrees');

/**
 * 真源与副本是否一致。
 *
 * 比的是**内容**（逐字），不是 mtime —— 副本可能是从别处拷来的，
 * mtime 不可靠；而内容一致就说明副本是新鲜的。
 */
function isSameContent(src: string, dest: string): boolean {
  try {
    return readFileSync(dest, 'utf-8') === readFileSync(src, 'utf-8');
  } catch {
    // 读不到（不存在 / 权限）= 不一致，该同步
    return false;
  }
}

/**
 * 把一份计划同步到**一个**版本工作目录。
 *
 * 返回结果说明同步成没成 —— 失败不抛（副本是派生的，
 * 缺了它会让后续 merge 停下，但那可以在 merge 那一刻说清楚）。
 */
export function refreshPlanCopyIntoVersionWorkspace(
  repoRoot: string,
  worktreePath: string,
  planId: string,
): { synced: boolean; reason?: string } {
  const src = join(repoRoot, '.zelto', 'versions', `${planId}.json`);
  const destDir = join(worktreePath, VERSION_PLAN_SUBDIR);
  const dest = join(destDir, `${planId}.json`);

  if (!existsSync(src)) {
    return { synced: false, reason: `真源不存在：${src}` };
  }

  try {
    if (isSameContent(src, dest)) {
      return { synced: true };
    }
    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }
    copyFileSync(src, dest);
    // 写完核对 —— 「复制成功」不等于「副本对」（ADR-110 决策六的同一个要求）
    if (!isSameContent(src, dest)) {
      return { synced: false, reason: '复制后内容仍不一致' };
    }
    return { synced: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { synced: false, reason: msg };
  }
}

/**
 * 把一份计划同步到**所有**已存在的版本工作目录。
 *
 * 「所有已存在」= `<repoRoot>/.zelto/version-worktrees/` 下每个版本 label 目录
 * 里的**真源文件**。
 *
 * 为什么要按「真源文件」而不是「有 `.zelto/versions/` 目录」筛：
 *   - 建过版但没复制进计划的目录（ADR-121 修之前的老目录）也该补上；
 *   - 反过来，只按目录筛会漏掉「目录在但计划文件不在」。
 *
 * 版本目录里**没有计划**时也要复制吗？要 ——
 * 归属解析读的就是那个文件（ADR-121）。缺了它，归属解析会落空
 * （ADR-121 的原始病灶）。
 */
export function refreshPlanCopiesIntoAllVersionWorkspaces(
  repoRoot: string,
  planId: string,
): PlanCopyRefresh[] {
  const base = join(repoRoot, VERSION_WORKTREES_REL);
  if (!existsSync(base)) return [];

  const results: PlanCopyRefresh[] = [];
  let labels: string[];
  try {
    labels = readdirSync(base);
  } catch {
    return [];
  }

  for (const label of labels) {
    const worktreePath = join(base, label);
    // 必须是**目录** —— 版本工作目录是目录
    try {
      if (!statSync(worktreePath).isDirectory()) continue;
    } catch {
      continue;
    }
    const res = refreshPlanCopyIntoVersionWorkspace(repoRoot, worktreePath, planId);
    results.push({
      worktreePath,
      label,
      synced: res.synced,
      ...(res.reason ? { reason: res.reason } : {}),
    });
  }

  return results;
}

/**
 * 把保鲜结果说成人能读的样子。
 *
 * 说清「哪些版本目录的副本没跟上」—— 不说就是「悄悄留了个坑」。
 */
export function formatPlanCopyRefresh(results: PlanCopyRefresh[]): string[] {
  const stale = results.filter((r) => !r.synced);
  if (stale.length === 0) {
    if (results.length === 0) {
      return ['计划副本：没有已存在的版本工作目录，无需同步'];
    }
    return [`计划副本：${results.length} 个版本工作目录已与真源一致`];
  }
  const lines: string[] = [];
  for (const r of stale) {
    lines.push(
      `⚠️  计划副本未同步：版本工作目录 ${r.label}（${r.worktreePath}）` +
        (r.reason ? ` —— ${r.reason}` : '') +
        ' —— 在这个目录里跑 merge 时归属解析会读到旧计划',
    );
  }
  return lines;
}
