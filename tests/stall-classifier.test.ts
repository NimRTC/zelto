import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyStall, isAutoResolvable } from '../src/core/stall/classifier.js';

describe('StallClassifier', () => {
  it('classifies permission prompt', () => {
    const c = classifyStall({ type: 'permission_ask', message: 'allow write?' });
    assert.equal(c, 'permission_prompt');
  });

  it('classifies context exhaustion', () => {
    const c = classifyStall({ type: 'max_turns', message: 'max turns reached' });
    assert.equal(c, 'context_exhaustion');
  });

  it('classifies budget exhausted', () => {
    const c = classifyStall({ type: 'budget_exhausted', message: 'budget limit' });
    assert.equal(c, 'budget_exhausted');
  });

  it('classifies cognitive stuck after 3 same failures', () => {
    const c = classifyStall({ type: 'test_failure', message: 'test fails', sameFailureCount: 3 });
    assert.equal(c, 'cognitive_stuck');
  });

  it('auto-resolvable classes', () => {
    assert.equal(isAutoResolvable('permission_prompt'), true);
    assert.equal(isAutoResolvable('environment_failure'), true);
    assert.equal(isAutoResolvable('context_exhaustion'), true);
    assert.equal(isAutoResolvable('cognitive_stuck'), false);
    assert.equal(isAutoResolvable('budget_exhausted'), false);
  });
});
