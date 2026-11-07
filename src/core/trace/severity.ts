// 追溯严重级别 —— 判据层之上的一层「有多硬」
//
// ADR-025 把「什么算不合格」收敛到 `judgeTrace()`，但没定「不合格之后怎么办」：
// 是拒绝冻结、开跑，还是只提示一句。这层也是判定，所以同样要有唯一真源，
// 否则又会退化成「每个调用方各写一份判断」（ADR-025 §2.2 说的腐化机制）。
//
// 分级：
//   blocking（阻断）—— 需求追溯为空。没有出处，这段代码为什么存在就说不清，
//     追溯链从根上断了。这种情况不许冻结、不许开跑。
//   advisory（提示）—— 契约 / 测试追溯为空。这两条在很多切片上本就没有对应物
//     （本片不改接口、本片不新增测试），工具无法可靠判定，硬拦只会逼人写
//     假引用——假引用让追溯链「看起来完整而实际不是」，比缺失更有毒。
//     所以只提示，写进事件，不阻断。
//
// 豁免语义不变：`traceWaiver` 非空即整体豁免三条（ADR-025 §3.1）。
//
// C3: 静态表 + 纯计算，不调模型、不触网。

import type { TraceJudgment, TraceViolation, TraceViolationCode } from './judgment.js';

/** 追溯问题的严重级别 */
export type TraceSeverity = 'blocking' | 'advisory';

/**
 * 每条追溯违反项的严重级别。
 *
 * 顺序与 `judgeTrace()` 输出一致：需求 → 契约 → 测试。
 */
const SEVERITY_BY_CODE: Record<TraceViolationCode, TraceSeverity> = {
  no_requirements: 'blocking',
  no_contracts: 'advisory',
  no_tests: 'advisory',
};

/** 取某条违反项的严重级别 */
export function severityOf(code: TraceViolationCode): TraceSeverity {
  return SEVERITY_BY_CODE[code];
}

/** 按严重级别把违反项分成两组（各自保持原有顺序） */
export function splitBySeverity(violations: TraceViolation[]): {
  blocking: TraceViolation[];
  advisory: TraceViolation[];
} {
  return {
    blocking: violations.filter((v) => severityOf(v.code) === 'blocking'),
    advisory: violations.filter((v) => severityOf(v.code) === 'advisory'),
  };
}

/**
 * 追溯判定里会阻断动作的那些违反项。
 *
 * 调用方（冻结准入、调度准入、门禁①）只问「能不能动」，
 * 所以直接给这一组，不用自己再筛一遍。
 */
export function blockingViolations(judgment: TraceJudgment): TraceViolation[] {
  return splitBySeverity(judgment.violations).blocking;
}

/**
 * 追溯判定里只提示不阻断的那些违反项。
 */
export function advisoryViolations(judgment: TraceJudgment): TraceViolation[] {
  return splitBySeverity(judgment.violations).advisory;
}
