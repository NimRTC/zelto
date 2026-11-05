// Trace judgment — 追溯判据的单一真源
//
// 见 judgment.ts 的说明：判定语义只在这里定义一次，
// 门禁①、批量审核、规格校验都调它，不再各判各的。

export {
  judgeTrace,
  traceCountsOf,
  type TraceCounts,
  type TraceJudgment,
  type TraceJudgmentInput,
  type TraceViolation,
  type TraceViolationCode,
} from './judgment.js';
