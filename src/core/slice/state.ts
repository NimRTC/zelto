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
    ABANDON: 'abandoned',
  },
  running: {
    RUN_FINISH: 'frozen',
    ABANDON: 'abandoned',
  },
  completed: {
    SIGN_REJECT: 'frozen',
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
