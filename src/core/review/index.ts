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

// 人的审阅意见（ADR-094 §5.2）—— 与上面的「草稿评审」是两条路：
// 那一条评的是**草稿**（规划期），这一条送的是**人退回切片时提的意见**
//（执行期），由事件流读出、进 agent 的约束包。
export {
  readHumanFeedback,
  renderHumanFeedback,
  type HumanFeedback,
  type HumanFeedbackKind,
} from './human-feedback.js';

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
