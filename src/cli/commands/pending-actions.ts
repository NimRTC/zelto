// CLI 侧的待办收集 —— 把 core/pending 的统一判定接到 CLI 的真实 store 上
//
// **判定在 core，收集在 CLI** —— 这是分层的理由：
//   - core/pending 不认识全局单例、不认识 CLI 的目录约定；
//   - CLI 这层负责把「仓库根 + 真实 store + git」接上去。
//
// Web 驾驶舱也调同一份 `core/pending/collect.ts` ——
// 两边的**判定与排序完全一致**，只有收集的上下文不同（Web 是多根的）。
//
// C3：只读文件与 git，不调模型、不触网。

import { join } from 'node:path';
import { SignManager, type SignRequest } from '../../core/gate/sign.js';
import {
  collectPendingFacts,
  rankPending,
  groupPending,
  topPending,
  type PendingItem,
  type PendingSource,
} from '../../core/pending/index.js';
import { buildBranchIndex } from '../../core/git/facts.js';
import { store, events, ZELTO_DIR, worktreeManager } from './shared.js';

/** 一条待办（CLI 侧对外的形状 —— 与 core 的 PendingItem 同构）。 */
export type { PendingItem, PendingKind } from '../../core/pending/index.js';

/** 各类待办的原始事实 —— 与 core 的 PendingFacts 同构。 */
export type { PendingFacts, PendingFact } from '../../core/pending/index.js';

/**
 * 收集 CLI 侧的全部待办事实。
 *
 * 只读文件与 git —— 不改状态、不发请求、不触网（C3）。
 */
export async function collectPendingFactsCli(): Promise<PendingSource> {
  const signManager = new SignManager(ZELTO_DIR, events, store);
  const manager = worktreeManager();
  const repoRoot = process.cwd();

  const source: PendingSource = {
    store,
    events,
    repoRoot,
    worktreePath: (sliceId: string) => (manager.exists(sliceId) ? manager.pathFor(sliceId) : null),
    branchFor: (sliceId: string) => manager.branchFor(sliceId),
    versionsDir: join(ZELTO_DIR, 'versions'),
    zeltoDir: ZELTO_DIR,

    listSliceIds: () => store.list(),
    readSlice: (id: string) => store.read(id),
    listSignRequests: (): Promise<SignRequest[]> => signManager.list(),

    // 分支事实**批量**问一次 —— 逐片问 git 在真实仓库里要跑 60 多秒。
    branchFacts: async () => buildBranchIndex(repoRoot),
  };

  return source;
}

/** 收集 + 排序 —— CLI 的「该你做什么」入口。 */
export async function collectRankedPending(): Promise<PendingItem[]> {
  const source = await collectPendingFactsCli();
  const facts = await collectPendingFacts(source);
  return rankPending(facts);
}

/** 收集 + 排序 + 分组 —— `zelto suggest` 用。 */
export async function collectGroupedPending(): Promise<{
  items: PendingItem[];
  groups: ReturnType<typeof groupPending>;
}> {
  const items = await collectRankedPending();
  return { items, groups: groupPending(items) };
}

/** 眼下最该做的一件事。 */
export async function collectTopPending(): Promise<PendingItem | null> {
  const items = await collectRankedPending();
  return topPending(items);
}
