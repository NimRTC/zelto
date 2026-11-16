// 事实收集 —— `zelto sign --review` 的 CLI 层入口（ADR-072 §5.1）
//
// 事实收集的**实现**已经下沉到 `core/sign-review/collect.ts`，
// 因为 CLI 与 Web UI（`adapters/web/`）必须共用同一份 ——
// 两处判定一旦漂移，就会重演 D-11（合并的两条路径判据不一致）。
//
// 本文件只做一件事：把 CLI 的全局单例（`store` / `events` / worktree）
// 装配成 core 版要的 `SignReviewSource`。

import { events, store, existingWorktreePath } from '../commands/shared.js';
import { collectSignReviewFacts as collectCore, type SignReviewSource } from '../../core/sign-review/collect.js';
import type { SignReviewFacts } from '../../core/sign-review/types.js';

/** CLI 侧的依赖装配 —— 全局单例 + 当前工作目录。 */
const cliSource: SignReviewSource = {
  readSlice: (id) => store.read(id),
  readEvents: (id) => events.read(id),
  worktreePath: (id) => existingWorktreePath(id),
  repoRoot: process.cwd(),
};

/**
 * 收集一片切片的签字复查事实（CLI 版）。
 *
 * 读 slice 文件、事件流、跑 git，全部是只读动作（C1/C4：不写状态、不追加事件）。
 */
export async function collectSignReviewFacts(sliceId: string): Promise<SignReviewFacts> {
  return collectCore(sliceId, cliSource);
}
