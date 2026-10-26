// Tests for Spec Engine (deterministic validation + semantic analysis)

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateDeterministic } from '../src/core/spec/deterministic/validator.js';
import { analyzeSemantic } from '../src/core/spec/semantic/analyzer.js';
import type { SliceData } from '../src/core/slice/store.js';

function makeSlice(overrides: Partial<SliceData> = {}): SliceData {
  return {
    id: 'test-slice',
    title: 'Test Slice',
    state: 'draft',
    spec: { path: 'specs/slices/test.md', frozenHash: null, frozenAt: null },
    acceptance: { dir: '', frozenHash: null, oracleSrc: null },
    baseCommit: null,
    drift: { detected: false, reason: null, at: null },
    trace: { requirements: ['R1'], contracts: [], tests: [] },
    traceWaiver: null,
    writes: [],
    runs: [],
    stall: { class: null, autoResolved: 0, gateRetries: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const COMPLETE_SPEC = `# Test Slice

## Summary
This is a test spec.

## Motivation
We need to test the spec engine.

## Design
The design uses a simple approach.

## API / Interface Changes
No API changes.

## Data Model Changes
No data model changes.

## Migration Plan
No migration needed.

## Testing Strategy
Unit tests will cover all cases.

## Acceptance Criteria
- Test passes
- All assertions pass
`;

const MINIMAL_SPEC = `# Minimal

## Summary
Minimal spec.
`;

describe('Spec Engine — Deterministic Validation', () => {
  it('passes a valid spec with matching hash', () => {
    const slice = makeSlice({
      spec: { path: 'specs/slices/test.md', frozenHash: null, frozenAt: null },
    });
    const result = validateDeterministic(slice, COMPLETE_SPEC);
    // Should have no errors (warnings are OK)
    const errors = result.issues.filter((i) => i.severity === 'error');
    assert.equal(errors.length, 0);
  });

  it('detects hash mismatch', () => {
    const slice = makeSlice({
      spec: { path: 'specs/slices/test.md', frozenHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000', frozenAt: new Date().toISOString() },
    });
    const result = validateDeterministic(slice, COMPLETE_SPEC);
    const hashIssues = result.issues.filter((i) => i.category === 'hash');
    assert.equal(hashIssues.length, 1);
    assert.ok(hashIssues[0].message.includes('hash mismatch'));
  });

  it('reports missing required sections', () => {
    const slice = makeSlice();
    const result = validateDeterministic(slice, MINIMAL_SPEC);
    const structureIssues = result.issues.filter((i) => i.category === 'structure');
    assert.ok(structureIssues.length > 0);
  });

  it('reports empty acceptance criteria', () => {
    const specWithEmptyAC = `${COMPLETE_SPEC.split('## Acceptance Criteria')[0]}
## Acceptance Criteria

`;
    const slice = makeSlice();
    const result = validateDeterministic(slice, specWithEmptyAC);
    const contentIssues = result.issues.filter((i) => i.category === 'content');
    assert.ok(contentIssues.length > 0);
  });

  it('warns about missing trace requirements', () => {
    const slice = makeSlice({
      trace: { requirements: [], contracts: [], tests: [] },
    });
    const result = validateDeterministic(slice, COMPLETE_SPEC);
    const traceIssues = result.issues.filter((i) => i.category === 'trace');
    assert.ok(traceIssues.length > 0);
  });

  it('skips trace warning when traceWaiver is set', () => {
    const slice = makeSlice({
      trace: { requirements: [], contracts: [], tests: [] },
      traceWaiver: 'waived',
    });
    const result = validateDeterministic(slice, COMPLETE_SPEC);
    const traceIssues = result.issues.filter((i) => i.category === 'trace');
    assert.equal(traceIssues.length, 0);
  });

  it('reports missing spec path', () => {
    const slice = makeSlice({
      spec: { path: '', frozenHash: null, frozenAt: null },
    });
    const result = validateDeterministic(slice, COMPLETE_SPEC);
    const pathIssues = result.issues.filter((i) => i.category === 'structure' && i.message.includes('path'));
    assert.ok(pathIssues.length > 0);
  });

  it('classifies result as invalid when errors exist', () => {
    const slice = makeSlice({
      spec: { path: '', frozenHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000', frozenAt: new Date().toISOString() },
    });
    const result = validateDeterministic(slice, '');
    assert.equal(result.valid, false);
  });
});

describe('Spec Engine — Semantic Analysis', () => {
  it('counts sections in complete spec', () => {
    const slice = makeSlice();
    const analysis = analyzeSemantic(slice, COMPLETE_SPEC);
    assert.ok(analysis.totalSections >= 7, `should have many sections: ${analysis.totalSections}`);
  });

  it('flags placeholders', () => {
    const specWithTBD = COMPLETE_SPEC.replace('simple approach', 'TBD approach');
    const slice = makeSlice();
    const analysis = analyzeSemantic(slice, specWithTBD);
    const placeholderIssues = analysis.issues.filter((i) => i.category === 'semantic');
    assert.ok(placeholderIssues.length > 0);
  });

  it('reports high completeness for complete spec', () => {
    const slice = makeSlice();
    const analysis = analyzeSemantic(slice, COMPLETE_SPEC);
    assert.ok(analysis.completeness > 0, `completeness should be > 0: ${analysis.completeness}`);
    assert.ok(analysis.completeness >= 0.1, `completeness should be >= 0.1: ${analysis.completeness}`);
  });

  it('reports low completeness for minimal spec', () => {
    const slice = makeSlice();
    const analysis = analyzeSemantic(slice, MINIMAL_SPEC);
    assert.ok(analysis.completeness < 0.5, `completeness should be low: ${analysis.completeness}`);
  });

  it('reports slice ID in analysis', () => {
    const slice = makeSlice({ id: 'my-slice-id' });
    const analysis = analyzeSemantic(slice, COMPLETE_SPEC);
    assert.equal(analysis.sliceId, 'my-slice-id');
  });

  it('warns about missing design section', () => {
    const specNoDesign = `# No Design

## Summary
No design here.

## Testing Strategy
Just test it.
`;
    const slice = makeSlice();
    const analysis = analyzeSemantic(slice, specNoDesign);
    const consistencyIssues = analysis.issues.filter((i) => i.category === 'semantic');
    assert.ok(consistencyIssues.length > 0);
  });

  it('warns about brief testing strategy', () => {
    const specBriefTest = COMPLETE_SPEC.replace(
      'Unit tests will cover all cases.',
      'Test.',
    );
    const slice = makeSlice();
    const analysis = analyzeSemantic(slice, specBriefTest);
    const testIssues = analysis.issues.filter((i) => i.message.includes('Testing Strategy'));
    assert.ok(testIssues.length > 0);
  });
});
