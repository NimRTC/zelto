// 运行收尾流水线 —— 前台运行与后台监督进程**共用**同一份实现
//
// 为什么抽出来（实测于 nimrtc-zelto v2-input-binder，2026-11-17）：
//
//   `--detach` 的「后台监视器」原先是主进程里一个没 await 的 Promise。
//   主进程 `process.exit()` 时它跟着死 —— 于是：
//     - agent 变孤儿（还在改文件、还在烧 token）；
//     - 任务文件永远停在 `status: "running"`；
//     - 没人跑写集审计 → 越界写入不会被发现；
//     - 没人跑门禁 → 没有签字请求 → 切片永远卡在 frozen；
//     - 没人释放写集预约 → 下一片撞写集冲突。
//
//   人看到的是「切片在跑」，实际是**一个没人管的孤儿 agent**。
//
//   修法是让监视器成为**独立进程**（见 supervisor.ts，D-50）。
//   但一旦拆成两个进程，「收尾流水线」就有两份实现 ——
//   前台一份、监督进程一份。两份必然漂移（一处跑门禁、一处忘了）。
//
//   所以收尾逻辑只写一份，放在这里，两边都调。
//
// 本模块只做**收尾**（agent 已经跑完了），不做「等 agent 跑完」——
// 等待是各自的事（前台用适配器的 Promise，监督进程用进程表判据）。
//
// C3: 判定确定性 —— 这里全是文件读取与纯计算，不调模型、不触网

import { SignManager } from '../../core/gate/sign.js';
import { store, events, ZELTO_DIR } from './shared.js';
import { enforceWriteSet, type RuntimeGuard } from './runtime-guard.js';
import { join, resolve } from 'node:path';
import { DEFAULT_ACCEPTANCE_COMMAND } from '../../core/gate/acceptance.js';
import {
  autoGateAfterRun,
  markSliceStalled,
  settleRunCost,
} from './run-support.js';
import {
  budgetExhaustedMessage,
  printOutcome,
  writeSetOutcomeLines,
} from './run-messages.js';
import { classifyStall } from '../../core/stall/classifier.js';
import type { ExecutorAdapter } from '../../core/ports/executor.js';
import { isInWriteSet } from '../../core/spec/write-set.js';
import { formatProgressLines, type ProgressReport } from '../../core/progress/index.js';
import { collectSliceProgress } from './progress-collect.js';

