// 提问回路续跑段的运行时守卫（ADR-139）
//
// ## 这个模块解决什么
//
// `zelto answer` 的续跑段必须**重新装**运行时守卫（C9 的主防线 ——
// PreToolUse 钩子逐写判定）。
//
// `zelto run` 的守卫在它自己的 `finally` 里释放了 —— 提问挂起时
// `zelto run` 正常退出，`finally` 跑掉，钩子被撤掉、预约被释放。
// `zelto answer` 是**另一个进程**，它不装守卫就等于
// **在没有任何运行时写集强制的情况下运行 agent**（C9 的主防线消失）。
//
// 实测证据（探针切片 `probe-claude-smoke`，2026-11-28）：
// `reservation.released`（00:33:18）**早于** `run.resumed`（00:33:30）——
// 守卫在续跑开始前就没了，续跑段一条 `policy.decision` 都没有。
//
// ## 为什么单独一个模块
//
// 装守卫这件事本身只有几行，但它要的输入很杂（写集、worktree 路径与基点、
// 托管文件清单、规格完整性锚、harness 与写集强制方式）。
//
// 更要紧的是**导入环**：`zeltoOwnedPaths` 原先住在 `parallel-executor.ts`，
// 而那个文件 import 了 `question.ts`（并行路径要检测提问）。
// 于是 `question.ts` → `parallel-executor.ts` → `question.ts` 成环，
// `question.ts` 拿不到托管文件清单。
//
// 解法是**把 `zeltoOwnedPaths` 挪到 `shared.ts`** ——
// 它不 import 任何 CLI 命令文件（只 import `core/` 与 `adapters/`），
// 所以谁都能 import 它。环被打断，判定仍然只有**一份**。
//
// 本模块只负责「装守卫」这一层；释放由调用方在 `finally` 里做
// （释放的时机有讲究 —— 见 `question.ts` 里的注释）。

import {
  buildSpecIntegrity,
  harnessForAdapter,
  store,
  worktreeManager,
  writeGuardForAdapter,
  zeltoOwnedPaths,
} from './shared.js';
import { installRuntimeGuard, type RuntimeGuard } from './runtime-guard.js';

/** 续跑守卫的装法选项。 */
export interface ResumeGuardOptions {
  /** 切片 id */
  sliceId: string;
  /** adapter 类型（决定 harness 与写集强制方式） */
  adapterType: string | undefined;
  /** 仓库根（预约与策略的落点） */
  projectRoot: string;
}

/**
 * 给提问回路的续跑段装上运行时守卫。
 *
 * **写集从切片记录取，不从 bundle 取**（ADR-139 决策四）：
 * bundle 是起跑进程的快照；续跑是另一个进程，读 bundle 会引入
 * 「快照与当前记录不一致」的可能。切片记录里的 `writes` 是冻结时钉住的，
 * 才是「这片允许写什么」的权威。
 *
 * **基线快照自然重拍**：`installRuntimeGuard` 每次调用都重拍 D-29 基线
 * （此刻 worktree 已经脏的路径）。续跑时调用它，就自然是「续跑开始时的脏文件」
 * —— 首轮的产出不会被误当成「预置脏」排除掉，续跑段真正越界写的东西
 * 反而不会被放过。
 *
 * @throws 拿不到写集预约时抛错 —— 调用方据此**拒绝续跑**（C9 的 fail closed）。
 */
export async function installResumeGuard(
  options: ResumeGuardOptions,
): Promise<RuntimeGuard> {
  const slice = await store.read(options.sliceId);

  // worktree：切片有隔离目录就装在隔离目录里，没有就装在项目根。
  //
  // 基点取 worktree 的 baseCommit（与 `zelto run` 同口径）——
  // 审计要回答「本片 agent 改了什么」，基点错了会把别的提交算成本片的。
  const manager = worktreeManager();
  const worktree = manager.exists(options.sliceId)
    ? manager.pathFor(options.sliceId)
    : null;
  const baseCommit = worktree
    ? (await manager.list()).find((w) => w.path === worktree)?.baseCommit ?? null
    : null;

  return installRuntimeGuard({
    sliceId: options.sliceId,
    writes: slice.writes,
    worktree,
    projectRoot: options.projectRoot,
    baseCommit,
    // 托管文件清单：zelto 自己写进 worktree 的文件（规格副本、约束包等）——
    // 审计时不能算成 agent 的越界写入（D-60）。
    managedPaths: zeltoOwnedPaths(worktree, slice),
    // ADR-106 §2：规格在写集里 → 不托管，但「冻结需求仍在」是硬约束。
    specIntegrity: buildSpecIntegrity(worktree, slice),
    // 装哪种 harness 的钩子 —— adapter 决定跑的是谁（ADR-083）。
    harness: harnessForAdapter(options.adapterType),
    // ADR-133：C9 的主判定点。ACP 路线**不装钩子**（判定在 permission 回调里）。
    writeGuard: writeGuardForAdapter(options.adapterType),
  });
}
