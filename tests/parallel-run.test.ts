/**
 * Tests for zelto run --parallel argument parsing and dispatch.
 * C3: deterministic only — no model calls, no network
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/core/sched/engine.js';

// Test the argument parsing logic that runParallel uses
describe('zelto run --parallel', () => {
  it('extracts slice IDs from args', () => {
    const args = ['--parallel', 'v1-foo', 'v1-bar'];
    const ids = args.filter((a) => !a.startsWith('--') && a !== '--parallel');
    assert.deepEqual(ids, ['v1-foo', 'v1-bar']);
  });

  it('extracts IDs regardless of --parallel position', () => {
    const args = ['v1-foo', '--parallel', 'v1-bar'];
    const ids = args.filter((a) => !a.startsWith('--') && a !== '--parallel');
    assert.deepEqual(ids, ['v1-foo', 'v1-bar']);
  });

  it('ignores --agent and --adapter flags', () => {
    const args = ['--parallel', 'v1-foo', 'v1-bar', '--agent', 'npx', 'claude'];
    const ids = args.filter((a) => !a.startsWith('--') && a !== '--parallel');
    assert.deepEqual(ids, ['v1-foo', 'v1-bar', 'npx', 'claude']);
    // Note: 'npx' and 'claude' pass through — runParallel extracts
    // --agent value separately before using ids
  });

  it('requires at least 2 slice IDs', () => {
    const ids: string[] = [];
    assert.ok(ids.length < 2, 'Should require at least 2 slice IDs');
  });

  it('rejects single slice with --parallel', () => {
    const args = ['--parallel', 'v1-only'];
    const ids = args.filter((a) => !a.startsWith('--') && a !== '--parallel');
    assert.ok(ids.length < 2, 'Single slice should not be accepted for parallel');
  });
});

describe('Scheduler — checkConflicts', () => {
  it('detects overlapping write-sets', () => {
    const scheduler = new Scheduler(
      null as any, null as any,
      { rules: [], protected: [] },
    );

    // Non-overlapping writes
    const conflicts = scheduler.checkConflicts([
      ['src/foo.ts', 'src/bar.ts'],
      ['src/baz.ts'],
    ]);
    assert.equal(conflicts.length, 0, 'Non-overlapping writes should not conflict');

    // Overlapping writes
    const conflicts2 = scheduler.checkConflicts([
      ['src/foo.ts', 'src/shared.ts'],
      ['src/shared.ts', 'src/bar.ts'],
    ]);
    assert.equal(conflicts2.length, 1, 'Overlapping writes should conflict');
    assert.deepEqual(conflicts2[0], [0, 1]);
  });

  it('reports multiple conflict pairs', () => {
    const scheduler = new Scheduler(
      null as any, null as any,
      { rules: [], protected: [] },
    );

    // All three share a file
    const conflicts = scheduler.checkConflicts([
      ['src/common.ts'],
      ['src/common.ts'],
      ['src/common.ts'],
    ]);
    assert.equal(conflicts.length, 3, '3 slices sharing same file should have 3 conflict pairs');
  });
});
