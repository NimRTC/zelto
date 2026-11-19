// 生命周期编排的共享类型（ADR-086）
//
// 为什么要有这一层：ADR-086 要让 CLI 与 Web **调同一份编排**，
// 但两端**呈现方式不同**（CLI 打印彩色文本、Web 回 JSON）。
//
// 所以编排层返回**结构化结果**，不打印 ——
// 「判定」在 core，「渲染」在各自那一侧。
//
// C3: 判定必须确定性 —— 这里只读文件、纯计算 + 文件写，
// 不调模型、不触网。

/** 一个动作的结果 —— 成功与否、为什么、以及给人看的话。 */
export interface LifecycleOutcome {
  /** 这次动作成没成 */
  ok: boolean;
  /** 人话：为什么成了 / 为什么没成 */
  reason: string;
  /** 阻断项的逐条说明（空 = 无阻断） */
  details: string[];
  /** 提示项（不阻断，但人该知道） */
  advisories: string[];
  /** 结果里附带的事实（前端要显示的） */
  facts?: Record<string, unknown>;
}

/**
 * 编排动作的公共入参。
 *
 * 为什么要显式传 store / events / 依赖，而不是在 core 里 new：
 * core/ 的模块**只读文件**（C1），但**不绑定项目根目录** ——
 * 同一个 core 代码要能被 CLI（cwd = 项目根）和 Web（repoRoot = 参数）
 * 两种调用方使用。绑定在构造时，测试才能用临时目录跑。
 */
export interface LifecycleContext {
  /** 项目根目录 */
  repoRoot: string;
  /** 切片状态存储 */
  store: import('../slice/store.js').SliceStore;
  /** 事件流 */
  events: import('../events/stream.js').EventStream;
  /** 谁做的（'cli' / 'human'） */
  actor: string;
  /** 在哪儿做的（'cli' / 'web'）—— 与 actor 是两个维度（ADR-084 §4） */
  via: string;
}

/**
 * 把一个 outcome 造出来 —— 成功。
 *
 * 为什么有这个工厂函数：几十个 return 语句各写一遍对象字面量，
 * 迟早有一处漏字段 —— 而漏字段是**静默**的（TypeScript 会报，
 * 但 `details` 这种容易记错的字段名不会）。
 */
export function ok(
  reason: string,
  facts?: Record<string, unknown>,
  advisories: string[] = [],
): LifecycleOutcome {
  return { ok: true, reason, details: [], advisories, ...(facts ? { facts } : {}) };
}

/**
 * 把一个 outcome 造出来 —— 失败。
 *
 * `facts` 也要能带 —— 门禁失败时前端要显示「哪条命令失败了、错在哪」，
 * 所以「失败」不等于「没有事实」。
 */
export function fail(
  reason: string,
  details: string[] = [],
  advisories: string[] = [],
  facts?: Record<string, unknown>,
): LifecycleOutcome {
  return {
    ok: false,
    reason,
    details,
    advisories,
    ...(facts ? { facts } : {}),
  };
}
