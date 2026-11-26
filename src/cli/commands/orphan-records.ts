// 孤立的运行记录（会话文件 / 任务文件）—— 找出与收尾
//
// 为什么独立成文件：
// 「找出残留记录」与「把残留记录收尾」这件事有三处要做：
//   - `zelto run` 的重复 agent 守卫（ADR-124 修法二）：放行前先收尾
//     那条「stale 且无 pid」的残留记录，否则下一轮守卫又撞上它；
//   - `zelto stall --reap` 的批量清理（ADR-053）：收尾切片名下所有
//     还写着 running 的任务文件。
// 两处必须**同一份口径**（同一份记录来源、同一套字段）——
// 否则「列表里看得见的残留」与「清理时收不掉的残留」会分叉，
// 那正是 D-65 病灶的形状。
//
// C1: 状态只落在文件里
// C4: 收尾动作由调用方写事件（这里只改文件里的状态字段）

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SESSIONS_DIR_REL,
  TASKS_DIR_REL,
  classifyLivenessAsync,
  hasPidOf,
  type LivenessRecord,
} from '../../core/activity/index.js';
import { isProcessAlive, isProcessTreeAlive } from '../../core/sched/index.js';

/** 一条还在盘上的运行记录（会话文件或任务文件）。 */
export interface RunningRecordFile {
  /** 记录来自哪个目录 —— 收尾时用它挑理由文案 */
  kind: 'session' | 'task';
  /** 文件绝对路径 */
  path: string;
  /** 文件名（不含目录） */
  file: string;
  /** 记录内容 */
  record: LivenessRecord;
  /** 这条记录有没有 pid 可查（ADR-124 修法二的分界） */
  hasPid: boolean;
}

/**
 * 读一片切片的**全部**还在 running 的记录（会话目录 + 任务目录）。
 *
 * 为什么合并两个目录（ADR-124 修法一）：
 * 现场不是「会话目录有、任务目录没有」，而是两边都可能各有一半 ——
 * 实测 nimrtc-v14 `v4-d5-audio-dtx`：会话文件被覆盖写成 0 字节，
 * 任务文件还停在 running。只读一个目录就会漏掉另一半。
 *
 * @param projectRoot 项目根
 * @param sliceId 切片 id
 * @param onlyNoPid 只留「没有 pid 可查」的记录（ADR-124 修法二用）
 */
export function readRunningRecordFiles(
  projectRoot: string,
  sliceId: string,
  options: { onlyNoPid?: boolean } = {},
): RunningRecordFile[] {
  const out: RunningRecordFile[] = [];
  for (const [kind, dirRel] of [
    ['session', SESSIONS_DIR_REL],
    ['task', TASKS_DIR_REL],
  ] as const) {
    const dir = join(projectRoot, dirRel);
    if (!existsSync(dir)) continue;
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const path = join(dir, file);
      let parsed: LivenessRecord;
      try {
        parsed = JSON.parse(readFileSync(path, 'utf-8').replace(/^\uFEFF/, '')) as LivenessRecord;
      } catch {
        continue; // 0 字节 / 坏文件 —— 读不出就不是「有人管」
      }
      if (!parsed || typeof parsed !== 'object') continue;
      if (parsed.sliceId !== sliceId) continue;
      if (parsed.status !== undefined && parsed.status !== 'running') continue;
      const hasPid = hasPidOf(parsed);
      if (options.onlyNoPid && hasPid) continue;
      out.push({ kind, path, file, record: parsed, hasPid });
    }
  }
  return out;
}

/**
 * 重复 agent 守卫的判定结果（ADR-124 修法二）。
 *
 * - `blocked`  —— 确实有人在管这一轮 → 拒绝起跑
 * - `pass`     —— 没人管（没有记录 / 记录全无 pid 可查）→ 放行
 */
export type DuplicateAgentVerdict =
  | { decision: 'blocked'; reason: string }
  | { decision: 'pass'; staleNoPid: RunningRecordFile | null };

/**
 * 重复 agent 守卫 —— **唯一一份判据**（ADR-124 修法二）。
 *
 * 判据（两个目录里的全部 running 记录，逐条判活）：
 *   - `active`                      → 阻塞（确实有人在管）
 *   - `stale` **且有** pid          → 阻塞（可能只是长时间构建，不下死手）
 *   - `stale` **且无** pid          → 放行，并收尾那条残留记录
 *   - `dead`                        → 放行（进程确实没了）
 *
 * 为什么「有 pid 的 stale」仍然阻塞：pid 可以问进程表 —— 判活是**确定**的。
 * 而「无 pid 的 stale」只能靠时间推断，没有任何东西能证明它还活着；
 * 继续把它当活着的，就会出现「人想重跑却被弹回去、每次还写一条 run.aborted」
 * （实测 nimrtc-v14 `v4-d5-audio-dtx`，2026-11-26）。
 *
 * 放行时把那条「无 pid 的 stale 记录」收尾（置 failed）—— 不收干净的话，
 * 下一轮守卫又撞上同一条记录，重跑这条路永远是堵的。
 *
 * @param projectRoot 项目根
 * @param sliceId 切片 id
 */
export async function judgeDuplicateAgent(
  projectRoot: string,
  sliceId: string,
): Promise<DuplicateAgentVerdict> {
  const records = readRunningRecordFiles(projectRoot, sliceId);
  let staleNoPid: RunningRecordFile | null = null;

  for (const r of records) {
    const live = await classifyLivenessAsync(r.record, {
      isProcessAlive,
      isProcessTreeAlive,
    });
    if (live.state === 'active' || (live.state === 'stale' && r.hasPid)) {
      return {
        decision: 'blocked',
        reason:
          `切片 "${sliceId}" 已经有一个 agent 在运行（${live.reason}）—— ` +
          `拒绝再起一个（两个 agent 会抢同一个 worktree）。` +
          `先确认它是否真的还活着：zelto status`,
      };
    }
    if (live.state === 'stale' && !r.hasPid) {
      staleNoPid ??= r;
    }
  }

  // 放行：把「无 pid 可查」的残留记录收尾 —— 只改状态字段，不删文件
  // （空输出 / 空 exitCode 的现场本身就是证据，C4）。
  if (staleNoPid) {
    closeRunningRecord(
      staleNoPid,
      `zelto run：上一轮记录没有 pid 可查、已无人在管（${staleNoPid.record.lastActivityAt ?? '无心跳'}）—— 起跑前收尾`,
    );
  }

  return { decision: 'pass', staleNoPid };
}

/**
 * 把一条残留记录收尾成 `failed`。
 *
 * **只改状态与时间戳 —— 不删文件**：空输出 / 空 exitCode 的现场本身就是
 * 「监视器被杀、没人收尾」的证据，删掉等于毁掉追溯（C4 的精神）。
 *
 * @returns 收尾成功返回 true；文件读不动/写不动返回 false
 */
export function closeRunningRecord(file: RunningRecordFile, reason: string): boolean {
  try {
    const current = JSON.parse(
      readFileSync(file.path, 'utf-8').replace(/^\uFEFF/, ''),
    ) as Record<string, unknown>;
    current.status = 'failed';
    current.completedAt = new Date().toISOString();
    current.reason = reason;
    writeFileSync(file.path, JSON.stringify(current, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}
