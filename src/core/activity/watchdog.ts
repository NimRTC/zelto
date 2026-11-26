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
// C1: 计数器只落在文件里（`.zelto/activity/recoveries/<slice>.jsonl`，只追加）
// C4: 每次恢复 / 上报都写 append-only 事件（切片事件流由调用方写；
//     计数自身也是一本 append-only 账 —— 不再 read-modify-write 整体覆写）

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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

/** 旧格式整体快照的路径（只读底账，不再写）。 */
function recoveryPath(projectRoot: string, sliceId: string): string {
  return join(projectRoot, RECOVERIES_DIR_REL, `${sliceId}.json`);
}

/** 追加式计数账本的路径（`<slice>.jsonl`，一行一个事件）。 */
function recoveryLogPath(projectRoot: string, sliceId: string): string {
  return join(projectRoot, RECOVERIES_DIR_REL, `${sliceId}.jsonl`);
}

// ── 并发铁律：计数只追加，不覆写 ────────────────────────────────────────────
//
// 以前这里是 read JSON → 改 → 整体覆写：无锁、非原子。两个人（或人的 CLI
// 与 web 进程）同时收同一片 stuck 切片，后写的那次会把先写的那次吃掉 ——
// 「自愈封顶 3 次」在并发下形同虚设，同一片可以被无限收走。
//
// 现在照 C4 的做法：每次恢复 / 上报**追加一行** JSON（`O_APPEND`，小行单次
// write 在内核层不交错），读取时折叠成 `RecoveryRecord`。计数永远不会丢。
//
// 旧格式（`<slice>.json` 整体快照）仍然读，作为**底账**垫在折叠之前 ——
// 升级前已经记过的次数不能因为换格式就清零。

interface RecoveryLogEntry {
  /** 事件发生时间（ISO） */
  at: string;
  /** 这次发生了什么 */
  event: 'recover' | 'escalate';
  /** 假死原因（recover 时有） */
  reason?: string;
}

function emptyRecord(sliceId: string): RecoveryRecord {
  return { sliceId, count: 0, lastRecoveredAt: null, lastReason: null, escalated: false };
}

/** 读旧格式整体快照（升级前的底账）；没有或坏掉就当没记过。 */
function readLegacyRecord(projectRoot: string, sliceId: string): RecoveryRecord {
  const path = recoveryPath(projectRoot, sliceId);
  if (!existsSync(path)) return emptyRecord(sliceId);
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
    return emptyRecord(sliceId);
  }
}

/** 读一篇的恢复计数；没有记过就是 0 次。旧快照与追加账本一起折叠。 */
export function readRecoveries(projectRoot: string, sliceId: string): RecoveryRecord {
  const record = readLegacyRecord(projectRoot, sliceId);

  const logPath = recoveryLogPath(projectRoot, sliceId);
  if (!existsSync(logPath)) return record;

  let raw: string;
  try {
    raw = readFileSync(logPath, 'utf-8');
  } catch {
    return record;
  }

  // append-only：末尾可能有一次被截断的半行（进程在 write 中途被杀），
  // 跳过解析不了的行，不让一行坏账把整本账弄丢。
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let entry: Partial<RecoveryLogEntry>;
    try {
      entry = JSON.parse(trimmed) as Partial<RecoveryLogEntry>;
    } catch {
      continue;
    }
    if (entry.event === 'recover') {
      record.count += 1;
      if (typeof entry.at === 'string') record.lastRecoveredAt = entry.at;
      if (typeof entry.reason === 'string') record.lastReason = entry.reason;
    } else if (entry.event === 'escalate') {
      record.escalated = true;
      // 底账里的 escalated 不代表「这次仍然上报中」：这里以最新折叠为准，
      // 上报标记是单调的（一旦发生过就一直是 true），够了。
    }
  }
  return record;
}

/** 追加一行到这篇切片的计数账本（只追加、不改不删 —— C4）。 */
function appendRecoveryLog(projectRoot: string, sliceId: string, entry: RecoveryLogEntry): void {
  const dir = join(projectRoot, RECOVERIES_DIR_REL);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const line = `${JSON.stringify(entry)}\n`;
  // O_APPEND：每行一次 write，内核保证追加位置，不会与并发写交错。
  appendFileSync(recoveryLogPath(projectRoot, sliceId), line, 'utf-8');
}

/** 记一次自动恢复（次数 +1）。 */
export function recordRecovery(
  projectRoot: string,
  sliceId: string,
  reason: string,
): RecoveryRecord {
  const at = new Date().toISOString();
  appendRecoveryLog(projectRoot, sliceId, { at, event: 'recover', reason });
  return readRecoveries(projectRoot, sliceId);
}

/** 记一次上报（不再重复刷屏，但计数保留 —— 人处理完重跑时看得见历史）。 */
export function recordEscalation(projectRoot: string, sliceId: string): RecoveryRecord {
  const at = new Date().toISOString();
  appendRecoveryLog(projectRoot, sliceId, { at, event: 'escalate' });
  return readRecoveries(projectRoot, sliceId);
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
