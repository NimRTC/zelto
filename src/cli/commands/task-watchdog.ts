// 「看门狗单步处置」—— D-30 既有能力，加 ADR-129 三（主管半路死了的接管收尾）
//
// 为什么抽成独立模块（原先在 core-slice.ts 里）：`core-slice.ts` 是 CLI 注册表，
// 一 import 就会把整张命令表拉起来（副作用）；关于**任务文件**的单步处置
// 只需要 store / events / 活性判定 —— 被 `zelto task list`、驾驶舱、
// `zelto status` 共用，也应该能被单独测。
//
// 三个处置口径（全部确定性、只读文件 + 进程表 —— C3）：
//
//   1. 接管收尾（ADR-129 三 / ZD-049）：detach 任务、`task.runId` 那一轮
//      **没有结论事件**、主管已不在 → 写 `run.aborted`（watchdog、
//      `phase=supervisor`、带 runId 与 supervisorPid）—— 「主管半路死了」
//      必须在事件流里留下一条「它已经不管了」，而不是三处状态同时说谎。
//   2. 自动恢复（D-30）：`dead` 的 running 任务退回 frozen + 计数 + 事件，可重跑。
//   3. 上报（D-30）：恢复次数超预算 → 写 `run.stalled`，不再默默恢复。
//
// C1: 状态只落在文件里；C4: 每个处置写 append-only 事件

import { classifyLiveness, readSessionLiveness } from '../../core/activity/index.js';
import {
  decideRecovery,
  readRecoveries,
  recordEscalation,
  recordRecovery,
  MAX_AUTO_RECOVERIES,
} from '../../core/activity/watchdog.js';
import { events, store } from './shared.js';
import { isProcessAlive } from '../../core/sched/index.js';
import { findRunConclusion, type RunConclusion } from '../../core/sched/index.js';
import { type TaskInfo, mergeSessionLiveness, saveTask } from './task-store.js';

/** 任务当前的活性判定（与 `zelto status` / 驾驶舱同一口径）。 */
export function taskLivenessOf(task: TaskInfo): ReturnType<typeof classifyLiveness> {
  let session: ReturnType<typeof readSessionLiveness> = null;
  try {
    session = readSessionLiveness(process.cwd(), task.sessionId);
  } catch { /* 会话文件读不到就用任务文件本身 */ }
  return classifyLiveness(mergeSessionLiveness(task, session), { isProcessAlive });
}

/**
 * 「任务文件指的那一轮有没有起跑、有没有结论」—— 读事件流判定（ADR-129）。
 *
 * - `hasRun: false`：这一轮连 `run.started` 都找不到（旧任务 / 没写 runId）；
 *   调用方**不得**据此断言「没结论」，退回原有路径。
 * - `hasRun: true, conclusion: null`：起跑过、但没有结论 —— 需要有人接管。
 */
export async function findTaskRunConclusion(
  task: TaskInfo,
): Promise<{ hasRun: boolean; conclusion: RunConclusion | null }> {
  if (!task.runId) return { hasRun: false, conclusion: null };
  let stream: Awaited<ReturnType<typeof events.read>>;
  try {
    stream = await events.read(task.sliceId);
  } catch {
    return { hasRun: false, conclusion: null };
  }
  const hasStarted = stream.some((e) => {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    return e.type === 'run.started' && p.runId === task.runId;
  });
  if (!hasStarted) return { hasRun: false, conclusion: null };
  const conclusion = findRunConclusion(stream, task.runId);
  if (conclusion) return { hasRun: true, conclusion };
  // 起跑后**已经被别的路径收过尾**的也算「有结论」：看门狗的自动恢复、
  // 写集越界回退等路径写的 run.aborted 可能**不带** runId（历史路径），
  // 但它们的语义就是「这一轮结束了」。时间判据：起跑之后有任意一条
  // run.aborted / run.finished 且**不晚于**任务文件的最后一次活动 ——
  // 那就是这一轮（或更晚的一轮）的结论，不能再假装「没结论」重复接管。
  const startedAt = stream.find((e) => {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    return e.type === 'run.started' && p.runId === task.runId;
  })!;
  const legacy = stream.find(
    (e) =>
      (e.type === 'run.finished' || e.type === 'run.aborted') &&
      !((e.payload ?? {}) as Record<string, unknown>).runId &&
      e.ts >= startedAt.ts,
  );
  if (legacy) {
    return {
      hasRun: true,
      conclusion: {
        type: legacy.type as 'run.finished' | 'run.aborted',
        exitCode: null,
        reason: '（历史路径写的结论，不带 runId）',
        at: legacy.ts,
      },
    };
  }
  return { hasRun: true, conclusion: null };
}

