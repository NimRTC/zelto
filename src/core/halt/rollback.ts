// 拉闸后的回退 —— 把被喊停的切片交回给人
//
// 为什么需要这一步：批次跑起来时，切片已经被 `RUN_START` 推进 `running`。
// 如果拉闸后什么都不做，切片会永远卡在 `running` ——
// 而准入只认 `frozen` / `completed`，于是这个切片再也跑不了，
// 只能 `abandon` 掉。人喊停是为了「处理完继续」，不是「丢弃」。
//
// 回退做两件事：
//   1. `running` → `frozen`（RUN_FINISH）：切片重新可跑
//   2. `stall.class = 'human_halt'`：让它出现在 `zelto stall` / `zelto next` 里
//      —— 人被交还控制权，就得看得见哪些切片等着他处理
//
// C1: 状态只落在文件里（切片文件 + 事件流）
// C3: 判定确定 —— 只看状态机与作用域，没有模型参与
// C4: 每个动作写 append-only 事件

import type { EventStream } from '../events/stream.js';
import type { SliceData, SliceStore } from '../slice/store.js';
import { isProcessAlive, type WriteReservation } from '../sched/reservation.js';

export interface HaltRollbackOptions {
  /** 人写的原因（写进事件，给人自己看） */
  reason: string;
  /** 拉闸作用域（批次键 / 'all'） */
  scope?: string;
  /** 事件 actor */
  actor?: string;
}

export interface HaltRollbackResult {
  sliceId: string;
  /** 回退前的状态 */
  from: string;
  /** 回退后的状态 */
  to: string;
  /** 是否真的回退了（已经是 frozen/completed 的切片不动） */
  reverted: boolean;
}

/**
 * 把一个被拉闸打断的切片拉回「可重跑」状态。
 *
 * 幂等：已经是 `frozen` / `completed` 的切片不会被再次迁移，
 * 但仍然会被标记 `human_halt` —— 它确实是被这次拉闸波及的。
 */
export async function rollbackHaltedSlice(
  store: SliceStore,
  events: EventStream,
  sliceId: string,
  options: HaltRollbackOptions,
): Promise<HaltRollbackResult> {
  const actor = options.actor ?? 'human';

  let slice: SliceData;
  try {
    slice = await store.read(sliceId);
  } catch {
    return { sliceId, from: 'unknown', to: 'unknown', reverted: false };
  }

  const from = slice.state;
  let to = from;
  let reverted = false;

  // RUN_FINISH: running → frozen。只有 running 态能这么走。
  if (from === 'running') {
    try {
      await store.transit(sliceId, 'RUN_FINISH', actor);
      to = 'frozen';
      reverted = true;
    } catch {
      // 状态被别处改过（比如人手工改过）—— 不强改，只标记停机
    }
  }

  // 标记停机：让 `zelto stall` / `zelto next` 能看见它。
  // 已经完成的切片（completed）不标 —— 它没在等人处理。
  const current = await store.read(sliceId).catch(() => slice);
  if (current.state !== 'completed' && current.state !== 'abandoned') {
    current.stall.class = 'human_halt';
    current.stall.gateRetries = 0;
    await store.write(current);
  } else {
    to = current.state;
  }

  await events.append(sliceId, 'stall.classified', actor, {
    sliceId,
    class: 'human_halt',
    reason: options.reason,
    scope: options.scope ?? null,
    from,
    to,
    halted: true,
  });

  return { sliceId, from, to, reverted };
}

/**
 * 批量回退。逐片处理，单片失败不影响其它片。
 */
export async function rollbackHaltedSlices(
  store: SliceStore,
  events: EventStream,
  sliceIds: string[],
  options: HaltRollbackOptions,
): Promise<HaltRollbackResult[]> {
  const results: HaltRollbackResult[] = [];
  for (const id of sliceIds) {
    try {
      results.push(await rollbackHaltedSlice(store, events, id, options));
    } catch {
      // 单片回退失败不阻断其它片
    }
  }
  return results;
}

/**
 * 找出「卡在 running」的切片。
 *
 * 拉闸时正在跑的切片会被回退（running → frozen），但还有一种情况没人管：
 * 批次进程崩了 / 被 Ctrl-C 杀了 —— 切片永远卡在 `running`。
 * 准入只认 `frozen`，于是这个切片再也跑不了，只能手工 `abandon`。
 *
 * 判定标准（确定性，C3）：切片状态是 `running`，且
 *   - 它没有生效中的写集预约，或
 *   - 持有预约的进程已经死了。
 *
 * 反过来：批次还活着的时候预约由活着的进程持有 → 不算卡住，
 * 不能在这种状态下回退 —— 那会跟正在跑的批次抢切片。
 */
export async function findStuckRunningSlices(
  store: SliceStore,
  reservations: WriteReservation[],
): Promise<string[]> {
  const active = reservations.filter((r) => r.releasedAt === null);
  const ids = await store.list();
  const stuck: string[] = [];

  for (const id of ids) {
    let slice: SliceData;
    try {
      slice = await store.read(id);
    } catch {
      continue;
    }
    if (slice.state !== 'running') continue;

    const held = active.find((r) => r.sliceId === id);
    if (held && isProcessAlive(held.pid)) continue; // 批次还活着，不动

    stuck.push(id);
  }

  return stuck;
}
