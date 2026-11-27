// 「眼下该做什么」的唯一口径 —— 对外出口
//
// 收集在 `collect.ts`，判定与排序在 `rank.ts`，git 事实在 `../git/facts.js`。
//
// C2：core/ 内，不依赖 adapters/。
// C3：只读文件与 git，不调模型、不触网。

export {
  emptyPendingFacts,
  type PendingFact,
  type PendingFacts,
  type PendingItem,
  type PendingKind,
} from './types.js';

export {
  PENDING_KIND_LABEL,
  PENDING_PRIORITY,
  PENDING_SECTION_TITLE,
  groupPending,
  rankPending,
  topPending,
} from './rank.js';

export {
  collectPendingFacts,
  latestSignRequestPerSlice,
  type PendingSource,
} from './collect.js';

export {
  collectPlanningDrafts,
  type PlanningDraft,
} from './drafts.js';

export {
  LONG_RUNNING_MINUTES,
  collectAutoResolved,
  collectLongRunning,
  collectVersionTodos,
} from './slice-state.js';

export {
  collectMergeCandidates,
  type MergeCandidate,
  type MergeCandidateSource,
  type MergeTarget,
} from './merge-candidates.js';
