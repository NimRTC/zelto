// 看门狗 —— 假死的自动恢复与上报
//
// 在 `liveness.ts` 的判定之上做**处置**（全部确定性、纯读文件 —— C3）：
//
//   1. **自动恢复**：进程已经没了的 stuck 切片，退回 `frozen`（与 ADR-047 /
//      ADR-053 同一条退路：`running --RUN_FINISH--> frozen`），让人能重跑。
//   2. **上报**：同一个切片反复假死（超过阈值），不再默默恢复 ——
//      写事件、上报「需要人看」，UI 与 `zelto stall` 都要看得见。
//
// 为什么恢复次数要单独记文件：`stall.autoResolved` 是「自动重试预算」
// （ADR-052），语义是「agent 失败了几次」；这里记的是「看门狗救了几次」——
// 两件不同的事，混在一个计数器里会互相吃掉对方的预算。
//
// C1: 计数器只落在文件里（`.zelto/activity/recoveries/<slice>.json`)
// C4: 每次恢复 / 上报都写 append-only 事件（由调用方写，这里只做判定）

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LivenessInfo } from './liveness.js';

/** 同一切片最多自动恢复几次 —— 超过就上报，不再自己救。 */
export const MAX_AUTO_RECOVERIES = 3;

/** 恢复计数器的文件记录。 */
export interface RecoveryRecord {
  sliceId: string;
  /** 已经自动恢复过几次 */
  count: number;
  /** 上次恢复的时间（ISO） */
  lastRecoveredAt: string | null;
  /** 上次恢复时的假死原因（留给人看） */
  lastReason: string | null;
  /** 是否已经上报过（上报后不再重复刷屏） */
  escalated: boolean;
}

/** 看门狗对一片 stuck 切片的处置决定。 */
export type WatchdogDecision =
  /** 还能救：退回 frozen，让人重跑 */
  | { action: 'recover'; recoveries: number }
  /** 救太多次了：上报，让人来看现场 */
  | { action: 'escalate'; recoveries: number };

/**
 * 决定怎么处置一片 stuck 切片。
 *
 * 纯函数（可测）：输入当前计数，输出动作。
 */
export function decideRecovery(record: RecoveryRecord | null): WatchdogDecision {
  const count = record?.count ?? 0;
  if (count >= MAX_AUTO_RECOVERIES) {
    return { action: 'escalate', recoveries: count };
  }
  return { action: 'recover', recoveries: count };
}

/** 恢复计数器的目录（相对项目根）。 */
export const RECOVERIES_DIR_REL = join('.zelto', 'activity', 'recoveries');

function recoveryPath(projectRoot: string, sliceId: string): string {
  return join(projectRoot, RECOVERIES_DIR_REL, `${sliceId}.json`);
}

/** 读一片的恢复计数；没有记过就是 0 次。 */
export function readRecoveries(projectRoot: string, sliceId: string): RecoveryRecord {
  const path = recoveryPath(projectRoot, sliceId);
  if (!existsSync(path)) {
    return { sliceId, count: 0, lastRecoveredAt: null, lastReason: null, escalated: false };
  }
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as Partial<RecoveryRecord>;
    return {
      sliceId,
      count: typeof parsed.count === 'number' && parsed.count >= 0 ? Math.floor(parsed.count) : 0,
      lastRecoveredAt: typeof parsed.lastRecoveredAt === 'string' ? parsed.lastRecoveredAt : null,
      lastReason: typeof parsed.lastReason === 'string' ? parsed.lastReason : null,
      escalated: parsed.escalated === true,
    };
  } catch {
    return { sliceId, count: 0, lastRecoveredAt: null, lastReason: null, escalated: false };
  }
}

/** 记一次自动恢复（次数 +1）。 */
export function recordRecovery(
  projectRoot: string,
  sliceId: string,
  reason: string,
): RecoveryRecord {
  const prev = readRecoveries(projectRoot, sliceId);
  const next: RecoveryRecord = {
    sliceId,
    count: prev.count + 1,
    lastRecoveredAt: new Date().toISOString(),
    lastReason: reason,
    escalated: false,
  };
  writeRecoveryFile(projectRoot, sliceId, next);
  return next;
}

/** 记一次上报（不再重复刷屏，但计数保留 —— 人处理完重跑时看得见历史）。 */
export function recordEscalation(projectRoot: string, sliceId: string): RecoveryRecord {
  const prev = readRecoveries(projectRoot, sliceId);
  const next: RecoveryRecord = { ...prev, escalated: true };
  writeRecoveryFile(projectRoot, sliceId, next);
  return next;
}

function writeRecoveryFile(projectRoot: string, sliceId: string, record: RecoveryRecord): void {
  const dir = join(projectRoot, RECOVERIES_DIR_REL);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(recoveryPath(projectRoot, sliceId), JSON.stringify(record, null, 2), 'utf-8');
}

/**
 * 一片 stuck 切片的完整现场 —— 给 CLI / Web 展示用。
 */
export interface StuckSliceInfo {
  sliceId: string;
  title: string;
  liveness: LivenessInfo;
  recoveries: number;
  escalated: boolean;
  decision: WatchdogDecision['action'];
}
