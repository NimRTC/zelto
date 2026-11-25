// 「这片是基线切片还是开发切片」的判定 —— 与门禁无关的分类词汇
//
// 为什么需要这个判定：
//
//   基线切片（baseline slice）描述**现状**，不改代码；开发切片是**待办的活**。
//   两者都可能是 `completed`，混在一个计数里就会说谎：
//
//   实测（nimrtc-v14，2026-11-25）：`.zelto/slices/` 里 8 片 completed，
//   其中 3 片是 `v0-cmake` / `v0-src-log` / `v1-cmake` ——
//   接管既有项目时登记的**现状**，从来不是这轮要开发的活。
//   驾驶舱把它们算进「完成度」，人看到「8 个切片都完成了」，
//   实际这轮开发只做了 5 片。
//
// 关键性质：**这个判定必须可证伪，不能靠猜。**
//
// 三条判据，按优先级，先命中先用（`classifySliceKind`）：
//
//   1. `baseline === true`        —— 权威标记。`registerBaselineSlices`
//                                    生成基线切片时写死这个字段，
//                                    并落一条 `slice.baseline_registered` 事件。
//   2. `baseline` 字段**缺失** + 零事件 + `state === 'completed'`
//                                    —— 老版本手工建的基线切片。
//                                    工具的基线功能落地之前，人只能手写状态文件。
//   3. 其余                       —— 开发切片。
//
// ── 为什么第 2 条的三段条件缺一不可 ──────────────────────────────────────
//
// 只看「零事件」会误判：一片刚建、还没动的**开发**切片也是零事件。
// 只看「`baseline` 缺失」会误判：所有老切片文件都缺这个字段
// （`store.create` 才写 `baseline: false`，而那也是后来才加的）。
//
// 但三者合起来是**可证的**：一片开发切片要走完
// `draft → frozen → running → completed`，状态机每一步都对应一条
// 强制事件（`spec.frozen` / `run.started` / `gate.result` / `sign.approved`，
// C4：每个动作都写 append-only 事件流）。
// 所以「`completed` + 零事件」这件事本身**只可能**是「被人手工塞进来描述现状的」。
//
// ── 为什么不信「标题里有『基线』」 ───────────────────────────────────────
//
// 标题是人写的，可以是任何东西。用标题做判据 = 用命名约定代替事实。
// 判据必须落在**机器写下的**东西上（字段 + 事件）。
//
// C3: 纯判定，只读文件、不调模型、不触网
// C6: core/ 内，不依赖 adapters/

import type { EventEnvelope } from '../events/stream.js';

/** 切片分类的输入 —— 只要判据用得到的字段，不依赖完整的 SliceData。 */
export interface SliceKindInput {
  /** 切片 id */
  id: string;
  /** 当前状态 */
  state: string;
  /**
   * 基线标记 —— 可能是 `true` / `false` / `undefined`（老文件缺这个字段）。
   *
   * **`undefined` 不等于 `false`** —— 两者在这里语义不同：
   * `false` 是「明确不是基线」，`undefined` 是「这个文件写的时候还没这个字段」。
   */
  baseline?: boolean;
}

/** 切片分类结果。 */
export type SliceKind = 'baseline' | 'development';

/**
 * 这片是不是「基线切片」（描述现状、不改代码）。
 *
 * 只认 `baseline === true` —— 不认 `undefined`。
 * `undefined` 的情形由 {@link classifySliceKind} 走第二条判据处理
 * （那里需要事件流，单看切片文件判不出来）。
 */
export function isBaselineSlice(slice: { baseline?: boolean }): boolean {
  return slice.baseline === true;
}

/**
 * 这片是不是「从未产生过任何事件」。
 *
 * 为什么是「零事件」而不是「没有 `run.started`」：
 * 后者会把「跑过但事件流被清理过」的切片误判成基线。
 * 前者更保守 —— 只要**任何**动作发生过，就不是「手工塞进来的现状」。
 *
 * 读不到事件流（文件不存在）→ 视作零事件。
 * 事件流读取失败（解析异常等）→ **视作零事件**（fail closed 到「更保守」的一侧：
 * 把开发切片误判成基线，会让它不进完成度计数 —— 少算比多算安全）。
 */
export function hasNoEvents(events: EventEnvelope[] | null | undefined): boolean {
  if (!events) return true;
  return events.length === 0;
}

/**
 * 分类一片切片 —— 基线还是开发。
 *
 * @param slice 切片状态文件里的字段
 * @param events 这片的事件流（读不到就传 null / undefined）
 *
 * 返回 `baseline` 表示「这片描述现状、不改代码」，
 * 不该被算进「开发完成度」。
 */
export function classifySliceKind(
  slice: SliceKindInput,
  events?: EventEnvelope[] | null,
): SliceKind {
  // 判据 1：权威标记。
  if (isBaselineSlice(slice)) return 'baseline';

  // 判据 2：老版本手工建的基线切片。
  //
  // 三段条件缺一不可（见文件头）：
  //   - `baseline` 字段**缺失**（不是 `false`）—— 工具还没这功能时的老文件
  //   - 零事件 —— 从没被动过
  //   - `completed` —— 开发切片走完状态机必然留下事件
  if (
    slice.baseline === undefined &&
    slice.state === 'completed' &&
    hasNoEvents(events)
  ) {
    return 'baseline';
  }

  // 判据 3：开发切片。
  return 'development';
}

/**
 * 分类一片切片 —— 异步版，自己管「什么时候才值得去读事件流」。
 *
 * 为什么要有这个异步版：判据 2 需要事件流，而读事件流是**一次文件 I/O**。
 * 一片开发切片走完状态机必然有事件（判据 2 的三段条件里 `state === 'completed'`
 * 那段就是为此存在的），所以**只有**「`baseline` 字段缺失 + 状态是 `completed`」
 * 的切片才需要去读事件。
 *
 * 别的切片（`baseline === true` / `baseline === false` / 状态不是 completed）
 * 一律**不读事件** —— 判据 1 或判据 3 已经出结论了。
 *
 * 这不是性能优化，是**避免把 I/O 摊到每一次列表渲染上**：
 * 驾驶舱的概况页要列全部切片，每片多读一个文件就是几十次额外 I/O，
 * 而其中绝大多数根本不需要那个答案。
 *
 * @param slice 切片状态文件里的字段
 * @param loadEvents 读事件流的回调 —— **只在真需要时才被调用**
 */
export async function classifySliceKindAsync(
  slice: SliceKindInput,
  loadEvents: () => Promise<EventEnvelope[]>,
): Promise<SliceKind> {
  // 判据 1：权威标记 —— 不需要事件。
  if (isBaselineSlice(slice)) return 'baseline';

  // 只有这一种情形才需要事件流。
  if (slice.baseline === undefined && slice.state === 'completed') {
    const events = await loadEvents();
    if (hasNoEvents(events)) return 'baseline';
  }

  // 判据 3：开发切片。
  return 'development';
}
