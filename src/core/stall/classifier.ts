// Stall classifier — 9 classes of stall
// See docs/zelto-场景功能地图.md §4.1
//
// 类型定义的真源在 `./types.ts`，这里只做分类计算。
// 以前 StallClass 定义在本文件而 StallInfo 在 types.ts，
// 两边互相 import对方的类型，形成类型依赖环；
// 环一旦形成，编译器的类型推断会在某些组合下退化成 any，
// 也让「哪个文件是类型的真源」变得说不清。
//
// 现在方向单一：types.ts ← classifier.ts。
//
// C3: 纯计算，不调模型、不触网
// C6: core/ 内，不依赖 adapters/

import type { StallClass, StallInfo } from './types.js';

export type {
  StallClass,
  StallEvent,
  StallInfo,
  StallResolution,
} from './types.js';

/**
 * Whether a stall class can be resolved without human input.
 *
 * `agent_question` is never auto-resolvable: by definition the agent stopped
 * because it cannot decide on its own (ADR-013 §3.5).
 *
 * `human_halt` is never auto-resolvable either: 人喊停要的就是「停下来等人」，
 * agent 自己把它重试起来就违背了拉闸的意图（ADR-020 §3.3）。
 */
export function isAutoResolvable(stallClass: StallClass): boolean {
  return stallClass === 'permission_prompt'
    || stallClass === 'environment_failure'
    || stallClass === 'context_exhaustion';
}

export function classifyStall(signal: {
  type: string;
  message: string;
  attempts?: number;
  sameFailureCount?: number;
}): StallClass {
  if (signal.type === 'agent_question') return 'agent_question';
  if (signal.type === 'permission_ask') return 'permission_prompt';
  if (signal.type === 'max_turns' || signal.type === 'context_limit') return 'context_exhaustion';
  if (signal.type === 'budget_exhausted') return 'budget_exhausted';
  if (signal.type === 'plan_approval_request') return 'plan_gate';
  if ((signal.attempts ?? 0) >= 2 || (signal.sameFailureCount ?? 0) >= 3) return 'cognitive_stuck';
  if (signal.type === 'build_failure' || signal.type === 'test_failure') return 'environment_failure';
  return 'cognitive_stuck';
}

/**
 * Check whether a slice is currently stalled.
 * A slice is stalled when its stall.class is not null.
 */
export function isSliceStalled(slice: { stall: StallInfo }): boolean {
  return slice.stall.class !== null;
}
