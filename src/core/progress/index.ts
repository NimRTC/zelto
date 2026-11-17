// 「做成了什么」—— 失败现场的可追溯性
//
// 见 `report.ts` 顶部的完整说明。
// 这里是模块出口。

export {
  parseCaseResults,
  countTodoCases,
  buildProgressReport,
  formatProgressLines,
  type CaseResult,
  type CaseStatus,
  type ProgressReport,
} from './report.js';

export {
  countAcceptanceCriteria,
  countAcceptanceTodos,
  runAcceptanceForProgress,
  listChangedFiles,
} from './collect.js';
