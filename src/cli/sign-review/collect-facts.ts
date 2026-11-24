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

/**
 * CLI 侧的依赖装配 —— 全局单例 + 当前工作目录。
 *
 * ── `repoRoot` 为什么是 getter 而不是普通属性 ─────────────────────────
 *
 * 普通属性（`repoRoot: process.cwd()`）在**模块加载那一刻**求值一次，
 * 之后不管 cwd 怎么变，它都指着加载时的那个目录。
 *
 * 什么时候会踩到：**从别的目录调起这个模块**。实测
 * （`tests/acceptance/v1-sign-review-cli/acceptance.test.cjs`）：
 * 测试先 `chdir` 到临时沙箱、再动态 `import()` 本模块 ——
 * 于是 `repoRoot` 固化成了**测试进程启动时的目录**（zelto 仓库根）。
 *
 * 后果不是「读不到」，是**读到了错的东西**：
 * `collectDiffFacts` 于是在**别的仓库**里跑 `git diff HEAD --numstat`，
 * 报出那个仓库的改动 —— 而人以为在看自己这片切片的改动。
 *
 * 「读不到」会退成 0（无害），**「读到别人的」是有害的**：
 * 它让签字复查显示一份**不相关**的改动清单。
 *
 * 所以这里用 getter —— **每次读都取当前 cwd**。
 * core 的 `SignReviewSource.repoRoot` 仍是 `string`（Web 侧传固定值，
 * 那是它该有的样子），只有 CLI 这一侧需要「跟着 cwd 走」。
 */
const cliSource: SignReviewSource = {
  readSlice: (id) => store.read(id),
  readEvents: (id) => events.read(id),
  worktreePath: (id) => existingWorktreePath(id),
  get repoRoot() {
    return process.cwd();
  },
};

/**
 * 收集一片切片的签字复查事实（CLI 版）。
 *
 * 读 slice 文件、事件流、跑 git，全部是只读动作（C1/C4：不写状态、不追加事件）。
 */
export async function collectSignReviewFacts(sliceId: string): Promise<SignReviewFacts> {
  return collectCore(sliceId, cliSource);
}
