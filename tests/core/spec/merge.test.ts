import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { getEffectiveSpec } from '../../../src/core/spec/merge.js';
import { SpecOverlayType } from '../../../src/core/spec/types.js';
import type { SpecDocument, SpecOverlay } from '../../../src/core/spec/types.js';

describe('getEffectiveSpec', () => {
  it('returns the base spec unchanged when there are no overlays', () => {
    const spec: SpecDocument = { id: 'test-slice', path: 'specs/test.md', title: 'Test' };
    const result = getEffectiveSpec(spec, []);

    assert.equal(result.specId, 'test-slice');
    assert.equal(result.specPath, 'specs/test.md');
    assert.deepStrictEqual(result.content, spec);
    assert.deepStrictEqual(result.appliedOverlays, []);
    assert.ok(result.timestamp);
  });

  it('applies a Replace overlay at a top-level path', () => {
    const spec: SpecDocument = { id: 's1', title: 'Original Title', status: 'draft' };
    const overlays: SpecOverlay[] = [
      { id: 'o1', type: SpecOverlayType.Replace, path: 'title', value: 'Updated Title', timestamp: '2026-01-01T00:00:00.000Z' },
    ];

    const result = getEffectiveSpec(spec, overlays);

    assert.equal(result.content.title, 'Updated Title');
    assert.equal(result.content.status, 'draft');
    assert.equal(result.appliedOverlays.length, 1);
  });

  it('applies a Replace overlay at a nested path', () => {
    const spec: SpecDocument = {
      id: 's1',
      metadata: { author: 'alice', version: 1 },
    };
    const overlays: SpecOverlay[] = [
      { id: 'o1', type: SpecOverlayType.Replace, path: 'metadata.author', value: 'bob', timestamp: '2026-01-01T00:00:00.000Z' },
    ];

    const result = getEffectiveSpec(spec, overlays);

    assert.equal((result.content.metadata as Record<string, unknown>).author, 'bob');
    assert.equal((result.content.metadata as Record<string, unknown>).version, 1);
  });

  it('applies a Merge overlay at a top-level path', () => {
    const spec: SpecDocument = {
      id: 's1',
      config: { timeout: 30, retry: true },
    };
    const overlays: SpecOverlay[] = [
      { id: 'o1', type: SpecOverlayType.Merge, path: 'config', value: { timeout: 60, logLevel: 'debug' }, timestamp: '2026-01-01T00:00:00.000Z' },
    ];

    const result = getEffectiveSpec(spec, overlays);

    const config = result.content.config as Record<string, unknown>;
    assert.equal(config.timeout, 60); // replaced by overlay
    assert.equal(config.retry, true); // preserved from base
    assert.equal(config.logLevel, 'debug'); // added by overlay
  });

  it('applies a Delete overlay at a top-level path', () => {
    const spec: SpecDocument = { id: 's1', title: 'Test', deprecatedField: 'remove me' };
    const overlays: SpecOverlay[] = [
      { id: 'o1', type: SpecOverlayType.Delete, path: 'deprecatedField', timestamp: '2026-01-01T00:00:00.000Z' },
    ];

    const result = getEffectiveSpec(spec, overlays);

    assert.equal('deprecatedField' in result.content, false);
    assert.equal(result.content.title, 'Test');
  });

  it('applies a Delete overlay at a nested path', () => {
    const spec: SpecDocument = {
      id: 's1',
      metadata: { author: 'alice', temp: 'remove' },
    };
    const overlays: SpecOverlay[] = [
      { id: 'o1', type: SpecOverlayType.Delete, path: 'metadata.temp', timestamp: '2026-01-01T00:00:00.000Z' },
    ];

    const result = getEffectiveSpec(spec, overlays);

    const meta = result.content.metadata as Record<string, unknown>;
    assert.equal('temp' in meta, false);
    assert.equal(meta.author, 'alice');
  });

  it('sorts overlays by timestamp (ascending) and applies in order', () => {
    const spec: SpecDocument = { id: 's1', title: 'Initial' };
    const overlays: SpecOverlay[] = [
      { id: 'o2', type: SpecOverlayType.Replace, path: 'title', value: 'Second', timestamp: '2026-01-02T00:00:00.000Z' },
      { id: 'o1', type: SpecOverlayType.Replace, path: 'title', value: 'First', timestamp: '2026-01-01T00:00:00.000Z' },
      { id: 'o3', type: SpecOverlayType.Replace, path: 'title', value: 'Third', timestamp: '2026-01-03T00:00:00.000Z' },
    ];

    const result = getEffectiveSpec(spec, overlays);

    // Last timestamp wins
    assert.equal(result.content.title, 'Third');
    // All overlays recorded in applied list
    assert.equal(result.appliedOverlays.length, 3);
    // Applied overlays should be sorted by timestamp
    assert.equal(result.appliedOverlays[0].id, 'o1');
    assert.equal(result.appliedOverlays[1].id, 'o2');
    assert.equal(result.appliedOverlays[2].id, 'o3');
  });

  it('does not mutate the original spec', () => {
    const spec: SpecDocument = { id: 's1', title: 'Original' };
    const overlays: SpecOverlay[] = [
      { id: 'o1', type: SpecOverlayType.Replace, path: 'title', value: 'Changed', timestamp: '2026-01-01T00:00:00.000Z' },
    ];

    getEffectiveSpec(spec, overlays);

    assert.equal(spec.title, 'Original');
  });

  it('handles multiple overlay types in sequence', () => {
    const spec: SpecDocument = {
      id: 's1',
      title: 'Base',
      config: { a: 1, b: 2 },
      tempField: 'will be deleted',
    };
    const overlays: SpecOverlay[] = [
      { id: 'o1', type: SpecOverlayType.Replace, path: 'title', value: 'Updated', timestamp: '2026-01-01T00:00:00.000Z' },
      { id: 'o2', type: SpecOverlayType.Merge, path: 'config', value: { c: 3 }, timestamp: '2026-01-02T00:00:00.000Z' },
      { id: 'o3', type: SpecOverlayType.Delete, path: 'tempField', timestamp: '2026-01-03T00:00:00.000Z' },
    ];

    const result = getEffectiveSpec(spec, overlays);

    assert.equal(result.content.title, 'Updated');
    assert.deepStrictEqual(result.content.config, { a: 1, b: 2, c: 3 });
    assert.equal('tempField' in result.content, false);
  });

  it('handles empty overlays array', () => {
    const spec: SpecDocument = { id: 's1', title: 'Test' };
    const result = getEffectiveSpec(spec, []);

    assert.deepStrictEqual(result.content, spec);
    assert.deepStrictEqual(result.appliedOverlays, []);
  });

  it('deleting a non-existent path is a no-op', () => {
    const spec: SpecDocument = { id: 's1', title: 'Test' };
    const overlays: SpecOverlay[] = [
      { id: 'o1', type: SpecOverlayType.Delete, path: 'nonexistent.path', timestamp: '2026-01-01T00:00:00.000Z' },
    ];

    const result = getEffectiveSpec(spec, overlays);

    assert.deepStrictEqual(result.content, spec);
  });

  it('replace on a non-existent path creates it', () => {
    const spec: SpecDocument = { id: 's1', title: 'Test' };
    const overlays: SpecOverlay[] = [
      { id: 'o1', type: SpecOverlayType.Replace, path: 'newField', value: 'created', timestamp: '2026-01-01T00:00:00.000Z' },
    ];

    const result = getEffectiveSpec(spec, overlays);

    assert.equal(result.content.newField, 'created');
  });

  it('replace on a non-existent nested path creates intermediate objects', () => {
    const spec: SpecDocument = { id: 's1' };
    const overlays: SpecOverlay[] = [
      { id: 'o1', type: SpecOverlayType.Replace, path: 'a.b.c', value: 'deep', timestamp: '2026-01-01T00:00:00.000Z' },
    ];

    const result = getEffectiveSpec(spec, overlays);

    const a = result.content.a as Record<string, unknown>;
    const b = a.b as Record<string, unknown>;
    assert.equal(b.c, 'deep');
  });

  it('merge on non-existent path creates the value', () => {
    const spec: SpecDocument = { id: 's1' };
    const overlays: SpecOverlay[] = [
      { id: 'o1', type: SpecOverlayType.Merge, path: 'config', value: { timeout: 30 }, timestamp: '2026-01-01T00:00:00.000Z' },
    ];

    const result = getEffectiveSpec(spec, overlays);

    assert.deepStrictEqual(result.content.config, { timeout: 30 });
  });

  it('preserves the spec id and path from the base spec', () => {
    const spec: SpecDocument = { id: 'my-slice', path: 'specs/my-slice.md' };
    const overlays: SpecOverlay[] = [
      { id: 'o1', type: SpecOverlayType.Replace, path: 'title', value: 'Updated', timestamp: '2026-01-01T00:00:00.000Z' },
    ];

    const result = getEffectiveSpec(spec, overlays);

    assert.equal(result.specId, 'my-slice');
    assert.equal(result.specPath, 'specs/my-slice.md');
  });
});
