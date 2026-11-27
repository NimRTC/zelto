// 规划草稿推荐 —— G-6 日常交互密度
//
// `zelto next` / `zelto suggest` 以前只看切片，看不到规划层的待确认草稿：
// require / design / plan 的 draft 一直躺着，日常入口却只推切片动作。
//
// **收集搬进 core 了**（`core/pending/drafts.ts`）——
// 「眼下该做什么」的判定要跨 CLI 与 Web 驾驶舱共用，判据不能住在 CLI 层。
// 这里只留 CLI 侧的命令拼装。
//
// 只读：只 list，不改任何文件、不调模型、不触网。

export {
  collectPlanningDrafts,
  type PlanningDraft,
} from '../../core/pending/drafts.js';

import type { PlanningDraft } from '../../core/pending/drafts.js';

/** 下一步确认命令：先看决策点，再 confirm（G-5 同一入口） */
export function draftShowCommand(d: PlanningDraft): string {
  return `zelto ${d.kind} show ${d.id}`;
}

/** 看完之后确认的命令 */
export function draftConfirmCommand(d: PlanningDraft): string {
  return `zelto ${d.kind} confirm ${d.id}`;
}
