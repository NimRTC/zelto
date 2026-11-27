// 「眼下该做什么」的唯一口径 —— CLI 与 Web 驾驶舱共用
//
// 为什么要有这一份：
//
// 「该你做什么」在 zelto 里一度有**三套**判定：
//
// | 位置 | 口径 |
// |---|---|
// | `cli/commands/pending-actions.ts` | 待重跑 / 待签 / 待合 / 待发签 |
// | `cli/commands/dashboard.ts:computeActions` | 停机 / 版本级 / 待签 / 长跑 |
// | `cli/commands/info-help.ts:next` | 停机 / 草稿 / 待办 / 状态兜底 |
//
// 三套各写各的，同一件事（比如「哪片等着人签字」）三处结论可能不同 ——
// 人看到 A 说「等签字」、B 说「等合并」，不知道该信哪个。
// D-11 的老形状：**同一个结论两处产出**。
//
// 这一份把「有哪些待办、按什么顺序」定成**纯计算**（C3）：
// 事实由调用方收集（每个根各收自己的），判定与排序在这里收口。
//
// 优先级怎么定的（一条一条说清理由，不靠"感觉"）：
//
// | priority | 类别 | 理由 |
// |---|---|---|
// | 10 | 停机 | 人已被交还控制权 —— 那一刻最该看见的就是它 |
// | 20 | 规划草稿 | 上游没确认，下游跑了也白跑 |
// | 30 | 待重跑 | 人刚说过「要改」，还没改 —— 每多放一天多错一天 |
// | 40 | 待签字 | 已做完，只差人点一下 |
// | 45 | 待发起签字 | 门禁过了却连签字请求都没发起 —— 一道敞开的门 |
// | 50 | 待合并 | 已签字，等着进主干 |
// | 60 | 版本级 | 一版的片都做完了 → 交付/看状态 |
// | 85 | 自动恢复过 | 有自愈历史，值得瞄一眼 |
// | 90 | 状态兜底 | 还没开始的活（草稿/澄清/冻结/在跑） |
// | 95 | 长跑 | 跑很久了，可能卡住 |
//
// **正在顺利跑的东西不占注意力** —— 它在 90/95，只在没事可做时才浮上来。

/** 待办的类别。 */
export type PendingKind =
  | 'stalled'
  | 'draft'
  | 'rerun'
  | 'sign'
  | 'requestSign'
  | 'merge'
  | 'version'
  | 'autoResolved'
  | 'sliceState'
  | 'longRunning';

/** 一条待办 —— 切片/草稿 + 一句「现在该做什么」。 */
export interface PendingItem {
  /** 类别 */
  kind: PendingKind;
  /** 排序权重（越小越靠前） */
  priority: number;
  /** 主键：切片 id / 草稿 id / 版本 label */
  id: string;
  /** 人类可读标题 */
  title: string;
  /** 这一步在做什么（人话） */
  prepare: string;
  /** 该敲的命令 */
  action: string;
  /**
   * 紧接着的第二步（可选）。
   *
   * 例如规划草稿：先 `show` 看，看完再 `confirm`。
   * 两步写在一起才完整 —— 只给第一步，人看完还得自己想起来下一步。
   */
  then?: string;
  /** 为什么是这件事（补充说明） */
  reason: string;
  /**
   * 归属的根（Web 驾驶舱多根场景）。
   *
   * `scope` = `'root'`（仓库根）或 `'version'`（版本集成目录）；
   * `label` = 版本 label（仓库根为 null）。
   *
   * CLI 侧永远是仓库根 → 不填。
   */
  scope?: 'root' | 'version';
  label?: string | null;
}

/** 各类待办的原始事实（收集层产物，排序层输入）。 */
export interface PendingFacts {
  /** 停机切片 —— 人在被交还控制权的那一刻最该看见的 */
  stalled: PendingFact[];
  /** 规划草稿（require / design / plan 未确认） */
  drafts: PendingFact[];
  /** 被退回重跑 / 退回上游 —— 人说了「要改」但还没改 */
  rerun: PendingFact[];
  /** 等人签字 */
  sign: PendingFact[];
  /** 门禁过了却连签字请求都没发起 */
  requestSign: PendingFact[];
  /** 已签字但还没合进目标 */
  merge: PendingFact[];
  /** 版本级（整版做完了 → 交付；或这版有停机 → 看状态） */
  version: PendingFact[];
  /** 自动恢复过、还没人看过的片 */
  autoResolved: PendingFact[];
  /** 还没开始的活（按切片状态兜底） */
  sliceState: PendingFact[];
  /** 跑很久的片 */
  longRunning: PendingFact[];
}

/** 一条原始事实 —— 收集层给的最小信息。 */
export interface PendingFact {
  /** 主键（切片 id / 草稿 id / 版本 label） */
  id: string;
  /** 标题 */
  title: string;
  /** 该敲的命令 */
  action: string;
  /** 这一步在做什么（人话） */
  prepare: string;
  /** 紧接着的第二步（可选） */
  then?: string;
  /** 为什么是这件事 */
  reason?: string;
  /** 归属根（Web 多根场景） */
  scope?: 'root' | 'version';
  label?: string | null;
  /** 组内排序用的时间戳（越小越靠前） */
  at?: string;
}

/** 空事实集合 —— 收集失败时的兜底（不是「没有事要做」而是「不知道」）。 */
export function emptyPendingFacts(): PendingFacts {
  return {
    stalled: [],
    drafts: [],
    rerun: [],
    sign: [],
    requestSign: [],
    merge: [],
    version: [],
    autoResolved: [],
    sliceState: [],
    longRunning: [],
  };
}