/** 收尾的输入 —— 前台与监督进程给的是同一组事实。 */
export interface FinishRunOptions {
  sliceId: string;
  sessionId: string;
  /** agent 的退出码；null = 信号终止 / 结果不明 */
  exitCode: number | null;
  /** 本轮耗时（秒） */
  elapsedSec: number;
  /** 运行时守卫（写集审计要用） */
  guard: RuntimeGuard | null;
  /** 适配器（花费结算与提问回路要用） */
  adapter: ExecutorAdapter;
  /** 是否 hotfix（跳过门禁②并直接签字） */
  isHotfix: boolean;
  /**
   * 是否已经记过账（看门狗收走的那一轮已经记了）。
   * 不重复记 —— 一次运行只能有一条运行记录（ADR-041 §3.1）。
   */
  alreadyRecorded?: boolean;
  /**
   * 切片是否**已经停机**了。
   *
   * 前台运行：会先调 `handleAgentFailure` —— 它在重试预算耗尽时**已经**
   * 把切片停机了（退 frozen + 写分类）。这时 `finishRun` 不能再停一次：
   * 状态迁两遍 + 停机事件写两遍（ADR-047 §2.1.1）。
   *
   * 后台监督进程：没有重试循环，agent 挂了就是挂了 ——
   * 由 `finishRun` 负责停机（否则切片永远卡在 running，ADR-047）。
   */
  alreadyStalled?: boolean;
  /**
   * 输出到哪去。
   *
   * 前台运行 → stdout（人看着）；
   * 监督进程 → 日志文件（detached 进程没人接 stdout）。
   * 默认 stdout。
   */
  write?: (line: string) => void;
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
async function collectProgress(
  sliceId: string,
  worktree: string | null,
  opts: {
    runAcceptance: boolean;
    /** 守卫 —— 提供托管文件与预置脏清单 */
    guard: RuntimeGuard | null;
    /** 审计判定的越界文件（审计的结论，不是重新算的） */
    violations: string[];
  },
): Promise<ProgressReport | null> {
  // 实现放在 `progress-collect.ts` —— 看门狗路径也调同一份。
  //
  // 为什么不就地写：看门狗收走时**不走 finishRun**（它自己写停机、
  // 写分类、写 run.aborted），所以它得自己采集一次。
  // 两处各写一份 = 必然漂移 —— 而漂移的方向恰好是「漏掉一条路径」。
  return collectSliceProgress({
    sliceId,
    worktree,
    runAcceptance: opts.runAcceptance,
    guard: opts.guard,
    violations: opts.violations,
  });
}

/**
 * agent 跑完之后的收尾流水线。
 *
 * 顺序有讲究，不能换：
 *
 *   1. **记账** —— 一次 agent 运行 = 一条运行记录（ADR-041 §3.1）。
 *      记在写集审计之前：审计只判「有没有越界」，
 *      不改变「agent 跑没跑完」这个事实。
 *   2. **写集审计**（ADR-014 §5）—— 拿 git 的真实改动对一次写集。
 *      静态分析拦不住的写（`node -e "fs.writeFileSync(...)"` 之类）到这里兜住。
 *   3. **提问回路**（ADR-013 §3.6）—— agent 以问题收尾时挂起切片等人回答。
 *   4. **状态迁移 + 门禁 + 签字请求**。
 *
 * @returns 收尾结论 —— 调用方据此决定退出码
 */
export interface FinishRunResult {
  /** 这一轮是否算「成功跑完」 */
  ok: boolean;
  /** 切片现在的状态 */
  state: string;
  /** 是否有越界写入 */
  violated: boolean;
  /** 是否因超预算停下 */
  budgetExhausted: boolean;
  /** 是否挂起等人回答 */
  suspended: boolean;
  /** 生成的签字请求 id（若有） */
  signRequestId?: string;
}

export async function finishRun(options: FinishRunOptions): Promise<FinishRunResult> {
  const {
    sliceId,
    sessionId,
    exitCode,
    elapsedSec,
    guard,
    adapter,
    isHotfix,
    alreadyRecorded = false,
    alreadyStalled = false,
  } = options;
  const write = options.write ?? ((line: string) => console.log(line));

  // ── 1. 记账（ADR-041 §3.1）────────────────────────────────────────────
  if (!alreadyRecorded) {
    try {
      await store.recordRun(sliceId, { ok: exitCode === 0, exitCode });
    } catch {
      /* 记账失败不阻断 —— 现场比账本重要 */
    }
  }

  // ── 2. 写集审计（ADR-014 §5）──────────────────────────────────────────
  //
  // 「做成了什么」由惰性回调在**审计之后**采集 —— 采集要跑验收，
  // 会动工作区；放在审计前面跑，验收的产物会被算成越界写入。
  //
  // 惰性还保证了它只在**真的要写事件**时才跑：
  // 审计通过（没有越界）时，事件由下面的失败分支/成功分支写，
  // 那两条路径各自需要时才采集。
  let progress: ProgressReport | null = null;
  let progressCollected = false;
  /**
   * 惰性采集「做成了什么」。
   *
   * `violations`：审计判定的越界文件（审计的结论，不是重新算的）。
   */
  const progressPayload = async (
    violations: string[] = [],
  ): Promise<Record<string, unknown> | null> => {
    if (!progressCollected) {
      progressCollected = true;
      // 只在**失败路径**跑验收（exitCode !== 0）：成功路径门禁②紧接着就会跑
      // 同一份验收命令，这里再跑一遍是白等一次构建。
      progress = await collectProgress(sliceId, guard?.hookRoot ?? null, {
        runAcceptance: exitCode !== 0,
        guard,
        violations,
      });
    }
    return progress ? { progress } : null;
  };

  const withinBounds = await enforceWriteSet(sliceId, guard, progressPayload);

  // ── 3. agent 失败：停机（ADR-047）─────────────────────────────────────
  if (exitCode !== 0) {
    // agent 失败 ≠ 没有越界 —— 失败的那一轮同样可能写了越界的文件。
    // 越界文件清单是人决定「扩写集还是重做规格」的唯一依据；
    // 只报 agent 失败，人会以为「只是没写完」，白跑一轮。
    const outcomeLines = writeSetOutcomeLines({ sliceId }, withinBounds);
    if (outcomeLines.length > 0) {
      write('');
      printOutcome(outcomeLines, write);
    } else {
      // 只有「没有越界」时才由这里写 run.aborted。
      // 有越界时 `enforceWriteSet` 已经写过一条（reason: write-set violation），
      // 再写一条只会让人误以为发生了两次。
      try {
        await events.append(sliceId, 'run.aborted', 'zelto', {
          sliceId,
          exitCode,
          // 「做成了什么」—— 事件流是追溯的唯一载体（ADR-004），
          // 所以这一项不能只留在终端输出里。
          ...((await progressPayload()) ?? {}),
        });
      } catch { /* 留痕失败不阻断停机 */ }
    }

    // 「做成了什么」—— 失败现场最该留下的信息。
    await progressPayload();
    if (progress) {
      write('');
      for (const line of formatProgressLines(progress)) write(line);
    }

    // 后台路径同样走「停机的唯一落点」—— 退回 frozen + 写分类 + 留痕。
    // 一次运行，它的 agent 挂了，切片不能留在 running：
    // 留在 running 就再也跑不了（ADR-047）。
    //
    // 但**已经停过机的不再停一次**（ADR-047 §2.1.1）：
    // 停机是一个**事实**，不是一个要重复执行的动作。
    // 前台路径的重试预算耗尽时 `handleAgentFailure` 已经停过一次了，
    // 这里再停一次 = 状态迁两遍 + 停机事件写两遍。
    if (!alreadyStalled) {
      try {
        await markSliceStalled(
          sliceId,
          classifyStall({
            type: exitCode === null ? 'build_failure' : 'test_failure',
            message: `Agent exited with code ${exitCode ?? 'signal'}`,
            attempts: 1,
          }),
          { exitCode, reason: `agent failed: ${exitCode ?? 'signal'}` },
        );
      } catch { /* 状态被别处改过：事件照样留 */ }
    }

    return {
      ok: false,
      state: 'frozen',
      violated: !withinBounds.ok,
      budgetExhausted: false,
      suspended: false,
    };
  }

  // ── 4. 提问回路（ADR-013 §3.6）────────────────────────────────────────
  //
  // agent 以问题收尾时，不算「运行成功」——挂起切片等人回答。
  // 检测是确定性字符串解析，不调用模型。
  const { detectQuestion, suspendSliceForQuestion } = await import('./question.js');
  const question = await detectQuestion(sliceId, adapter, sessionId);
  if (question) {
    await suspendSliceForQuestion(sliceId, question);
    write(`\n❓ Agent asked a question (${question.type}) after ${elapsedSec}s:`);
    write(`   ${question.question}`);
    if (question.options.length > 0) {
      write(`   Options: ${question.options.join(' | ')}`);
    }
    write(`   Slice "${sliceId}" is suspended — answer with:`);
    write(`   zelto answer ${question.id} "<your answer>"`);
    return {
      ok: true,
      state: 'suspended',
      violated: false,
      budgetExhausted: false,
      suspended: true,
    };
  }

  // ── 5. 越界：不进 gate、不自动签字 —— 等人处理 ────────────────────────
  if (!withinBounds.ok) {
    // `enforceWriteSet` 已经把切片退回 frozen（可重跑）并写了 run.aborted 事件。
    //
    // 审计失败与越界分开说 —— 前者是「边界未知」，下一步是修环境；
    // 后者是「越界已证实」，下一步是扩写集。混着说会让人白跑一轮。
    write('');
    printOutcome(writeSetOutcomeLines({ sliceId }, withinBounds), write);

    // 「做成了什么」—— 越界恰恰是最需要它的时候。
    //
    // 只说「它越界了」，人只能重跑；重跑会把做对的部分再做一遍，
    // agent 大概率在同一个地方再岔一次（实测 v2-input-binder）。
    await progressPayload();
    if (progress) {
      write('');
      for (const line of formatProgressLines(progress)) write(line);
    }

    return {
      ok: false,
      state: 'frozen',
      violated: true,
      budgetExhausted: false,
      suspended: false,
    };
  }

  // ── 6. 状态迁移 + 花费结算 + 门禁 + 签字请求 ──────────────────────────
  await store.transit(sliceId, 'RUN_FINISH');

  // 花费结算（ADR-035）：先记账，再复判预算。
  // 超预算的切片**不进 gate、不发签字请求** —— 现场交回给人（与 ADR-020 一致）。
  const cost = await settleRunCost(sliceId, adapter, sessionId);
  await events.append(sliceId, 'run.finished', 'zelto', {
    sliceId,
    exitCode: 0,
    costUsd: cost.costUsd,
    // 「做成了什么」—— 成功的那轮同样要留痕，
    // 否则事后复盘只能看到「过了」，看不到「过了什么」。
    ...((await progressPayload()) ?? {}),
  });
  write(`✅ Agent completed successfully (${elapsedSec}s)`);

  if (cost.exhausted) {
    printOutcome(budgetExhaustedMessage({ sliceId }, cost.spent, cost.limit), write);
    return {
      ok: true,
      state: 'frozen',
      violated: false,
      budgetExhausted: true,
      suspended: false,
    };
  }

  if (isHotfix) {
    // Hotfix: skip gate, auto-sign, write hotfix event
    await store.transit(sliceId, 'GATE_PASS');
    await events.append(sliceId, 'slice.hotfix', 'zelto', {
      sliceId,
      elapsed: elapsedSec,
      note: 'hotfix — gate skipped, auto-approved',
    });
    const signManager = new SignManager(ZELTO_DIR, events, store);
    const signReq = await signManager.request(sliceId, 'zelto');
    await signManager.approve(signReq.id, 'zelto');
    write(`  ⏭ Hotfix: gate skipped, auto-approved (${signReq.id})`);
    return {
      ok: true,
      state: 'signed',
      violated: false,
      budgetExhausted: false,
      suspended: false,
      signRequestId: signReq.id,
    };
  }

  // 跑门禁 + 发签字请求
  await autoGateAfterRun(sliceId);
  return {
    ok: true,
    state: 'frozen',
    violated: false,
    budgetExhausted: false,
    suspended: false,
  };
}