/**
 * 看门狗单步处置（D-30 + ADR-129 三）：`dead` 的 running 任务自动恢复，超预算则上报。
 *
 * - 接管收尾：先给「没有结论」的那一轮写一条 `run.aborted`（见文件头）
 * - recover：任务文件置 failed + 切片 running→frozen + 计数 + 事件（可重跑）
 * - escalate：不再默默恢复 —— 任务保持 running，写 run.stalled 上报等人看
 *
 * 返回处置结果；非 dead 或已非 running 返回 `{ acted: false }`。
 */
export async function maybeRecoverDeadTask(
  task: TaskInfo,
): Promise<{ acted: boolean; action?: 'recover' | 'escalate' }> {
  if (task.status !== 'running') return { acted: false };
  const live = taskLivenessOf(task);

  // ── ADR-129 三：主管半路死了 → 接管收尾 ────────────────────────────────
  //
  // 触发条件（全部满足才接管）：
  //   1. 任务文件说 running；
  //   2. `task.runId` 指的那一轮在事件流里**既无 run.finished 也无 run.aborted**；
  //   3. 主管不在（有 supervisorPid 就查它；没有就看活性判 dead）。
  // 只接管 detach 任务（没有 supervisorPid 也没有 runId 的旧任务走原有路径）。
  if (task.supervisorPid !== undefined || task.runId !== undefined) {
    const { hasRun, conclusion } = await findTaskRunConclusion(task);
    const supervisorGone =
      task.supervisorPid !== undefined ? !isProcessAlive(task.supervisorPid) : live.state === 'dead';
    if (hasRun && conclusion === null && supervisorGone) {
      try {
        await events.append(task.sliceId, 'run.aborted', 'watchdog', {
          sliceId: task.sliceId,
          taskId: task.taskId,
          ...(task.runId ? { runId: task.runId } : {}),
          ...(task.supervisorPid !== undefined ? { supervisorPid: task.supervisorPid } : {}),
          phase: 'supervisor',
          reason: `主管已不在且这一轮没有结论（接管收尾）：${live.reason}`,
          supervisorGone: true,
        });
      } catch { /* 事件写不上就退回原有路径 */ }
    }
  }

  if (live.state !== 'dead') return { acted: false };
  const rec = readRecoveries(process.cwd(), task.sliceId);
  const decision = decideRecovery(rec);
  if (decision.action === 'recover') {
    task.status = 'failed';
    task.completedAt = new Date().toISOString();
    if (live.lastActivityAt) task.lastActivityAt = live.lastActivityAt;
    await saveTask(task);
    recordRecovery(process.cwd(), task.sliceId, live.reason);
    try {
      const s = await store.read(task.sliceId).catch(() => null);
      if (s && s.state === 'running') await store.transit(task.sliceId, 'RUN_FINISH');
    } catch { /* 切片不在 running 就不强掰 */ }
    await events.append(task.sliceId, 'run.aborted', 'watchdog', {
      sliceId: task.sliceId,
      taskId: task.taskId,
      ...(task.runId ? { runId: task.runId } : {}),
      ...(task.supervisorPid !== undefined ? { supervisorPid: task.supervisorPid } : {}),
      reason: `看门狗自动恢复：${live.reason}`,
      recoveries: rec.count + 1,
      maxAutoRecoveries: MAX_AUTO_RECOVERIES,
    });
    return { acted: true, action: 'recover' };
  }
  recordEscalation(process.cwd(), task.sliceId);
  await events.append(task.sliceId, 'run.stalled', 'watchdog', {
    sliceId: task.sliceId,
    taskId: task.taskId,
    ...(task.runId ? { runId: task.runId } : {}),
    reason: `同一切片假死 ${rec.count} 次已达上限（${MAX_AUTO_RECOVERIES}），不再自动恢复，请人看现场：${live.reason}`,
    escalated: true,
    recoveries: rec.count,
  });
  return { acted: true, action: 'escalate' };
}
