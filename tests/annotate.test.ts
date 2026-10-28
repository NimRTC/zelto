// Tests for src/llm/annotate.ts — pure document analysis, no mocks needed
//
// Unlike other LLM generators, annotateSpec is deterministic and does not call
// any adapter — so tests are straightforward and need no mocking.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { annotateSpec } from '../src/llm/annotate.js';
import type { AnnotatableSpec, AnnotationContext, Annotation } from '../src/llm/annotate.js';

describe('annotateSpec — basic annotation', () => {
  it('produces an Annotation with correct sliceId', async () => {
    const spec: AnnotatableSpec = {
      id: 'v1-auth',
      title: 'Authentication module',
      writes: ['src/auth/**/*.ts', 'tests/auth/**/*.ts'],
    };

    const context: AnnotationContext = {
      sourceInstruction: 'req-0',
      contextFiles: ['docs/auth-design.md', 'src/core/ports/auth.ts'],
      invariantRefs: ['C1', 'C3', 'C5'],
    };

    const result = await annotateSpec(spec, context);

    assert.equal(result.sliceId, 'v1-auth');
    assert.equal(result.sourceInstruction, 'req-0');
    assert.deepEqual(result.contextFiles, ['docs/auth-design.md', 'src/core/ports/auth.ts']);
    assert.deepEqual(result.invariantRefs, ['C1', 'C3', 'C5']);
  });

  it('includes an ISO 8601 createdAt timestamp', async () => {
    const spec: AnnotatableSpec = {
      id: 'v1-core',
      title: 'Core feature',
      writes: ['src/core/**'],
    };

    const context: AnnotationContext = {
      sourceInstruction: 'req-1',
      contextFiles: [],
      invariantRefs: [],
    };

    const result = await annotateSpec(spec, context);

    assert.ok(result.createdAt, 'createdAt should be present');
    // ISO 8601 check: starts with a 4-digit year
    assert.match(result.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    // Should be within 5 seconds of now
    const now = Date.now();
    const created = new Date(result.createdAt).getTime();
    assert.ok(Math.abs(now - created) < 5000, 'createdAt should be recent');
  });
});

describe('annotateSpec — context immutability', () => {
  it('does not mutate the input context arrays', async () => {
    const spec: AnnotatableSpec = {
      id: 'v1-data',
      title: 'Data layer',
      writes: ['src/data/**'],
    };

    const contextFiles = ['docs/data.md', 'src/core/data.ts'];
    const invariantRefs = ['C6'];

    const context: AnnotationContext = {
      sourceInstruction: 'req-2',
      contextFiles,
      invariantRefs,
    };

    const result = await annotateSpec(spec, context);

    // Mutate the originals after the call
    contextFiles.push('should-not-appear.ts');
    invariantRefs.push('C99');

    // Result should still have the original values
    assert.equal(result.contextFiles.length, 2);
    assert.equal(result.invariantRefs.length, 1);
    assert.equal(result.contextFiles[0], 'docs/data.md');
    assert.equal(result.invariantRefs[0], 'C6');
  });
});

describe('annotateSpec — edge cases', () => {
  it('handles empty context files and invariant refs', async () => {
    const spec: AnnotatableSpec = {
      id: 'minimal',
      title: 'Minimal spec',
      writes: [],
    };

    const context: AnnotationContext = {
      sourceInstruction: 'req-3',
      contextFiles: [],
      invariantRefs: [],
    };

    const result = await annotateSpec(spec, context);

    assert.equal(result.sliceId, 'minimal');
    assert.deepEqual(result.contextFiles, []);
    assert.deepEqual(result.invariantRefs, []);
  });

  it('handles many context files and invariant refs', async () => {
    const spec: AnnotatableSpec = {
      id: 'large',
      title: 'Large spec with many references',
      writes: ['src/a.ts', 'src/b.ts'],
    };

    const contextFiles = Array.from({ length: 50 }, (_, i) => `docs/file-${i}.md`);
    const invariantRefs = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9'];

    const context: AnnotationContext = {
      sourceInstruction: 'req-4',
      contextFiles,
      invariantRefs,
    };

    const result = await annotateSpec(spec, context);

    assert.equal(result.contextFiles.length, 50);
    assert.equal(result.invariantRefs.length, 9);
    assert.equal(result.contextFiles[0], 'docs/file-0.md');
    assert.equal(result.contextFiles[49], 'docs/file-49.md');
  });

  it('preserves sliceId when spec.id is empty string', async () => {
    const spec: AnnotatableSpec = {
      id: '',
      title: 'Untitled',
      writes: [],
    };

    const context: AnnotationContext = {
      sourceInstruction: 'req-5',
      contextFiles: [],
      invariantRefs: [],
    };

    const result = await annotateSpec(spec, context);

    assert.equal(result.sliceId, '');
  });
});

describe('annotateSpec — types are exported', () => {
  it('Annotation type has all required fields', () => {
    // Compile-time check via a dummy value
    const ann: Annotation = {
      sliceId: 'test',
      sourceInstruction: 'req-0',
      contextFiles: ['a.ts'],
      invariantRefs: ['C1'],
      createdAt: '2025-01-01T00:00:00.000Z',
    };
    assert.equal(ann.sliceId, 'test');
    assert.equal(ann.sourceInstruction, 'req-0');
  });

  it('AnnotatableSpec type accepts valid values', () => {
    const s: AnnotatableSpec = { id: 'x', title: 'y', writes: ['z'] };
    assert.equal(s.id, 'x');
  });

  it('AnnotationContext type accepts valid values', () => {
    const ctx: AnnotationContext = {
      sourceInstruction: 'req-0',
      contextFiles: [],
      invariantRefs: [],
    };
    assert.equal(ctx.sourceInstruction, 'req-0');
  });
});
