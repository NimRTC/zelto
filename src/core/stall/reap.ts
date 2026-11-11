// 死切片的批量清理（ADR-053）
//
// 「死切片」= 状态还停在 `running`，但 agent 早就挂了。
//
// 为什么它是一个独立的问题（ADR-047 已修掉一半）：
// ADR-047 让死切片**不再阻塞别人**（准入的写集冲突表排除带停机分类的切片），
// 但它们仍然占着 `zelto status` 的「running」计数，而且人得逐片
// `zelto resume` 才能把它们清掉。
//
// 为什么 `zelto halt --rollback` 扫不到它们：
// `--rollback` 的判据是「持有预约的进程已经死了」—— 那是**批次崩了**
// 的场景。死切片**没有预约**（agent 挂了，预约已释放），
// 所以它扫不到。这是两个不同的问题，不能混在一条命令里。
//
// 本模块的判据（确定性，C3）：**状态是 `running` 且带停机分类**。
// 纯读文件，不调模型、不触网。
//
// C1: 状态只落在文件里
// C4: 每个动作写 append-only 事件

import type { EventStream } from '../events/stream.js';
import type { SliceData, SliceStore } from '../slice/store.js';

/** 一片死切片的信息 */
export interface DeadSlice {
  sliceId: string;
  title: string;
  /** 停机分类（为什么它是死的） */
  stallClass: string;
  /** 上次运行的时间（如果有） */
  lastRunAt: string | null;
}

/** 清理结果 */
export interface ReapResult {
  sliceId: string;
  title: string;
  /** 回退前的状态 */
  from: string;
  /** 回退后的状态 */
  to: string;
  /** 是否真的回退了 */
  reverted: boolean;
  /** 回退前的停机分类 */
  stallClass: string;
}

/**
 * 找出死切片：状态是 `running` 且带停机分类。
 *
 * **例外：提问回路（`agent_question`）不算死切片。**
 * 那不是「跑挂了」—— agent 还活着，只是停下来等人数码，答完在原地续跑
 * （ADR-013）。把它算成死的，等于把一个还在等答复的会话判成尸体。
 *
 * @param slices 已读出的切片（由调用方给，避免重复读盘）
 */
export function findDeadSlices(slices: SliceData[]): DeadSlice[] {
  const dead: DeadSlice[] = [];
  for (const slice of slices) {
    if (slice.state !== 'running') continue;
    if (slice.stall.class === null) continue;
    // 提问回路的 agent 还活着 —— 不算死
    if (slice.stall.class === 'agent_question') continue;

    dead.push({
      sliceId: slice.id,
      title: slice.title,
      stallClass: slice.stall.class,
      lastRunAt: slice.runs.length > 0 ? slice.runs[slice.runs.length - 1].at : null,
    });
  }
  return dead;
}

/**
 * 把死切片退回 `frozen`（RUN_FINISH）。
 *
 * 与 ADR-047 的 `markSliceStalled` 是**同一条退路**：
 * `running --RUN_FINISH--> frozen`，语义是「这一轮跑完了，回到可以再跑的状态」。
 * 与 ADR-037 的越界回退也是同一条。
 *
 * **不清停机分类** —— 与 ADR-047 的 `resume()` 一致：
 * 清掉分类等于说「这片已经处理好了」，但这里只是把状态掰回可跑的样子，
 * 停机这件事本身仍然成立（人还没看过现场）。
 * 人看到「`running` 不再卡着」之后，仍然要用 `zelto resume` 走正式的恢复流程。
 *
 * @returns 退不成的切片不进结果（状态被别人改过就算了，不强改）
 */
export async function reapDeadSlices(
  store: SliceStore,
  events: EventStream,
  sliceIds: string[],
  options?: { actor?: string; reason?: string },
): Promise<ReapResult[]> {
  const actor = options?.actor ?? 'human';
  const reason = options?.reason ?? '清理死切片：agent 已停机，切片卡在 running';

  const results: ReapResult[] = [];

  for (const sliceId of sliceIds) {
    let slice: SliceData;
    try {
      slice = await store.read(sliceId);
    } catch {
      continue;
    }

    const stallClass = slice.stall.class;
    const from = slice.state;

    // 只处理「running + 带停机分类」—— 判据与 findDeadSlices 一致，
    // 避免把「正在跑」或「提问回路」的切片误伤。
    if (from !== 'running' || stallClass === null || stallClass === 'agent_question') {
      continue;
    }

    let to: string = from;
    let reverted = false;

    try {
      await store.transit(sliceId, 'RUN_FINISH', actor);
      to = 'frozen';
      reverted = true;
    } catch {
      // 状态被别处改过 —— 不强改。分类照写，事件照留。
    }

    await events.append(sliceId, 'slice.state.changed', actor, {
      sliceId,
      from,
      to,
      event: 'RUN_FINISH',
      reason,
      reaped: true,
      previousStallClass: stallClass,
    });

    results.push({ sliceId, title: slice.title, from, to, reverted, stallClass });
  }

  return results;
}
