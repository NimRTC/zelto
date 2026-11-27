// 切片状态相关的待办事实 —— CLI 与 Web 驾驶舱共用
//
// 三类事实都只依赖「切片状态文件 + 版本计划文件」：
//
// | 事实 | 判据 | 为什么是待办 |
// |---|---|---|
// | 版本级 | 一版的片全完成了 → 交付；这版有停机 → 看状态 | 整版的进度人看不到 |
// | 自动恢复过 | `stall.autoResolved > 0` 且没停机 | 已经自愈了，但**反复出问题**说明这片不稳 |
// | 长跑 | running 超过 10 分钟 | 可能卡住了 —— 只在没别的事时才浮上来 |
//
// 为什么搬进 core：以前这些判据写在 CLI 层，Web 驾驶舱看不到它们。
// 驾驶舱首屏说「一切正常」而 CLI 说「有三片该看一眼」——
// 两处各说各话（D-11 的老形状）。
//
// C3：只读文件，不调模型、不触网。

import { readVersionPlans } from '../version/branch.js';
import type { SliceData } from '../slice/store.js';
import type { PendingFact } from './types.js';

/** 长跑阈值（分钟）—— 与 `zelto dashboard` 一致。 */
export const LONG_RUNNING_MINUTES = 10;

/**
 * 版本级待办 —— 一版的片都做完了 → 该交付；这版有停机 → 该看状态。
 *
 * 判据来自版本计划文件（`.zelto/versions/*.json`）里的版本状态与成员切片。
 * **不自己重算「这版做完了没有」** —— 那是版本计划的语义，
 * 这里只把已经算好的状态翻译成一条待办。
 */
export async function collectVersionTodos(
  versionsDir: string,
  sliceStates: Map<string, string>,
): Promise<PendingFact[]> {
  const out: PendingFact[] = [];
  const plans = readVersionPlans(versionsDir);

  for (const plan of plans) {
    for (const version of plan.versions) {
      const total = version.slices.length;
      if (total === 0) continue;

      const done = version.slices.filter((s) => sliceStates.get(s.id) === 'completed').length;
      const stalled = version.slices.filter((s) => {
        const st = sliceStates.get(s.id);
        return st !== undefined && st !== 'completed' && st !== 'abandoned';
      }).length;

      if (done === total) {
        out.push({
          id: `${plan.id}/${version.version}`,
          title: `${version.version} · ${plan.title}`,
          prepare: '交付这一版',
          action: `zelto version deliver ${version.version}`,
          reason: `全部 ${total} 片已完成`,
        });
      } else if (stalled > 0) {
        out.push({
          id: `${plan.id}/${version.version}`,
          title: `${version.version} · ${plan.title}`,
          prepare: '看这一版的状态',
          action: `zelto version status ${version.version}`,
          reason: `${done}/${total} 完成，${stalled} 片还没做完`,
        });
      }
    }
  }
  return out;
}

/**
 * 自动恢复过的片 —— 有自愈历史，但没人看过。
 *
 * 它们不是异常（已经自愈了），但值得瞄一眼：自愈过多次说明
 * 这片**反复出问题**，只是暂时还活着。
 */
export function collectAutoResolved(slices: Iterable<SliceData>): PendingFact[] {
  const out: PendingFact[] = [];
  for (const slice of slices) {
    if (slice.stall.autoResolved <= 0) continue;
    if (slice.stall.class !== null) continue; // 已经停机 → 走「停机」那条
    out.push({
      id: slice.id,
      title: slice.title,
      prepare: '瞄一眼（自动恢复过）',
      action: 'zelto stall --auto-resolved',
      reason: `自动恢复 ${slice.stall.autoResolved} 次`,
      at: slice.updatedAt,
    });
  }
  return out;
}

/** 跑很久的片 —— 超过阈值就值得人瞄一眼。 */
export function collectLongRunning(
  slices: Iterable<SliceData>,
  now: number = Date.now(),
): PendingFact[] {
  const out: PendingFact[] = [];
  for (const slice of slices) {
    if (slice.state !== 'running') continue;
    if (!slice.updatedAt) continue;
    const elapsed = Math.floor((now - new Date(slice.updatedAt).getTime()) / 60000);
    if (elapsed <= LONG_RUNNING_MINUTES) continue;
    out.push({
      id: slice.id,
      title: slice.title,
      prepare: '看看还在不在跑',
      action: `zelto stall ${slice.id}`,
      reason: `已跑 ${elapsed} 分钟`,
      at: slice.updatedAt,
    });
  }
  return out;
}
