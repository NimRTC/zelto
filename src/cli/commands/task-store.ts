// 后台任务文件（`.zelto/tasks/<taskId>.json`）—— 存取与心跳
//
// 为什么独立成文件（原先在 core-slice.ts 里）：
// `--detach` 的监视器搬到了**独立进程**（见 supervisor.ts，D-50）——
// 它也要读写同一份任务文件。两边各写一份存取逻辑必然漂移
// （一处写 `lastActivityAt`、一处不写，界面上就出现「有的任务有心跳、
// 有的没有」）。
//
// C1: 状态只落在文件里
// C4: 每个动作写 append-only 事件（事件由调用方写，这里只管文件）

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ZELTO_DIR } from './shared.js';
import { lastActivityOf, type LivenessRecord } from '../../core/activity/index.js';

export interface TaskInfo {
  taskId: string;
  sliceId: string;
  sessionId: string;
  agentName: string;
  startedAt: string;
  status: 'running' | 'completed' | 'failed' | 'timeout';
  completedAt?: string;
  exitCode?: number;
  elapsedSec?: number;
  /** 心跳 —— D-30：detach 任务也要能回答「多久没动了」。spawn 后从会话文件回填 pid。 */
  pid?: number;
  lastActivityAt?: string;
  lastOutputAt?: string;
  /**
   * 监督进程的 pid（D-50）。
   *
   * `--detach` 的监视器是一个**独立进程** —— 主进程退出后它还活着，
   * 负责等 agent 结束并写收尾。这个 pid 是「谁在管这一轮」的答案：
   * 它不在了 = 没人收尾 = 这一轮是空壳。
   */
  supervisorPid?: number;
  /** 监督进程日志路径（相对项目根）—— 出问题时人要看的那份现场 */
  supervisorLog?: string;
}

export function tasksDir(): string {
  return join(ZELTO_DIR, 'tasks');
}

export function taskPath(taskId: string): string {
  return join(tasksDir(), `${taskId}.json`);
}

export function saveTask(info: TaskInfo): void {
  if (!existsSync(tasksDir())) mkdirSync(tasksDir(), { recursive: true });
  writeFileSync(taskPath(info.taskId), JSON.stringify(info, null, 2), 'utf-8');
}

export function loadTask(taskId: string): TaskInfo | null {
  const p = taskPath(taskId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as TaskInfo;
  } catch {
    return null;
  }
}

/**
 * **补丁式**更新任务文件（D-53）。
 *
 * 为什么不能直接 `saveTask` 整份覆盖：
 *
 *   任务文件有**两个写者**：
 *     - 主进程（`zelto run --detach`）—— 写启动信息、supervisorPid；
 *     - 监督进程 —— 写会话 id、退出码、收尾状态。
 *
 *   两者的写入是**交错的**（实测：监督进程在 T+0.21s 写回 sessionId，
 *   主进程在 T+1.20s 做「启动存活确认」后 saveTask → 把 sessionId 冲掉）。
 * 整份覆盖 = 后写的赢 → 监督进程写的字段随机丢失。
 * 后果：界面上的「Session」永远是空的，人无法回答「这一轮是谁在跑」。
 *
 * 所以这里做**读-改-写**，且只覆盖 patch 里显式给了的字段：
 * 监督进程写的 sessionId 不会被主进程那一次的空占位冲掉。
 *
 * @returns 更新后的任务；文件不存在时返回 null（不凭空造一个）
 */
export function patchTask(taskId: string, patch: Partial<TaskInfo>): TaskInfo | null {
  const current = loadTask(taskId);
  if (!current) return null;
  const merged: TaskInfo = { ...current, ...patch };
  saveTask(merged);
  return merged;
}

/**
 * 把会话记录合并进任务记录（D-51）。
 *
 * **为什么必须带 `agentPid`：**
 *
 * 会话文件里有两个 pid：
 *   - `pid`      —— 包装进程（Windows 上是 `cmd.exe`），它负责转发信号；
 *   - `agentPid` —— 真正的 agent 进程（`node.exe` / `claude.exe`）。
 *
 * 包装进程在 agent 起来之后就退了（它不常驻）。所以「包装进程没了」
 * **不等于**「agent 死了」。
 *
 * 漏掉 `agentPid` 的后果（实测于 nimrtc-zelto v2-input-binder，2026-11-17）：
 * 活性判定退化成「看那个已经退了的 cmd.exe」→ 一个**活着的 agent**
 * 被判成 dead → 被 `stall --reap` 收走（切片退回 frozen）→
 * 而那个 agent 还在改文件 → 人重跑 → 同一个 worktree 上起第二个 agent
 * → 两个 agent 互相覆盖产出。
 *
 * 判据与 `core/activity/liveness.ts` 一致：`agentPid ?? pid`。
 */
export function mergeSessionLiveness(
  task: TaskInfo,
  session: LivenessRecord | null,
): LivenessRecord {
  const merged: LivenessRecord = {
    status: task.status,
    startedAt: task.startedAt,
    lastActivityAt: task.lastActivityAt,
    lastOutputAt: task.lastOutputAt,
    pid: task.pid,
  };
  if (!session) return merged;

  if (merged.pid === undefined && typeof session.pid === 'number') merged.pid = session.pid;
  // D-51：agentPid 必须一起搬过来 —— 它才是「agent 还活着吗」的答案
  if (typeof session.agentPid === 'number') merged.agentPid = session.agentPid;

  const taskLast = lastActivityOf(merged);
  const sessLast = lastActivityOf(session);
  if (sessLast !== null && (taskLast === null || sessLast > taskLast)) {
    merged.lastActivityAt = session.lastActivityAt ?? session.lastOutputAt ?? session.startedAt;
    merged.lastOutputAt = session.lastOutputAt;
  }
  if (!merged.startedAt && session.startedAt) merged.startedAt = session.startedAt;

  return merged;
}
