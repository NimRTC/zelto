import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { lintSpec, SpecLintSeverity } from '../../../src/core/spec/lint.js';
import type { SpecDocument } from '../../../src/core/spec/types.js';

describe('lintSpec', () => {
  it('returns passed: true with no issues for any spec (stub)', () => {
    const spec: SpecDocument = { id: 'test-slice', path: 'specs/test.md', title: 'Test' };
    const result = lintSpec(spec);

    assert.equal(result.passed, true);
    assert.deepStrictEqual(result.issues, []);
    assert.equal(result.specId, 'test-slice');
    assert.equal(result.specPath, 'specs/test.md');
    assert.ok(result.timestamp);
  });

  it('includes metadata about the stub implementation', () => {
    const spec: SpecDocument = { id: 's1' };
    const result = lintSpec(spec);

    assert.ok(result.metadata);
    assert.equal(result.metadata?.ruleCount, 0);
    assert.equal(result.metadata?.note, 'Stub implementation — no rules applied');
  });

  it('handles an empty spec document', () => {
    const spec: SpecDocument = {};
    const result = lintSpec(spec);

    assert.equal(result.passed, true);
    assert.equal(result.specId, '');
    assert.equal(result.specPath, '');
  });

  it('handles a spec with only an id', () => {
    const spec: SpecDocument = { id: 'slice-42' };
    const result = lintSpec(spec);

    assert.equal(result.passed, true);
    assert.equal(result.specId, 'slice-42');
  });

  it('returns a valid ISO timestamp', () => {
    const spec: SpecDocument = { id: 's1' };
    const result = lintSpec(spec);

    const parsed = new Date(result.timestamp);
    assert.ok(!Number.isNaN(parsed.getTime()));
  });

  it('SpecLintSeverity enum has expected values', () => {
    assert.equal(SpecLintSeverity.Error, 'error');
    assert.equal(SpecLintSeverity.Warning, 'warning');
    assert.equal(SpecLintSeverity.Info, 'info');
  });
});
