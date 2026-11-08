// 已完成切片的交付状态 —— 「过了门禁」到「进了主干」之间的那段路
//
// 为什么单列一个模块：切片的 `completed` 状态同时表示「门禁②过了」与
// 「人签过字」（ADR-018：签字不改状态，SIGN_APPROVE 停在 completed）。
// 于是同一个状态字底下压着五种完全不同的现实：
//
//   已合入主干        —— 产物已经在主干的代码里，事情做完了
//   待合并            —— 签过字了，但分支还没合
//   待签字            —— 门禁过了，签字请求还挂着没人签
//   未发起签字        —— 门禁过了，但签字请求压根没发起过（或被撤销）
//   无分支            —— 接管既有项目时映射出来的基线切片，没有分支可签
//
// 只按状态统计的话，这五类在「Project Overview」里都只是一个 `completed: 12`。
// 人看到 12 个完成，却不知道有 3 个还压在主干外面、2 个根本没人签过字。
//
// 判据全部来自别处（这里不重新实现任何判定）：
//   - 签字状态：`.zelto/locks/sign-*.json`（与 inbox / merge / next 同源）
//   - 合并状态：`collectMergeCandidates()`（与 `zelto merge` 同源）
//   - 分支状态：git（与 merge-executor 同源）
//
// 「待合并」刻意复用 `collectMergeCandidates()` 而不是自己判 `isMergedIntoHead` ——
// 合并候选的口径里含「分支已合入但 worktree 还有未提交产物」这一种，
// 自己重判会把这种切片误报成「已合入主干」。
//
// C3：只读文件与 git，不调模型、不触网。

import { SignManager, type SignRequest } from '../../core/gate/sign.js';
import { store, events, ZELTO_DIR, worktreeManager } from './shared.js';
import { listLocalBranches, listMergedIntoHead } from './merge-executor.js';
import { collectMergeCandidates } from './merge-runner.js';

/** 一个已完成切片眼下处在交付链的哪一环 */
export type DeliveryStatus =
  | 'merged'          // 已合入主干
  | 'awaiting-merge'  // 已签字，等着合
  | 'awaiting-sign'   // 门禁过了，等人签字
  | 'unsigned'        // 门禁过了，但签字请求没发起过（或被撤销）
  | 'no-branch'       // 没有分支也没有有效签字 —— 基线 / 历史切片
  | 'abandoned';      // 签字被拒 —— 切片作废（ADR-021）

export interface CompletedSliceInfo {
  id: string;
  title: string;
  /** 最近更新时间（排序用） */
  updatedAt: string;
  status: DeliveryStatus;
  /** 分支还在不在（已合并并清理后为 false） */
  branchExists: boolean;
}

export interface CompletedSummary {
  /** 按交付状态分组的切片 */
  slices: CompletedSliceInfo[];
  /** 各状态的计数 */
  counts: Record<DeliveryStatus, number>;
  /** 总数 */
  total: number;
}

/** 判定交付状态所需的全部事实 */
export interface DeliveryFacts {
  /** 切片状态 */
  sliceState: string;
  /** 最新一条签字请求的状态；没有签字请求为 null */
  signStatus: SignRequest['status'] | null;
  /** 该切片是否在 `zelto merge` 的候选清单里（已签字但还没合） */
  isMergeCandidate: boolean;
  /** 分支还在不在 */
  branchExists: boolean;
  /** 分支是否已合入 HEAD */
  mergedIntoHead: boolean;
}

/**
 * 把一个已完成切片归到交付链的某一环。
 *
 * 纯函数 —— 不读文件、不碰 git，只按给定的事实判定。
 * 这样口径可以被单测锁住（`tests/completed-slices.test.ts`），
 * 也能在别处复用而不重复实现。
 *
 * 判据的顺序有讲究：
 *   1. 切片作废（abandoned / 签字被拒）先判 —— 不管它有没有分支；
 *   2. 签字请求挂着（pending）次之 —— 有人在签，等的是人；
 *   3. 签过字了（approved）看合并候选 —— 与 `zelto merge` 同源；
 *   4. 剩下的（没签过 / 签过又撤销）才看分支 —— 分支不在说明它压根
 *      不在交付链上（基线切片），别把它算成「该签字却没人签」。
 */
export function classifyDelivery(facts: DeliveryFacts): DeliveryStatus {
  if (facts.sliceState === 'abandoned') return 'abandoned';
  if (facts.signStatus === 'rejected') return 'abandoned';
  if (facts.signStatus === 'pending') return 'awaiting-sign';
  if (facts.signStatus === 'approved') {
    return facts.isMergeCandidate ? 'awaiting-merge' : 'merged';
  }
  // 没签过（null）或签过又被撤销（revoked）
  if (!facts.branchExists) return 'no-branch';
  if (facts.mergedIntoHead) return 'merged';
  return 'unsigned';
}

