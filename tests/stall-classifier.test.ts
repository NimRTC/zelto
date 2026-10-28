import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyStall, isAutoResolvable, isSliceStalled } from '../src/core/stall/classifier.js';

describe('StallClassifier', () => {
  it('classifies permission prompt', () => {
    const c = classifyStall({ type: 'permission_ask', message: 'allow write?' });
    assert.equal(c, 'permission_prompt');
  });

  it('classifies context exhaustion via max_turns', () => {
    const c = classifyStall({ type: 'max_turns', message: 'max turns reached' });
    assert.equal(c, 'context_exhaustion');
  });

  it('classifies context exhaustion via context_limit', () => {
    const c = classifyStall({ type: 'context_limit', message: 'context window full' });
    assert.equal(c, 'context_exhaustion');
  });

  it('classifies budget exhausted', () => {
    const c = classifyStall({ type: 'budget_exhausted', message: 'budget limit' });
    assert.equal(c, 'budget_exhausted');
  });

  it('classifies plan gate', () => {
    const c = classifyStall({ type: 'plan_approval_request', message: 'request plan approval' });
    assert.equal(c, 'plan_gate');
  });

  it('classifies environment failure from build failure', () => {
    const c = classifyStall({ type: 'build_failure', message: 'build failed' });
    assert.equal(c, 'environment_failure');
  });

  it('classifies environment failure from test failure', () => {
    const c = classifyStall({ type: 'test_failure', message: 'tests failing' });
    assert.equal(c, 'environment_failure');
  });

  it('classifies cognitive stuck after 3 same failures', () => {
    const c = classifyStall({ type: 'test_failure', message: 'test fails', sameFailureCount: 3 });
    assert.equal(c, 'cognitive_stuck');
  });

  it('classifies cognitive stuck after 2+ attempts', () => {
    const c = classifyStall({ type: 'generic_error', message: 'keep failing', attempts: 2 });
    assert.equal(c, 'cognitive_stuck');
  });

  it('classifies unknown signal as cognitive_stuck', () => {
    const c = classifyStall({ type: 'unknown_signal', message: 'something weird' });
    assert.equal(c, 'cognitive_stuck');
  });

  it('auto-resolvable classes', () => {
    assert.equal(isAutoResolvable('permission_prompt'), true);
    assert.equal(isAutoResolvable('environment_failure'), true);
    assert.equal(isAutoResolvable('context_exhaustion'), true);
    assert.equal(isAutoResolvable('cognitive_stuck'), false);
    assert.equal(isAutoResolvable('budget_exhausted'), false);
    assert.equal(isAutoResolvable('plan_gate'), false);
    assert.equal(isAutoResolvable('gate_retry'), false);
  });
});

describe('isSliceStalled', () => {
  it('returns false when stall.class is null', () => {
    const slice = { stall: { class: null, autoResolved: 0, gateRetries: 0 } };
    assert.equal(isSliceStalled(slice as any), false);
  });

  it('returns true when stall.class is set', () => {
    const slice = { stall: { class: 'cognitive_stuck', autoResolved: 0, gateRetries: 0 } };
    assert.equal(isSliceStalled(slice as any), true);
  });

  it('returns true for any stall class', () => {
    for (const cls of ['permission_prompt', 'environment_failure', 'context_exhaustion', 'budget_exhausted', 'plan_gate', 'gate_retry']) {
      const slice = { stall: { class: cls, autoResolved: 0, gateRetries: 0 } };
      assert.equal(isSliceStalled(slice as any), true);
    }
  });
});
