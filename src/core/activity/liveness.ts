// 活性（liveness）—— 「这个 agent 到底还活着吗」的判定与心跳记录
//
// 病灶（D-30，实测于 nimrtc 演练）：
//
//   `zelto run --detach` 之后，CLI 主进程退出 → 后台监视器（同进程的一个
//   未 await 的 Promise）跟着被 `process.exit()` 杀掉 →
//   - agent 子进程可能还活着（还在改文件、还在烧 token）
//   - 但**没人再等它**（waitForExit 的 Promise 永远不 resolve）
//   - 也**没人再更新任务文件**（status 永远是 `running`）
//
//   于是人看到的是「切片在跑」，实际是**一个永远 running 的空壳**。
//   这比直接报错更危险：它让人以为 agent 还在干活，而现场其实已经没人管了。
//
// 本模块提供三件事（全部确定性、纯读文件 —— C3）：
//
//   1. **心跳**：运行中的会话每隔一段时间把自己的「最后活动时间」写进
//      会话文件 / 任务文件 —— 人和工具都能看出「它多久没动了」。
//   2. **假死判定**：多久没动静 + 进程还在不在 → `active` / `stale` / `dead`。
//   3. **恢复与上报**：假死后能不能自己救；救不回来就如实上报，
//      不再假装「还在跑」。
//
// C1: 状态只落在文件里（会话文件 / 任务文件 / 事件流）
// C4: 判停、恢复、上报都写 append-only 事件

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 心跳的默认间隔（毫秒）。 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * 「多久没动静算假死」的默认阈值（毫秒）。
 *
 * 取 3 分钟的理由：agent 跑一道中型构建 + 跑测试，可能几分钟不出一个字。
 * 但**完全没有任何动静**（没有 stdout、没有 hook 判定、文件也没变）
 * 超过 3 分钟，就该去看一眼了 —— 再等下去只是让人对着假界面干等。
 *
 * 这是「值得怀疑」的阈值，不是「宣判死刑」的阈值 —— 真正的处置见
 * `classifyLiveness`：先确认进程还在不在，再决定是判停还是等。
 */
export const DEFAULT_STALE_THRESHOLD_MS = 180_000;

/** 一次运行的生命周期状态。 */
export type LivenessState =
  /** 活着，而且最近有活动 */
  | 'active'
  /** 进程还在，但很久没动静了 —— 可疑，需要盯 */
  | 'stale'
  /** 进程没了 —— 确定死了 */
  | 'dead'
  /** 没有在跑（已完成 / 失败 / 已被判停） */
  | 'finished';

export interface LivenessInfo {
  state: LivenessState;
  /** 最后活动时间（ISO）；没有则 null */
  lastActivityAt: string | null;
  /** 距今多久没动静（毫秒）；没有则 null */
  idleMs: number | null;
  /** 跑这条任务的进程 pid；没有则 null */
  pid: number | null;
  /** 人能直接看懂的一句话说明 */
  reason: string;
}

/**
 * 会话文件 / 任务文件里都有的那几个「活性字段」。
 *
 * 之所以抽成接口而不是各写各的：会话文件（adapters/claude-agent）与任务文件
 * （cli/commands/core-slice）都要记心跳、都要被判定活性。
 * 两边的字段名一旦漂移，判定就会在一边读到 undefined —— 而 undefined
 * 会被当成「没有心跳」= 假死，把活着的 agent 误判成死的。
 */
export interface LivenessRecord {
  status?: string;
  startedAt?: string;
  /** 一片切片可能有多份会话/任务文件 —— 靠它把记录对回切片 */
  sliceId?: string;
  /** 最后活动时间 —— 心跳写这里 */
  lastActivityAt?: string;
  /** 最后一条 agent 输出的时间 —— 没有输出时靠心跳兜底 */
  lastOutputAt?: string;
  /** 跑这条任务的进程 pid */
  pid?: number;
  /**
   * agent 的累计输出（会话文件里保存的是分块字符串数组；任务文件可能没有）。
   *
   * 驾驶舱要靠它回答「它现在在干什么」——「最后活动时间」只能说明
   * 「还没死」，说明不了「在推进」。只读最后一个非空行即可（见
   * `lastOutputLine`），不用把整段输出搬给界面。
   */
  output?: string[];
}

