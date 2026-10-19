import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SliceStore } from '../src/core/slice/store.js';
import { Scheduler } from '../src/core/sched/engine.js';
import { EventStream } from '../src/core/events/stream.js';
import type { PolicyConfig } from '../src/core/policy/types.js';

const TEST_DIR = join(tmpdir(), `zelto-admit-cmd-test-${Date.now()}`);
const SLICES_DIR = join(TEST_DIR, 'slices');
const EVENTS_DIR = join(TEST_DIR, 'events');

const samplePolicy: PolicyConfig = {
  rules: [
    { id: 'allow-src', match: { path: 'src/**/*.ts', operation: 'write' }, action: 'allow', basis: 'policy.yaml' },
  ],
  protected: [],
};

describe('admit command', () => {
  let store: SliceStore;
  let events: EventStream;
  let scheduler: Scheduler;

  before(async () => {
    await mkdir(SLICES_DIR, { recursive: true });
    await mkdir(EVENTS_DIR, { recursive: true });
    store = new SliceStore(SLICES_DIR);
    events = new EventStream(EVENTS_DIR);
    scheduler = new Scheduler(store, events, samplePolicy);
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('admits a frozen slice with no conflicts', async () => {
    const slice = store.create('admit-test-1', 'Test 1', {
      writes: ['src/**/*.ts'],
    });
    slice.state = 'frozen';
    slice.spec.frozenHash = 'sha256:test';
    slice.spec.frozenAt = new Date().toISOString();
    await store.write(slice);

    const result = await scheduler.admit('admit-test-1');
    assert.equal(result.decision, 'admitted');
    assert.equal(result.blockedBy.length, 0);
  });

  it('admits a completed slice with no conflicts', async () => {
    const slice = store.create('admit-test-2', 'Test 2', {
      writes: ['src/**/*.ts'],
    });
    slice.state = 'completed';
    slice.spec.frozenHash = 'sha256:test';
    slice.spec.frozenAt = new Date().toISOString();
    await store.write(slice);

    const result = await scheduler.admit('admit-test-2');
    assert.equal(result.decision, 'admitted');
    assert.equal(result.blockedBy.length, 0);
  });

  it('rejects admit for draft slice', async () => {
    const slice = store.create('admit-test-3', 'Test 3');
    await store.write(slice);

    const result = await scheduler.admit('admit-test-3');
    assert.equal(result.decision, 'blocked');
    assert.ok(result.reason?.includes('draft'));
  });

  it('detects write-set conflicts between concurrent slices', async () => {
    const running = store.create('running-slice', 'Running', {
      writes: ['src/**/*.ts'],
    });
    running.state = 'frozen';
    running.spec.frozenHash = 'sha256:r1';
    running.spec.frozenAt = new Date().toISOString();
    await store.write(running);
    await store.transit('running-slice', 'RUN_START');

    const candidate = store.create('conflict-slice', 'Conflict', {
      writes: ['src/**/*.ts'],
    });
    candidate.state = 'frozen';
    candidate.spec.frozenHash = 'sha256:c1';
    candidate.spec.frozenAt = new Date().toISOString();
    await store.write(candidate);

    const result = await scheduler.admit('conflict-slice');
    assert.equal(result.decision, 'blocked');
    assert.ok(result.blockedBy.includes('running-slice'));
  });

  it('allows admit with non-overlapping writes', async () => {
    const running = store.create('running-slice-2', 'Running 2', {
      writes: ['src/core/**/*.ts'],
    });
    running.state = 'frozen';
    running.spec.frozenHash = 'sha256:r2';
    running.spec.frozenAt = new Date().toISOString();
    await store.write(running);
    await store.transit('running-slice-2', 'RUN_START');

    const candidate = store.create('no-conflict-slice', 'No Conflict', {
      writes: ['src/cli/**/*.ts'],
    });
    candidate.state = 'frozen';
    candidate.spec.frozenHash = 'sha256:nc1';
    candidate.spec.frozenAt = new Date().toISOString();
    await store.write(candidate);

    const result = await scheduler.admit('no-conflict-slice');
    assert.equal(result.decision, 'admitted');
  });
});
