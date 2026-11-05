// 草稿评审的类型 —— 规划确认体验（G-5）
//
// 「规划确认体验重」是 G-5：require / design / plan 每次吐一大坨 markdown，
// 人要通读才能 confirm，于是人会绕过 zelto 直接开写 —— 驾驶舱就废了。
//
// 解法是把「确认」拆成三样东西：
// - 摘要：一屏看完这一版是什么
// - diff：这一版相对上一版改了什么
// - 决策点：哪些地方需要人拍板（只看这些，不用通读全文）
//
// C3: 全部确定性计算，不调模型、不触网
// C7: llm/ 的产出只是草稿，这里只做「读草稿 + 排版」，不参与任何判定
// C6: core/ 内，不依赖 adapters/、不依赖 llm/

/** 草稿种类 */
export type DraftKind = 'requirement' | 'design' | 'plan';

/** 决策点的类别 */
export type DecisionPointKind =
  | 'acceptance'   // 验收标准
  | 'section'      // 规格章节
  | 'module'       // 模块
  | 'dependency'   // 模块依赖边
  | 'version'      // 版本
  | 'slice';       // 切片

/** 决策点相对上一版的状态 */
export type DecisionPointStatus = 'added' | 'removed' | 'changed' | 'unchanged';

/** 一个需要人拍板的点 */
export interface DecisionPoint {
  /** 稳定标识——同一份草稿里同一个点永远同一个 id，用来跨版本对齐 */
  id: string;
  kind: DecisionPointKind;
  /** 一行能读完的标题 */
  label: string;
  /** 支撑细节（可为空） */
  detail: string;
  status: DecisionPointStatus;
}

/** 差异的一行 */
export interface DiffLine {
  type: 'add' | 'remove' | 'context';
  text: string;
}

/** 差异统计 */
export interface DiffSummary {
  added: number;
  removed: number;
  changed: boolean;
}

/** 草稿评审结论——给人看的摘要，不含任何判定 */
export interface DraftReview {
  kind: DraftKind;
  id: string;
  title: string;
  status: string;
  /** 摘要条目——一屏能读完 */
  summary: string[];
  /** 决策点清单 */
  decisionPoints: DecisionPoint[];
  /** 相对上一版发生变化的决策点数量 */
  changedCount: number;
  /** 已保存的修订数 */
  revisionCount: number;
  /** 与上一版的差异；没有上一版则为 null */
  diff: DiffSummary | null;
}

// ─── 输入事实 ────────────────────────────────────────────────────────────────
//
// core/ 内部刻意只认「事实」而不认存储对象（与 core/sched/batch.ts 同款做法）：
// 判定与文件布局解耦，CLI 负责把 store 里的文档翻译成事实。

export interface RequirementFacts {
  title: string;
  userInput: string;
  spec: string;
  acceptanceCriteria: string[];
}

export interface DesignModuleFacts {
  name: string;
  description: string;
  filePatterns: string[];
  dependencies: string[];
}

export interface DesignFacts {
  title: string;
  body: string;
  modules: DesignModuleFacts[];
}

export interface PlanSliceFacts {
  id: string;
  title: string;
  module: string;
  writes: string[];
}

export interface PlanVersionFacts {
  version: string;
  description: string;
  dependsOn: string[];
  slices: PlanSliceFacts[];
}

export interface PlanFacts {
  title: string;
  versions: PlanVersionFacts[];
}

/** 草稿事实的联合类型 */
export type DraftFacts = RequirementFacts | DesignFacts | PlanFacts;
