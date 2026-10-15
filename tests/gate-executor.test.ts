import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { GateExecutor } from '../src/core/gate/executor.js';
import { SliceStore } from '../src/core/slice/store.js';
import { EventStream, type EventEnvelope } from '../src/core/events/stream.js';
import type { GateConfig } from '../src/core/gate/types.js';

const TEST_DIR = join(tmpdir(), `zelto-gate-test-${Date.now()}`);
const SLICES_DIR = join(TEST_DIR, 'slices');
const EVENTS_DIR = join(TEST_DIR, 'events');

const sampleGateConfig: GateConfig = {
  commands: [
    { name: 'echo', run: 'echo hello' },
  ],
  changedLineCoverage: 0.8,
  timeoutSec: 30,
  retry: { max: 1, budgetStepUsd: 0.05 },
};

describe('GateExecutor', () => {
  let store: SliceStore;
  let events: EventStream;
  let executor: GateExecutor;

  before(async () => {
    await mkdir(SLICES_DIR, { recursive: true });
    await mkdir(EVENTS_DIR, { recursive: true });
    store = new SliceStore(SLICES_DIR);
    events = new EventStream(EVENTS_DIR);
    executor = new GateExecutor(store, events, sampleGateConfig, TEST_DIR);

    const slice = store.create('test-001', 'Test slice');
    slice.state = 'frozen';
    slice.spec.frozenHash = 'abc123';
    slice.spec.frozenAt = new Date().toISOString();
    await store.write(slice);
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('executes commands and returns report', async () => {
    const report = await executor.execute('test-001');
    assert.equal(report.sliceId, 'test-001');
    assert.equal(report.results.length, 1);
    assert.equal(report.results[0].command, 'echo');
    assert.equal(report.passed, true);
    assert.ok(report.totalDurationMs > 0);
  });

  it('records gate.executed and gate.result events', async () => {
    const evts = await events.read('test-001');
    const types = evts.map((e: EventEnvelope) => e.type);
    assert.ok(types.includes('gate.executed'));
    assert.ok(types.includes('gate.result'));
  });
});

describe('GateExecutor — failure handling', () => {
  let store: SliceStore;
  let events: EventStream;
  let executor: GateExecutor;

  before(async () => {
    store = new SliceStore(SLICES_DIR);
    events = new EventStream(EVENTS_DIR);
    executor = new GateExecutor(store, events, {
      commands: [
        { name: 'false', run: '' }, // exit code 1
      ],
      changedLineCoverage: 0.8,
      timeoutSec: 10,
      retry: { max: 1, budgetStepUsd: 0.05 },
    }, TEST_DIR);
  });

  it('reports failure for non-zero exit', async () => {
    const slice = store.create('test-fail-001', 'Failure test slice');
    slice.state = 'frozen';
    slice.spec.frozenHash = 'abc123';
    slice.spec.frozenAt = new Date().toISOString();
    await store.write(slice);

    const report = await executor.execute('test-fail-001');
    assert.equal(report.passed, false);
    assert.equal(report.results[0].passed, false);
    assert.equal(report.results[0].exitCode, 1);
  });
});
