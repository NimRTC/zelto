// Stall classifier — 6 classes of stall
// See docs/zelto-场景功能地图.md §4.1

import type { StallInfo } from './types.js';
export type { StallInfo };

export type StallClass =
  | 'permission_prompt'   // ① 权限确认 — hook returned ask
  | 'environment_failure' // ② 环境失败 — build/test repeatedly fail
  | 'context_exhaustion'  // ③ 上下文耗尽 — max_turns reached
  | 'cognitive_stuck'     // ④ 认知卡壳 — same thing fails repeatedly
  | 'plan_gate'           // ⑤ 计划门禁 — agent requests plan approval
  | 'budget_exhausted'   // ⑥ 预算耗尽 — max budget reached
  | 'gate_retry';        // ⑦ 门禁重试 — gate executor retries exhausted

export type StallResolution = 'auto_resolved' | 'needs_attention' | 'escalated';

export interface StallEvent {
  sliceId: string;
  runId: string;
  class: StallClass;
  resolution: StallResolution;
  summary: string;
  attempts?: number;
  details?: Record<string, unknown>;
}

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
