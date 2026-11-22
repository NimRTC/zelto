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

  // ── ADR-094 §5.1：人类门的退回两档 ──────────────────────────────────

  it('SIGN_REVISE sends completed back to frozen (rework, not terminal)', () => {
    const s = transitionSlice('completed', 'SIGN_REVISE');
    assert.equal(s, 'frozen');
  });

  it('SIGN_RETURN sends completed back to draft (upstream — the spec must change)', () => {
    const s = transitionSlice('completed', 'SIGN_RETURN');
    assert.equal(s, 'draft');
  });

  it('SIGN_RETURN does not go to frozen — gate① must re-run', () => {
    // 直接回 frozen 会跳过门禁①，而规格改了之后门禁①必须重跑
    // （追溯要重新物化、写集要重新核覆盖）。ADR-094 D5。
    assert.notEqual(transitionSlice('completed', 'SIGN_RETURN'), 'frozen');
  });

  it('does not allow SIGN_REVISE from draft — only a completed slice can be sent back', () => {
    assert.throws(() => transitionSlice('draft', 'SIGN_REVISE'), /Invalid transition/);
    assert.throws(() => transitionSlice('frozen', 'SIGN_REVISE'), /Invalid transition/);
    assert.throws(() => transitionSlice('running', 'SIGN_REVISE'), /Invalid transition/);
  });

  it('does not allow SIGN_RETURN from draft either', () => {
    assert.throws(() => transitionSlice('draft', 'SIGN_RETURN'), /Invalid transition/);
    assert.throws(() => transitionSlice('frozen', 'SIGN_RETURN'), /Invalid transition/);
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
