// 追溯判据 —— 单一真源
//
// 「这个切片有没有可追溯的出处」这件事此前有三份实现，三份语义还不一样：
//   - core/spec/deterministic/validator.ts：只看需求，豁免可免
//   - src/cli/commands/core-slice.ts（zelto check）：需求/测试不可免，契约可免
//   - core/sched/batch.ts（批量审核）：需求/测试不可免，契约可免
// 同一个切片走三条路能得出三种结论——追溯链就是这样腐化的。
//
// 本模块是唯一的判定处：只读数字、纯计算、不调模型、不触网（C3）。
// 判定语义（三条追溯各自独立，豁免整体生效）：
//   1. 需求（requirements）不得为空——证明代码出处
//   2. 契约（contracts）不得为空——证明接口边界
//   3. 测试（tests）不得为空——证明可验证
// 豁免（traceWaiver）：非空理由字符串即整体豁免这三条，语义是
// 「本片不参与追溯」，所以必须写明理由（docs/zelto-项目目标.md §3.1）。
//
// 调用方只负责把 violation 翻译成自己的呈现形式（严重级别、退出码、文案），
// 不再各自判断「够不够追溯」。

/** 追溯三条的条数 */
export interface TraceCounts {
  requirements: number;
  contracts: number;
  tests: number;
}

/** 违反的追溯条目 */
export type TraceViolationCode = 'no_requirements' | 'no_contracts' | 'no_tests';

/** 一条追溯问题 */
export interface TraceViolation {
  /** 问题代码——门禁与审核共用同一套代码，便于对账 */
  code: TraceViolationCode;
  /** 中文说明（审核、门禁文案用） */
  message: string;
  /** 英文短句（CLI 逐行提示用） */
  short: string;
}

/** 判定输入 */
export interface TraceJudgmentInput {
  /** 三条追溯各有多少条 */
  trace: TraceCounts;
  /** 豁免理由；null / 空串 / 纯空白都视为「未豁免」 */
  waiver?: string | null;
}

/** 判定结论 */
export interface TraceJudgment {
  /** 是否已豁免（豁免理由有效） */
  waived: boolean;
  /** 豁免理由；未豁免为 null */
  waiverReason: string | null;
  /** 违反的追溯条目，按需求→契约→测试的固定顺序 */
  violations: TraceViolation[];
  /** 追溯是否合格：已豁免，或一条都没违反 */
  ok: boolean;
}

const VIOLATION_TEXT: Record<TraceViolationCode, { message: string; short: string }> = {
  no_requirements: {
    message: '追溯信息里没有需求引用，无法证明代码出处',
    short: 'No requirements traced',
  },
  no_contracts: {
    message: '追溯信息里没有契约引用，无法证明接口边界',
    short: 'No contracts traced',
  },
  no_tests: {
    message: '追溯信息里没有测试引用，无法验证',
    short: 'No tests traced',
  },
};

/**
 * 判定一个切片的追溯是否合格。
 *
 * 确定性纯函数：同输入必得同输出（C3）。
 *
 * @param input 追溯条数与豁免理由
 */
export function judgeTrace(input: TraceJudgmentInput): TraceJudgment {
  const rawWaiver = input.waiver ?? null;
  const waiverReason = rawWaiver !== null ? rawWaiver.trim() : '';

  if (waiverReason.length > 0) {
    return {
      waived: true,
      waiverReason,
      violations: [],
      ok: true,
    };
  }

  const violations: TraceViolation[] = [];
  const counts = input.trace;

  if (counts.requirements === 0) {
    violations.push({ code: 'no_requirements', ...VIOLATION_TEXT.no_requirements });
  }
  if (counts.contracts === 0) {
    violations.push({ code: 'no_contracts', ...VIOLATION_TEXT.no_contracts });
  }
  if (counts.tests === 0) {
    violations.push({ code: 'no_tests', ...VIOLATION_TEXT.no_tests });
  }

  return {
    waived: false,
    waiverReason: null,
    violations,
    ok: violations.length === 0,
  };
}

/**
 * 从切片数据取追溯条数——省得每个调用方各写一遍长度取值。
 */
export function traceCountsOf(trace: {
  requirements: string[];
  contracts: string[];
  tests: string[];
}): TraceCounts {
  return {
    requirements: trace.requirements.length,
    contracts: trace.contracts.length,
    tests: trace.tests.length,
  };
}
