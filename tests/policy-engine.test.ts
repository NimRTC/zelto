import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePolicy, matchPath, isProtectedPath, checkAnchor, hashPolicy } from '../src/core/policy/engine.js';
import type { PolicyConfig } from '../src/core/policy/types.js';

const sampleConfig: PolicyConfig = {
  rules: [
    {
      id: 'allow-src-ts',
      match: { path: 'src/**/*.ts', operation: 'write' },
      action: 'allow',
      basis: 'policy.yaml#allow-src-ts',
    },
    {
      id: 'allow-tests',
      match: { path: 'tests/**/*.ts', operation: 'write' },
      action: 'allow',
      basis: 'policy.yaml#allow-tests',
    },
    {
      id: 'deny-acceptance-direct',
      match: { path: 'tests/acceptance/**', operation: 'write' },
      action: 'deny',
      basis: 'AGENTS.md#禁区-5',
      guidance: 'Acceptance tests are frozen with the spec. Modify the spec instead.',
    },
  ],
  protected: [],
};

describe('PolicyEngine', () => {
  it('allows writing to src/', () => {
    const d = evaluatePolicy(sampleConfig, 'src/core/policy/engine.ts', 'write', 'v1');
    assert.equal(d.decision, 'allow');
  });

  it('denies writing to protected policy/', () => {
    const d = evaluatePolicy(sampleConfig, 'policy/policy.yaml', 'write', 'v1');
    assert.equal(d.decision, 'deny');
    assert.equal(d.ruleId, 'protected:0b');
  });

  it('denies writing to .zelto/', () => {
    const d = evaluatePolicy(sampleConfig, '.zelto/slices/011.json', 'write', 'v1');
    assert.equal(d.decision, 'deny');
  });

  it('denies path escape', () => {
    const d = evaluatePolicy(sampleConfig, '../outside/file.txt', 'write', 'v1');
    assert.equal(d.decision, 'deny');
    assert.equal(d.ruleId, 'protected:0a');
  });

  it('denies acceptance test modification', () => {
    const d = evaluatePolicy(sampleConfig, 'tests/acceptance/001/test.ts', 'write', 'v1');
    assert.equal(d.decision, 'deny');
    assert.equal(d.ruleId, 'deny-acceptance-direct');
  });

  it('denies by default for unknown paths', () => {
    const d = evaluatePolicy(sampleConfig, 'some/random/file.txt', 'write', 'v1');
    assert.equal(d.decision, 'deny');
  });

  it('protects AGENTS.md', () => {
    assert.equal(isProtectedPath('AGENTS.md'), true);
  });

  it('protects .cursor/rules/', () => {
    assert.equal(isProtectedPath('.cursor/rules/custom.mdc'), true);
  });
});

describe('matchPath', () => {
  it('matches single star', () => {
    assert.equal(matchPath('src/**/*.ts', 'src/core/policy/engine.ts'), true);
  });

  it('does not overmatch', () => {
    assert.equal(matchPath('src/**/*.ts', 'src/core/policy/engine.js'), false);
  });
});

describe('checkAnchor', () => {
  it('returns valid when hash matches', () => {
    const r = checkAnchor('abc123', 'abc123');
    assert.equal(r.valid, true);
    assert.equal(r.mismatch, false);
  });

  it('returns mismatch when hash differs', () => {
    const r = checkAnchor('abc123', 'def456');
    assert.equal(r.valid, false);
    assert.equal(r.mismatch, true);
  });

  it('returns mismatch when anchor is null', () => {
    const r = checkAnchor('abc123', null);
    assert.equal(r.valid, false);
    assert.equal(r.mismatch, true);
  });
});

describe('hashPolicy', () => {
  it('produces deterministic hash', () => {
    const content = 'rules: []';
    assert.equal(hashPolicy(content), hashPolicy(content));
  });
});
