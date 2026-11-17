// 活进程看门狗（ADR-074）——「这一轮运行已经没有进程在管了」的判定
//
// 病灶（实测于 nimrtc-zelto，2026-11-17）：
//
//   停机判定只在 `waitForExit` 返回之后执行（ADR-047 / ADR-052）。
//   可 CLI 进程会先死 —— 实测四次 run 全部以「外层 cmd.exe 不在、
//   会话文件停在 running、切片停在 running、写集预约锁不释放」收场。
//   于是人看到的是一片**永远在跑的切片**，而准入在它上面永久挡着。
//   唯一的出路是 `zelto stall --reap` —— 需要人先想起来去收。
//
// 本模块的判据（确定性、纯函数 —— C3），输入只有：
//   1. 切片当前态（不是 running → 没有可收的）
//   2. 本轮的运行记录（会话文件 / 任务文件，按世代挑选 —— 见 §世代）
//   3. 本轮 `run.started` 的时刻（区分「本轮」与「上一代的尸体」）
//   4. 进程存活判定（注入 —— core 不碰进程表）
//
// 输出处置：`none`（不动作，附理由）/ `reap`（退 frozen）/ `escalate`（上报）
//
// ── 世代 ──────────────────────────────────────────────────────────────
// 一个切片被收走一次（reap → frozen），它的会话文件**还留在盘上**，
// 而且 status 仍是 `running` —— 进程死时没人能把 `failed` 写进去。
// 如果判据只看「最新的那份运行记录」，下一个 run 刚起跑就会把上一代的
// 尸体当成自己的现场，**秒收**。所以挑选规则是：
//   - 有 `runStartedAt`：只认 `startedAt >= runStartedAt` 的记录；
//     一份都没有 → none（本轮记录还没落盘，agent 可能还在 npx 解析阶段）
//   - 没有 `runStartedAt`（provider 不提供 / 老切片文件）：
//     退回到「最新一份」，但只信**硬证据**（`dead`：pid 没了）
//
// C1: 判定只读文件；C4: 处置由调用方写 append-only 事件
// C3: 不调模型、不触网、不读进程表（判活的副作用由注入的判定承担）

import type { LivenessInfo, LivenessRecord } from '../activity/liveness.js';
import type { WatchdogDecision } from '../activity/watchdog.js';

/**
 * 没有任何运行记录、也没有 run.started 时刻时，给 agent 的宽限（毫秒）。
 *
 * 2 分钟：`npx` 解析包 + 起 Claude Code + 读 CLAUDE.md 大约 10~30 秒，
 * 冷启动 + 代理网关首次握手可以到 1 分钟以上。比这短会把正常启动判成死；
 * 比这长，人就要多对着「在跑」的空壳等更久 —— 两边都是代价，取实测的中间值。
 */
export const SPAWN_GRACE_MS = 120_000;

/** 一次活进程看门狗的判定输入。 */
export interface RunWatchdogInput {
  sliceId: string;
  /** 切片当前状态（状态机里的 `state`） */
  sliceState: string;
  /** 切片是否已有停机分类（`agent_question` 不算 —— 那是有答案在等） */
  stallClass: string | null;
  /** 本轮 `run.started` 的时刻（ISO）；调用方不知道时传 null */
  runStartedAt: string | null;
  /** 本轮可用的运行记录（会话 / 任务文件），已按世代过滤前的候选 */
  records: LivenessRecord[];
  /** 看门狗已自愈次数（来自 activity/recoveries/<slice>.json） */
  recoveries: number;
  /** 当前时刻（毫秒，可注入以便测试） */
  now?: number;
  /** 进程存活判定（注入） */
  isProcessAlive?: (pid: number) => boolean;
  /** 假死阈值（毫秒） */
  staleThresholdMs?: number;
}

/**
 * 判定输出。
 *
 * `action` 与 ADR-074 的处置对应：
 *   - `none`：不动（附人能看懂的理由）
 *   - `reap`：退 frozen —— 「这一轮没有进程在管了」
 *   - `escalate`：看门狗已经救过太多次 —— 停机分类照写，但不再假装自动恢复
 */