/**
 * 每个切片取**最新一条**签字请求。
 *
 * 一个切片可能有多条签字请求（重签、撤销后再签）。判据只看最新那条 ——
 * 否则撤销过一次的切片会同时算进「待签字」和「已签字」。
 */
function latestSignRequestPerSlice(requests: SignRequest[]): Map<string, SignRequest> {
  const latest = new Map<string, SignRequest>();
  for (const req of requests) {
    if (!latest.has(req.sliceId)) latest.set(req.sliceId, req);
  }
  return latest;
}

/**
 * 把已完成切片按交付状态分类。
 *
 * 「已合入主干」的判据是 git 与合并候选清单（见文件头的说明）。
 */
export async function collectCompletedSummary(): Promise<CompletedSummary> {
  const signManager = new SignManager(ZELTO_DIR, events, store);
  const latest = latestSignRequestPerSlice(await signManager.list());
  const manager = worktreeManager();
  const repoRoot = process.cwd();

  // 与 `zelto merge` 同源：已签字但还没合进主干的切片。
  const mergeCandidates = new Set((await collectMergeCandidates()).map((c) => c.id));

  // 分支事实批量取一次 —— 逐切片跑 git 的话，切片一多光审计就要几秒。
  const localBranches = listLocalBranches(repoRoot);
  const mergedBranches = listMergedIntoHead(repoRoot);

  const slices: CompletedSliceInfo[] = [];

  for (const id of await store.list()) {
    let state: string;
    let title: string;
    let updatedAt: string;
    try {
      const s = await store.read(id);
      state = s.state;
      title = s.title ?? '';
      updatedAt = s.updatedAt ?? '';
    } catch {
      continue;
    }

    // 只有 completed / abandoned 参与交付状态统计：
    // 前者是「走到终点了，看看走到哪一步」，后者是「被拒了，作废」。
    if (state !== 'completed' && state !== 'abandoned') continue;

    const branch = manager.branchFor(id);
    const hasBranch = localBranches.has(branch);
    const mergedIntoHead = hasBranch && mergedBranches.has(branch);

    const status = classifyDelivery({
      sliceState: state,
      signStatus: latest.get(id)?.status ?? null,
      isMergeCandidate: mergeCandidates.has(id),
      branchExists: hasBranch,
      mergedIntoHead,
    });

    slices.push({ id, title, updatedAt, status, branchExists: hasBranch });
  }

  // 最近的排前面 —— 人关心的是「刚做完的那批」。
  // 时间相同时按 id 排，保证同样的输入给出同样的顺序（可复现）。
  slices.sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? -1 : 1;
    return a.id.localeCompare(b.id);
  });

  const counts: Record<DeliveryStatus, number> = {
    merged: 0,
    'awaiting-merge': 0,
    'awaiting-sign': 0,
    unsigned: 0,
    'no-branch': 0,
    abandoned: 0,
  };
  for (const s of slices) counts[s.status]++;

  return { slices, counts, total: slices.length };
}

/** 交付状态的人话标签 */
export function deliveryLabel(status: DeliveryStatus): string {
  switch (status) {
    case 'merged': return '已合入主干';
    case 'awaiting-merge': return '已签字 · 待合并';
    case 'awaiting-sign': return '门禁通过 · 待签字';
    case 'unsigned': return '门禁通过 · 未发起签字';
    case 'no-branch': return '基线切片 · 无分支';
    case 'abandoned': return '已作废';
  }
}

/** 展示时的固定顺序 —— 从「需要人动手」到「已经了结」 */
export const DELIVERY_ORDER: DeliveryStatus[] = [
  'awaiting-sign',
  'awaiting-merge',
  'unsigned',
  'merged',
  'no-branch',
  'abandoned',
];

/**
 * 交付状态的一行式汇总。
 *
 * 只给计数，不列切片 id —— 列 id 的活儿归 `suggest` 的待办段与
 * `pendingActions`（它们带具体命令）。这里回答的是另一个问题：
 * 「这些做完的切片，到底有多少真的进了主干」。
 */
export function deliverySummaryLine(summary: CompletedSummary): string {
  if (summary.total === 0) return '';
  const c = summary.counts;
  return [
    `已合入主干 ${c.merged}`,
    `待签字 ${c['awaiting-sign']}`,
    `待合并 ${c['awaiting-merge']}`,
    `未发起签字 ${c.unsigned}`,
    `基线无分支 ${c['no-branch']}`,
  ].join(' · ');
}