/**
 * 算出一条记录的活性。
 *
 * 判据（全部来自文件，纯计算 —— C3）：
 *   1. 状态不是 running → `finished`（已经结束了，没什么活性可言）
 *   2. pid 没了（且不是本进程） → `dead`（**确定**死了，不需要猜）
 *   3. 距最后活动超过阈值 → `stale`（还活着但没动静 —— 可疑）
 *   4. 否则 → `active`
 *
 * @param record 会话/任务文件读出来的记录
 * @param now 当前时刻（默认现在）—— 传进来是为了可测
 * @param staleThresholdMs 假死阈值
 * @param isProcessAlive 进程存活判定（注入是为了可测，也为了 core 不依赖 adapters）
 */
export function classifyLiveness(
  record: LivenessRecord | null | undefined,
  options: {
    now?: number;
    staleThresholdMs?: number;
    isProcessAlive?: (pid: number) => boolean;
  } = {},
): LivenessInfo {
  const now = options.now ?? Date.now();
  const threshold = options.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;

  if (!record || (record.status !== undefined && record.status !== 'running')) {
    return {
      state: 'finished',
      lastActivityAt: null,
      idleMs: null,
      pid: null,
      reason: record ? `已结束（status=${record.status}）` : '没有运行记录',
    };
  }

  const pid = typeof record.pid === 'number' ? record.pid : null;
  const lastActivity = lastActivityOf(record);
  const idleMs = lastActivity === null ? null : Math.max(0, now - lastActivity);

  // pid 没了 = 确定死了。这是最硬的证据 —— 先于一切超时判断。
  if (pid !== null && options.isProcessAlive && !options.isProcessAlive(pid)) {
    return {
      state: 'dead',
      lastActivityAt: lastActivity === null ? null : new Date(lastActivity).toISOString(),
      idleMs,
      pid,
      reason: `进程 ${pid} 已经不在了`,
    };
  }

  if (idleMs === null) {
    // 没有任何活动时间记录。
    //
    // **没有 pid 的老文件不能当成「刚起跑」**（实测于 nimrtc 演练）：
    // 修复前写的会话/任务文件既没有 pid、也没有心跳字段，跑挂之后
    // 文件永远停在 status=running。按「刚起跑」处理，它就会永远 active ——
    // 界面上一个死了 19 小时的空壳看起来像刚开始干活。
    // 没有 pid 就无法确认它还活着，所以如实说「可疑」，交给显式清理。
    if (pid === null) {
      return {
        state: 'stale',
        lastActivityAt: null,
        idleMs: null,
        pid,
        reason: '没有任何心跳记录，也没有 pid 可查（老会话文件）—— 无法确认它还活着',
      };
    }
    return {
      state: 'active',
      lastActivityAt: null,
      idleMs: null,
      pid,
      reason: '刚起跑，还没有心跳记录',
    };
  }

  if (idleMs >= threshold) {
    return {
      state: 'stale',
      lastActivityAt: new Date(lastActivity!).toISOString(),
      idleMs,
      pid,
      reason: pid === null
        ? `已经 ${formatIdle(idleMs)} 没有任何动静（阈值 ${formatIdle(threshold)}，且没有 pid 可查）`
        : `已经 ${formatIdle(idleMs)} 没有任何动静（阈值 ${formatIdle(threshold)}）`,
    };
  }

  return {
    state: 'active',
    lastActivityAt: new Date(lastActivity!).toISOString(),
    idleMs,
    pid,
    reason: `${formatIdle(idleMs)} 前还有动静`,
  };
}

/**
 * 最后活动时间 —— 心跳优先，其次输出时间，最后启动时间。
 *
 * 顺序有讲究：**心跳是「进程还管着这件事」的证据**，输出只是副产品。
 * 一个 agent 可能长时间在跑构建（没有 stdout），但心跳照旧 ——
 * 所以心跳在时就不该因为「没输出」而判它假死。
 */
