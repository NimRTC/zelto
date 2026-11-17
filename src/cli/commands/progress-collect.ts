// 采集「这一轮做成了什么」——**唯一一份实现**
//
// 为什么抽出来（实测于 nimrtc-zelto v3-chrome-waterfall，2026-11-18）：
//
// D-56 先接了 4 条失败路径（前台失败、前台越界、成功、监督进程），
// 漏掉了第 5 条 —— **看门狗收走**。漏掉的那条，单元测试**全绿**：
// 因为每条路径都单独测了，漏的那条没人测。
//
// 看门狗路径不走 `finishRun`（它自己写停机、写分类、写 `run.aborted`，
// 再走一遍收尾流水线会重复退状态），所以它得**自己**采集一次。
//
// 于是同一个「采集」有两份实现 —— 而两份必然漂移。
// 这正是 D-50（detach 监督进程）踩过的坑：收尾流水线拆成两份后，
// 一处跑门禁、一处忘了。
//
// 所以采集逻辑只写一份，放在这里，两条路径都调。
//
// C3: 判定确定性 —— 全是文件读取与纯计算，不调模型、不触网。

import { join, resolve } from 'node:path';

import { DEFAULT_ACCEPTANCE_COMMAND } from '../../core/gate/acceptance.js';
import {
  buildProgressReport,
  countAcceptanceCriteria,
  countAcceptanceTodos,
  listChangedFiles,
  runAcceptanceForProgress,
  type ProgressReport,
} from '../../core/progress/index.js';
import { store } from './shared.js';

/** 守卫要提供的东西 —— 只用到两个清单。 */
export interface ProgressGuardFacts {
  /** zelto 自己写进 worktree 的文件（规格副本、bundle） */
  managedPaths?: string[];
  /** worktree 建出来时就已经脏的路径（D-29 预置脏） */
  baselineChanged?: string[];
}

/**
 * 收集「这一轮做成了什么」。
 *
 * 收集的是**事实**，不是判断 —— 判断在 `core/progress/report.ts`。
 *
 * 三件事实：
 *   1. 规格里的验收标准有几条（真源，人写的）；
 *   2. 验收测试跑出来的逐条用例结果（真跑，不是 todo）；
 *   3. worktree 里实际改了哪些文件（git 事实）。
 *
 * `runAcceptance` 决定要不要真的跑一遍验收：
 *
 *   - **失败路径**（`exitCode !== 0`）→ 跑。此时门禁不会跑，
 *     「哪几条断言过了」是最该留下的信息，且只有这里能拿到。
 *   - **成功路径** → 不跑。门禁②紧接着就会跑同一份验收命令，
 *     这里再跑一遍是白等一次构建（有时是几分钟）。
 *     成功路径的验收结论由门禁事件自己留痕。
 *
 * 采集失败**不阻断收尾** —— 这是给人看的补充信息，不是判据。
 * 采集不到就少报一项，不假装有。
 */
export async function collectSliceProgress(input: {
  sliceId: string;
  /** 切片的 worktree 路径；null = 没有 worktree（就地跑） */
  worktree: string | null;
  /** 要不要真跑一遍验收测试 */
  runAcceptance: boolean;
  /** 守卫 —— 提供托管文件与预置脏清单 */
  guard?: ProgressGuardFacts | null;
  /** 审计判定的越界文件（审计的结论，不是重新算的） */
  violations?: string[];
}): Promise<ProgressReport | null> {
  const { sliceId, worktree, runAcceptance } = input;

  try {
    const slice = await store.read(sliceId);
    if (!slice) return null;

    const root = worktree ?? process.cwd();
    const specPath = slice.spec?.path
      ? (worktree
          ? join(worktree, slice.spec.path)
          : resolve(process.cwd(), slice.spec.path))
      : null;
    const criteriaTotal = countAcceptanceCriteria(specPath);

    const acceptanceDir = slice.acceptance?.dir ?? null;
    const todoCount = countAcceptanceTodos(acceptanceDir, root);

    // 跑验收只为拿逐条用例结果 —— 跑不动就少报「哪些断言过了」，其余照报。
    const acceptanceRun = runAcceptance
      ? runAcceptanceForProgress({
          acceptanceDir,
          root,
          commandTemplate: DEFAULT_ACCEPTANCE_COMMAND,
          timeoutSec: 120,
        })
      : null;

    const allChanged = worktree ? listChangedFiles(worktree) : [];

    // 「做成了什么」只算**agent 这一轮写的**文件。
    //
    // 要排除两类不是 agent 写的：
    //   - **托管文件**（zelto 自己写进 worktree 的规格副本、bundle）；
    //   - **预置脏**（worktree 建出来时就已经脏的路径，D-29）。
    //
    // 不排除的话，人看到「改了 3 个文件」，
    // 其中两个是 zelto 自己放的 —— 「做成了什么」就不准了。
    const managed = new Set((input.guard?.managedPaths ?? []).map((p) => p.replace(/\\/g, '/')));
    const baseline = new Set((input.guard?.baselineChanged ?? []).map((p) => p.replace(/\\/g, '/')));
    const changedFiles = allChanged.filter((f) => !managed.has(f) && !baseline.has(f));

    // 越界文件用**审计的结论**，不自己重算 ——
    // 审计已经处理了托管文件、预置脏、submodule 假脏等一堆细节，
    // 这里重算一遍必然对不上。
    const violations = new Set((input.violations ?? []).map((v) => v.replace(/\\/g, '/')));

    return buildProgressReport({
      criteriaTotal,
      cases: acceptanceRun?.cases ?? [],
      todoCount,
      changedFiles,
      outOfWriteSetFiles: changedFiles.filter((f) => violations.has(f)),
    });
  } catch {
    return null;
  }
}
