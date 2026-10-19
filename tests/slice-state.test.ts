import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { transitionSlice, SLICE_TRANSITIONS } from '../src/core/slice/state.js';

describe('SliceState', () => {
  it('starts in draft', () => {
    const s = transitionSlice('draft', 'CLARIFY_START');
    assert.equal(s, 'clarifying');
  });

  it('converges back to draft', () => {
    const s = transitionSlice('clarifying', 'CLARIFY_CONVERGED');
    assert.equal(s, 'draft');
  });

  it('freeze transitions to frozen', () => {
    const s = transitionSlice('draft', 'FREEZE');
    assert.equal(s, 'frozen');
  });

  it('throws on invalid transition', () => {
    assert.throws(() => transitionSlice('draft', 'RUN_START'), /Invalid transition/);
  });

  it('allows all valid transitions', () => {
    const cases: Array<[string, string, string]> = [
      ['draft', 'CLARIFY_START', 'clarifying'],
      ['clarifying', 'CLARIFY_CONVERGED', 'draft'],
      ['draft', 'FREEZE', 'frozen'],
      ['frozen', 'RUN_START', 'running'],
      ['frozen', 'GATE_PASS', 'completed'],
      ['frozen', 'SIGN_APPROVE', 'completed'],
      ['running', 'RUN_FINISH', 'frozen'],
      ['completed', 'SIGN_REJECT', 'abandoned'],
      ['frozen', 'ABANDON', 'abandoned'],
    ];
    for (const [from, event, expected] of cases) {
      assert.equal(transitionSlice(from as any, event as any), expected);
    }
  });
});
