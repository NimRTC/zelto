// Slice state machine — states and transitions
// See docs/zelto-技术架构.md §5.2

export type SliceState =
  | 'draft'
  | 'clarifying'
  | 'frozen'
  | 'running'
  | 'completed'
  | 'abandoned';

export type SliceEvent =
  | 'CLARIFY_START'
  | 'CLARIFY_CONVERGED'
  | 'FREEZE'
  | 'REFREEZE'
  | 'RUN_START'
  | 'RUN_FINISH'
  | 'GATE_PASS'
  | 'SIGN_APPROVE'
  | 'SIGN_REJECT'
  | 'ABANDON';

export const SLICE_TRANSITIONS: Record<SliceState, Partial<Record<SliceEvent, SliceState>>> = {
  draft: {
    CLARIFY_START: 'clarifying',
    FREEZE: 'frozen',
    ABANDON: 'abandoned',
  },
  clarifying: {
    CLARIFY_CONVERGED: 'draft',
    ABANDON: 'abandoned',
  },
  frozen: {
    RUN_START: 'running',
    GATE_PASS: 'completed',
    SIGN_APPROVE: 'completed',
    // 重新冻结：人改了规格（最常见是扩写集），确认后重新走一次冻结。
    // 回到 draft 而不是直接回 frozen —— 中间要重新过门禁①与追溯物化。
    REFREEZE: 'draft',
    ABANDON: 'abandoned',
  },
  running: {
    RUN_FINISH: 'frozen',
    ABANDON: 'abandoned',
  },
  completed: {
    SIGN_APPROVE: 'completed',
    SIGN_REJECT: 'abandoned',
    RUN_START: 'running',
    ABANDON: 'abandoned',
  },
  abandoned: {},
};

export function transitionSlice(current: SliceState, event: SliceEvent): SliceState {
  const next = SLICE_TRANSITIONS[current]?.[event];
  if (!next) {
    throw new Error(`Invalid transition: ${current} → ${event}`);
  }
  return next;
}

/**
 * 终态 —— 不会再回到工作流里的状态。
 *
 * 终态的切片不该再带停机分类（ADR-041 §3.3）：
 * 停机的语义是「这片现在卡住了，需要人介入」，
 * 而一片已经完成或已放弃的切片，「卡着」这个结论本身就是错的。
 */
export function isTerminalState(state: SliceState): boolean {
  return state === 'completed' || state === 'abandoned';
}
