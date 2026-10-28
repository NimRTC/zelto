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

  it('allows completed to RUN_START for re-execution', () => {
    const s = transitionSlice('completed', 'RUN_START');
    assert.equal(s, 'running');
  });

  it('allows SIGN_APPROVE from completed (re-approve)', () => {
    const s = transitionSlice('completed', 'SIGN_APPROVE');
    assert.equal(s, 'completed');
  });

  it('allows ABANDON from clarifying', () => {
    assert.equal(transitionSlice('clarifying', 'ABANDON'), 'abandoned');
  });

  it('allows ABANDON from frozen', () => {
    assert.equal(transitionSlice('frozen', 'ABANDON'), 'abandoned');
  });

  it('allows ABANDON from running', () => {
    assert.equal(transitionSlice('running', 'ABANDON'), 'abandoned');
  });

  it('allows ABANDON from completed', () => {
    assert.equal(transitionSlice('completed', 'ABANDON'), 'abandoned');
  });

  it('allows ABANDON from draft', () => {
    assert.equal(transitionSlice('draft', 'ABANDON'), 'abandoned');
  });

  it('abandoned state has no outgoing transitions', () => {
    const transitions = SLICE_TRANSITIONS['abandoned'];
    assert.equal(Object.keys(transitions).length, 0);
  });

  it('throws on any transition from abandoned', () => {
    assert.throws(() => transitionSlice('abandoned', 'FREEZE'), /Invalid transition/);
    assert.throws(() => transitionSlice('abandoned', 'RUN_START'), /Invalid transition/);
    assert.throws(() => transitionSlice('abandoned', 'CLARIFY_START'), /Invalid transition/);
  });
});