export function lastActivityOf(record: LivenessRecord | null | undefined): number | null {
  if (!record) return null;
  const candidates = [record.lastActivityAt, record.lastOutputAt, record.startedAt];
  for (const raw of candidates) {
    if (!raw) continue;
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/** 把毫秒说成人能一眼看懂的时长。 */
export function formatIdle(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分 ${sec % 60} 秒`;
  const hour = Math.floor(min / 60);
  return `${hour} 小时 ${min % 60} 分`;
}

/** 会话文件所在目录（相对项目根）。 */
export const SESSIONS_DIR_REL = join('.zelto', 'sessions');

/** 后台任务文件所在目录（相对项目根）。 */
export const TASKS_DIR_REL = join('.zelto', 'tasks');

/**
 * 从累计输出里取「最后一条有内容的行」—— 给人看「它现在在干什么」。
 *
 * 为什么取最后一行而不是整段：界面只有一行位置（进度条旁边）。
 * 整段搬过去既没人读，也不会随轮询更新得像样。
 *
 * 为什么要倒着找非空行而不是直接取最后一个元素：输出是**分块**追加的
 * （stdout 的 chunk 边界与行边界无关），最后一块常常只是半行或一个换行。
 * 取到换行就等于什么都没显示 —— 人会以为页面死了。
 */
export function lastOutputLine(record: LivenessRecord | null | undefined): string | null {
  const output = record?.output;
  if (!Array.isArray(output) || output.length === 0) return null;
  const text = output.join('');
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line) return line.length > 300 ? `${line.slice(0, 300)}…` : line;
  }
  return null;
}

/**
 * 读一个会话文件的活性记录。
 *
 * 读不到 / 坏掉 → 返回 null（调用方按「没有运行记录」处理，
 * 不假装它活着，也不假装它死得很确定）。
 */
export function readSessionLiveness(
  projectRoot: string,
  sessionId: string,
): LivenessRecord | null {
  return readLivenessFile(join(projectRoot, SESSIONS_DIR_REL, `${sessionId}.json`));
}

/** 读一个后台任务文件的活性记录。 */
export function readTaskLiveness(
  projectRoot: string,
  taskId: string,
): LivenessRecord | null {
  return readLivenessFile(join(projectRoot, TASKS_DIR_REL, `${taskId}.json`));
}

function readLivenessFile(path: string): LivenessRecord | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as LivenessRecord;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 找一片 running 切片当前的活性记录：会话文件优先，任务文件兜底。
 *
 * 为什么收进 core：CLI 的 `status` / `stall` 与 Web 的 `/api/slices` 都要查，
 * 三处各扫一遍目录，挑选规则迟早漂移（一处挑最新、一处挑第一个），
 * 于是同一时刻 CLI 说 active、Web 说 stale。挑选规则只有一份（C3）。
 *
 * 挑选规则：**同一来源里取 lastActivity 最新的那条**。
 * 一个切片可能多次 run/resume，留下好几份会话文件；老的那份早该死，
 * 但它不会自己消失 —— 不取最新就会一直拿尸体当现场。
 */
export function readSliceLivenessRecord(
  projectRoot: string,
  sliceId: string,
): LivenessRecord | null {
  const best = newestRunningRecord(join(projectRoot, SESSIONS_DIR_REL), sliceId);
  if (best) return best;
  return newestRunningRecord(join(projectRoot, TASKS_DIR_REL), sliceId);
}

function newestRunningRecord(dir: string, sliceId: string): LivenessRecord | null {
  if (!existsSync(dir)) return null;
  let best: LivenessRecord | null = null;
  let bestTs = -1;
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return null;
  }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const rec = readLivenessFile(join(dir, f));
    if (!rec || rec.status !== 'running') continue;
    const sid = rec.sliceId;
    if (sid !== sliceId) continue;
    const t = lastActivityOf(rec);
    const ts = t === null ? -1 : t;
    // 用 `>=` 而不是 `>`：完全没有时间戳的老空壳 ts 也是 -1，
    // 用 `>` 会让它跟初始值打平而被丢掉 —— 恰好丢掉最该被看见的那类。
    if (ts >= bestTs) {
      bestTs = ts;
      best = rec;
    }
  }
  return best;
}
