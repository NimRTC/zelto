// 主管心跳（ADR-129 三）—— 「主管半路死了」必须留下一条可查的事实
//
// ZD-049：detach 主管（supervisor.ts）原先只有**启动时**的存活确认，没有
// 运行期可见性。它半路退出时，写集审计 / 收尾 / 任务状态 / 预约释放
// **一个都没跑**，而没有任何地方能看见这件事 —— 任务文件、切片状态、
// 预约锁三处同时说「在跑」。
//
// 修法的**一半**在这里：主管每 30s 写一次心跳快照。
//
//   `.zelto/supervisor/<taskId>.heartbeat`
//   { pid, runId, agentPid, sessionId, at }
//
// 为什么是**整份覆盖**而不是 append-only：这是「主管现在长什么样」的状态快照，
// 不是账本。账本是事件流（C4）——「主管曾经写过心跳」这件事由主管的收尾事件证明。
// 心跳只是让人（`zelto status` / 看门狗）能回答「主管最后一次露面是什么时候」。
//
// 判定侧不读它来**下结论**（结论看事件流：`findRunConclusion`），
// 只用来在「主管不在、也没有收尾事件」时把现场拼完整 —— 例如
// 「最后露面时间距 agent 最后一次进展多久」。
//
// C1: 状态只落在文件里（`.zelto/` 下）
// C3: 本模块不判定，只写/读文件

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 心跳间隔（毫秒）。30s 是「够密到能看见半路死亡、够疏到不刷盘」的折中。 */
export const SUPERVISOR_HEARTBEAT_MS = 30_000;

export interface SupervisorHeartbeat {
  /** 主管自己的 pid */
  pid: number;
  /** 这一轮的 runId（ADR-129 一） */
  runId: string;
  /** 当前在跑的 agent 的 pid（拿得到就写；retry 时会变） */
  agentPid: number | null;
  /** 当前 agent 会话 id */
  sessionId: string | null;
  /** 写这份心跳的时刻（ISO） */
  at: string;
}

/** 心跳文件路径（相对项目根）。 */
export function supervisorHeartbeatPath(projectRoot: string, taskId: string): string {
  return join(projectRoot, '.zelto', 'supervisor', `${taskId}.heartbeat`);
}

/** 写一次心跳（整份覆盖；写失败静默 —— 心跳丢了只是少一份现场）。 */
export function writeSupervisorHeartbeat(
  projectRoot: string,
  taskId: string,
  beat: Omit<SupervisorHeartbeat, 'pid' | 'at'> & { pid?: number; at?: string },
): void {
  const path = supervisorHeartbeatPath(projectRoot, taskId);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const payload: SupervisorHeartbeat = {
      pid: beat.pid ?? process.pid,
      runId: beat.runId,
      agentPid: beat.agentPid ?? null,
      sessionId: beat.sessionId ?? null,
      at: beat.at ?? new Date().toISOString(),
    };
    writeFileSync(path, `${JSON.stringify(payload)}\n`, 'utf-8');
  } catch {
    /* 心跳落不了盘就算了 */
  }
}

/** 读心跳；没有 / 坏掉 → null（**不**当成「主管还活着」）。 */
export function readSupervisorHeartbeat(
  projectRoot: string,
  taskId: string,
): SupervisorHeartbeat | null {
  const path = supervisorHeartbeatPath(projectRoot, taskId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<SupervisorHeartbeat>;
    if (typeof parsed.pid !== 'number' || typeof parsed.runId !== 'string') return null;
    return {
      pid: parsed.pid,
      runId: parsed.runId,
      agentPid: typeof parsed.agentPid === 'number' ? parsed.agentPid : null,
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
      at: typeof parsed.at === 'string' ? parsed.at : '',
    };
  } catch {
    return null;
  }
}

/**
 * 启动一个**定时写心跳**的循环。
 *
 * @returns 停止函数（主管收尾 / 异常时一定要调 —— 否则定时器会把进程吊住，
 *          那是 ADR-125 修过的另一个毛病）
 */
export function startSupervisorHeartbeat(
  projectRoot: string,
  taskId: string,
  getBeat: () => { runId: string; agentPid: number | null; sessionId: string | null },
  intervalMs: number = SUPERVISOR_HEARTBEAT_MS,
): () => void {
  const beat = (): void => {
    try {
      writeSupervisorHeartbeat(projectRoot, taskId, getBeat());
    } catch {
      /* 读现场失败不影响心跳节奏 */
    }
  };
  beat();
  const timer = setInterval(beat, intervalMs);
  // 这个定时器不该阻止进程退出（ADR-125：收尾之后不许卡住）
  timer.unref?.();
  return () => clearInterval(timer);
}