export type RunWatchdogAction =
  | { action: 'none'; reason: string }
  | { action: 'reap'; reason: string; liveness: LivenessInfo; record: LivenessRecord | null }
  | { action: 'escalate'; reason: string; liveness: LivenessInfo; record: LivenessRecord | null };

/** 把 ISO 时刻解析成毫秒；坏值 → null。 */
function tsOf(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

function startedAtOf(record: LivenessRecord): number | null {
  return tsOf(record.startedAt);
}

/**
 * 按世代挑候选记录：只保留本轮起跑之后的。
 *
 * 一份也没有 → 返回 `'none-before-run'`（本轮记录还没落盘）。
 * 没有 runStartedAt → 返回全部（退回到「只看硬证据」的保守判法）。
 */
export function selectGenerationRecords(
  records: LivenessRecord[],
  runStartedAt: string | null,
): { records: LivenessRecord[]; generationKnown: boolean } {
  const startedMs = tsOf(runStartedAt);
  if (startedMs === null) {
    // 不知道本轮何时起跑：只信硬证据（dead），由调用方按 `generationKnown: false` 处理
    return { records, generationKnown: false };
  }
  // 1 秒容差：事件时刻与文件写入时刻来自两次 `new Date()`，可能差几毫秒
  const cutoff = startedMs - 1_000;
  return {
    records: records.filter((r) => {
      const t = startedAtOf(r);
      return t !== null && t >= cutoff;
    }),
    generationKnown: true,
  };
}

/**
 * 判定「这一轮运行是否已经没有进程在管了」。
 *
 * 判据顺序（先硬后软）：
 *   1. 不是 running，或已有停机分类 → none（已经被处理过 / agent_question 在等人）
 *   2. 按世代挑记录；本轮记录还没落盘 → 看 run.started 距现在是否超过宽限
 *   3. 本轮记录里最新那份：status 不是 running → none（它已经结束了，
 *      `waitForExit` 那一侧会走正常路径——停机在那里发生）
 *   4. status=running 但 pid 已死（硬证据）→ reap / escalate
 *   5. status=running、pid 还活着但早已无心跳（stale）→ none
 *      （stale 是「可疑」不是「死了」—— 构建可以跑几十分钟不出一个字，
 *       按 stale 收走会把正常的长任务杀掉。只有人显式 `--reap` 才动）
 */
export function decideRunWatchdog(input: RunWatchdogInput): RunWatchdogAction {
  const now = input.now ?? Date.now();

  if (input.sliceState !== 'running') {
    return { action: 'none', reason: `切片不在 running（${input.sliceState}），没有可收的运行` };
  }
  if (input.stallClass === 'agent_question') {
    return { action: 'none', reason: '提问回路：agent 停下来等人回答，不算停机' };
  }
  if (input.stallClass !== null) {
    return { action: 'none', reason: `已有停机分类（${input.stallClass}），等 zelto resume / run` };
  }

  const { records, generationKnown } = selectGenerationRecords(input.records, input.runStartedAt);

  if (records.length === 0) {
    if (!generationKnown) {
      return {
        action: 'none',
        reason: '没有运行记录，也没有 run.started 时刻 —— 无法判定本轮是否在跑',
      };
    }
    const startedMs = tsOf(input.runStartedAt);
    const ageMs = startedMs === null ? 0 : Math.max(0, now - startedMs);
    if (ageMs < SPAWN_GRACE_MS) {
      return {
        action: 'none',
        reason: `本轮起跑 ${Math.floor(ageMs / 1000)}s，运行记录还没落盘（宽限 ${Math.floor(SPAWN_GRACE_MS / 1000)}s）`,
      };
    }
    // 宽限期都过了还没有任何运行记录：监视者/agent 至少有一个没起来。
    // 这不是「可疑」，是「本轮从来没有真正开跑」—— 收走，让人重跑。
    //
    // 注意：「没有记录」不是硬证据（进程可能只是还没写盘），所以**不消耗**
    // 看门狗的自愈预算 —— 预算记的是「救了多少次尸体」，这里连尸体都没有。
    return {
      action: 'reap',
      reason: `本轮起跑 ${Math.floor(ageMs / 1000)}s 仍无任何运行记录 —— 这一轮从没真正开跑`,
      liveness: noRecordLiveness(),
      record: null,
    };
  }

  // 取本轮里最新的一份
  const latest = records.reduce((best, r) => {
    const tb = tsOf(best.startedAt) ?? -1;
    const tr = tsOf(r.startedAt) ?? -1;
    return tr >= tb ? r : best;
  });

  if (latest.status !== undefined && latest.status !== 'running') {
    return {
      action: 'none',
      reason: `本轮运行记录已收尾（status=${latest.status}），停机由正常路径处理`,
    };
  }

  const liveness = classifyRecord(latest, now, input);
  if (liveness.state === 'dead') {
    if (input.recoveries >= MAX_FOR_ESCALATE) {
      return {
        action: 'escalate',
        reason:
          `本轮进程已死（${liveness.reason}），看门狗已自动恢复 ${input.recoveries} 次 —— ` +
          '达上限，不再自动恢复，请人看现场',
        liveness,
        record: latest,
      };
    }
    return {
      action: 'reap',
      reason: `本轮进程已死（${liveness.reason}）—— 没有进程在管这一轮运行`,
      liveness,
      record: latest,
    };
  }

  return { action: 'none', reason: liveness.reason };
}

/** 看门狗自动恢复次数的上限（与 `MAX_AUTO_RECOVERIES` 一致，避免跨层 import 环）。 */
const MAX_FOR_ESCALATE = 3;

function noRecordLiveness(): LivenessInfo {
  return {
    state: 'dead',
    lastActivityAt: null,
    idleMs: null,
    pid: null,
    reason: '本轮没有任何运行记录',
  };
}

/**
 * 单条记录的活性判定 —— 与 `classifyLiveness` 同序：
 * 先看 pid（硬证据），再看到底有没有「活着」的证据。
 *
 * 为什么这里不直接调 `classifyLiveness`：它把「pid 没了」交给调用方注入的
 * `isProcessTreeAlive` 再确认一次（ADR-055）。看门狗这边只拿到同步的
 * `isProcessAlive`，拿不到进程表 —— 「pid 不在」就是它能拿到的全部证据，
 * 所以直接判 dead，理由写清是「pid 不在了」，不假装看过整棵树。
 */
function classifyRecord(
  record: LivenessRecord,
  now: number,
  input: RunWatchdogInput,
): LivenessInfo {
  const pid = typeof record.agentPid === 'number'
    ? record.agentPid
    : typeof record.pid === 'number'
      ? record.pid
      : null;
  const lastRaw = record.lastActivityAt ?? record.lastOutputAt ?? record.startedAt;
  const lastMs = tsOf(lastRaw);
  const idleMs = lastMs === null ? null : Math.max(0, now - lastMs);
  const lastActivityAt = lastMs === null ? null : new Date(lastMs).toISOString();

  if (pid !== null && input.isProcessAlive && !input.isProcessAlive(pid)) {
    return {
      state: 'dead',
      lastActivityAt,
      idleMs,
      pid,
      reason: `进程 ${pid} 已经不在了`,
    };
  }
  if (pid === null) {
    return {
      state: 'stale',
      lastActivityAt,
      idleMs,
      pid,
      reason: '运行记录没有 pid —— 无法确认它还活着',
    };
  }
  const threshold = input.staleThresholdMs ?? 180_000;
  if (idleMs !== null && idleMs >= threshold) {
    return {
      state: 'stale',
      lastActivityAt,
      idleMs,
      pid,
      reason: `进程 ${pid} 还在，但已经 ${Math.floor(idleMs / 1000)}s 没有心跳`,
    };
  }
  return {
    state: 'active',
    lastActivityAt,
    idleMs,
    pid,
    reason: `进程 ${pid} 还在（${input.sliceId}）`,
  };
}

/** 把判定转成「要不要上报 / 要不要恢复」的既有语义（activity/watchdog 的 `WatchdogDecision`）。 */
export function toWatchdogDecision(action: RunWatchdogAction): WatchdogDecision | null {
  if (action.action === 'reap') return { action: 'recover', recoveries: 0 };
  if (action.action === 'escalate') return { action: 'escalate', recoveries: MAX_FOR_ESCALATE };
  return null;
}
