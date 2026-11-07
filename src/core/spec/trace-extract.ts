// 从规格文本里提取追溯引用 —— 纯函数，不调模型、不触网（C3）
//
// 为什么需要它：追溯判据要求切片能指到「人批准的出处」（ADR-025 / ADR-032），
// 但人写规格时不会手写 `trace.requirements` 字段——他写的是规格正文里的
//「验收标准」。这两者的对应关系是确定的：验收标准的每一条就是本片的验收要求。
//
// `zelto create --from-spec` 早就在做同样的事（把「## 验收标准」下的编号条目
// 当作 requirements），这里把它抽成共享实现，让「物化追溯」只有一处逻辑。
//
// 注意边界：本模块只**读取**规格正文、只产出候选引用，不写文件、不改规格。
// 谁把它物化进切片、什么时候物化，由调用方决定（ADR-032 §3.3）。

import { extractSection, sectionByConcept } from './format.js';
import { blockingViolations, judgeTrace, traceCountsOf } from '../trace/index.js';
import type { TraceViolation } from '../trace/index.js';

/** 一条从规格里提取出来的验收要求 */
export interface ExtractedRequirement {
  /** 引用原文（验收标准的条目文本） */
  text: string;
  /** 指向规格里的位置（`specs/slices/x.md#验收标准` 形式，path 由调用方拼） */
  ref: string;
}

/**
 * 从规格正文里提取「验收标准」条目。
 *
 * 只认编号列表（`1. xxx`）——那是本仓库规格里唯一稳定的写法，
 * 也与 `zelto create --from-spec` 的既有解析保持一致。
 *
 * @param content 规格全文
 * @returns 条目列表（规格没有验收标准章节、或章节为空时返回空数组）
 */
export function extractAcceptanceCriteria(content: string): ExtractedRequirement[] {
  const section = sectionByConcept('Acceptance Criteria');
  if (!section) return [];

  const body = extractSection(content, section);
  if (!body) return [];

  const items: ExtractedRequirement[] = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*\d+\.\s+(.+?)\s*$/);
    if (!m) continue;
    const text = m[1].trim();
    if (!text) continue;
    items.push({ text, ref: text });
  }
  return items;
}

/**
 * 物化候选的需求追溯引用。
 *
 * 已经有了追溯就不动它——人显式声明过的优先于从规格里读出来的。
 *
 * @param existing 已有的需求引用
 * @param content 规格全文
 * @returns 物化后的需求引用列表
 */
export function materializeRequirements(existing: string[], content: string): string[] {
  if (existing.length > 0) return existing;
  return extractAcceptanceCriteria(content).map((i) => i.ref);
}

/** 冻结准入的追溯闸门结论 */
export interface FreezeTraceGate {
  /** 物化后的需求追溯（已有声明优先） */
  requirements: string[];
  /** 阻断项；空数组 = 可以冻结 */
  blocking: TraceViolation[];
}

/**
 * 判定一个切片能不能被冻结（追溯部分）。
 *
 * 纯函数：入参是切片事实与规格正文，出参是「物化后的需求追溯 + 阻断项」。
 * 调用方负责把物化结果写回切片、并在有阻断项时拒绝冻结。
 *
 * 规则（ADR-032 §3.1 / §3.3）：
 *   1. 需求追溯已声明 → 原样保留；没声明 → 从规格的「验收标准」物化；
 *   2. 物化后仍没有需求追溯 → 阻断（这段代码没有出处）；
 *   3. 基线切片（v0-）不适用追溯链 → 不阻断；
 *   4. 豁免理由非空 → 整体豁免，不阻断。
 */
export function evaluateFreezeTrace(
  slice: {
    trace: { requirements: string[]; contracts: string[]; tests: string[] };
    traceWaiver: string | null;
    baseline: boolean;
  },
  specContent: string,
): FreezeTraceGate {
  const requirements = materializeRequirements(slice.trace.requirements, specContent);

  if (slice.baseline) {
    return { requirements, blocking: [] };
  }

  const judgment = judgeTrace({
    trace: traceCountsOf({ ...slice.trace, requirements }),
    waiver: slice.traceWaiver,
  });

  return { requirements, blocking: blockingViolations(judgment) };
}
