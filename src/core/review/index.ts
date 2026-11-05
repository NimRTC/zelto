// 草稿评审 —— 规划确认体验（G-5）
//
// 对外只暴露这几样：建评审、抽决策点、对齐决策点、修订快照、diff。

export {
  buildDraftReview,
  comparePoints,
  extractPoints,
} from './review.js';

export { diffOps, renderUnifiedDiff, summarizeOps, type DiffOp } from './diff.js';

export {
  designDecisionPoints,
  planDecisionPoints,
  requirementDecisionPoints,
} from './decision-points.js';

export { renderFacts } from './render.js';

export { RevisionStore, type RevisionMeta } from './revisions.js';

export type {
  DecisionPoint,
  DecisionPointKind,
  DecisionPointStatus,
  DesignFacts,
  DesignModuleFacts,
  DiffLine,
  DiffSummary,
  DraftFacts,
  DraftKind,
  DraftReview,
  PlanFacts,
  PlanSliceFacts,
  PlanVersionFacts,
  RequirementFacts,
} from './types.js';
