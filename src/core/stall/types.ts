// Stall 相关的类型定义
//
// 类型全部集中在这里，`classifier.ts` 只做分类计算。
// 分开的原因是：以前 StallClass 定义在 classifier.ts，而 StallInfo
// 在 types.ts，两边互相 import 对方的类型，形成类型依赖环
// （core/stall/types.ts ↔ core/stall/classifier.ts）。
// 环一旦形成，编译器的类型推断会在某些组合下退化成 any，
// 也让「哪个文件是类型的真源」变得说不清。
//
// 现在类型只有这一个真源：types.ts。classifier.ts 反过来依赖它，
// 方向单一，不再成环。
//
// C3: 纯类型声明，不含运行期逻辑
// C6: core/ 内，不依赖 adapters/

/** 停机的 9 个分类 */
export type StallClass =
  | 'permission_prompt'   // ① 权限确认 — hook returned ask
  | 'environment_failure' // ② 环境失败 — build/test repeatedly fail
  | 'context_exhaustion'  // ③ 上下文耗尽 — max_turns reached
  | 'cognitive_stuck'     // ④ 认知卡壳 — same thing fails repeatedly
  | 'plan_gate'           // ⑤ 计划门禁 — agent requests plan approval
  | 'budget_exhausted'    // ⑥ 预算耗尽 — max budget reached
  | 'gate_retry'          // ⑦ 门禁重试 — gate executor retries exhausted
  | 'agent_question'      // ⑧ agent 提问 — 等待人回答（ADR-013）
  | 'human_halt';         // ⑨ 人工拉闸 — 人喊停，等人处理现场（ADR-020）

/** 停机的处置方式 */
export type StallResolution = 'auto_resolved' | 'needs_attention' | 'escalated';

/** 切片当前的停机状态 */
export interface StallInfo {
  class: StallClass | null;
  autoResolved: number;
  gateRetries: number;
}

/** 一次停机事件 */
export interface StallEvent {
  sliceId: string;
  runId: string;
  class: StallClass;
  resolution: StallResolution;
  summary: string;
  attempts?: number;
  details?: Record<string, unknown>;
}
