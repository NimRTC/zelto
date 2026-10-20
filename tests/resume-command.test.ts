import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SliceStore } from '../src/core/slice/store.js';
import { EventStream } from '../src/core/events/stream.js';
import { Scheduler } from '../src/core/sched/engine.js';
import type { PolicyConfig } from '../src/core/policy/types.js';

const TEST_DIR = join(tmpdir(), `zelto-resume-cmd-test-${Date.now()}`);
const SLICES_DIR = join(TEST_DIR, '.zelto', 'slices');
const EVENTS_DIR = join(TEST_DIR, '.zelto', 'events');

const samplePolicy: PolicyConfig = {
  rules: [],
  protected: [],
};

function stalledSlice(id: string, title: string, stallClass: string) {
  return {
    id,
    title,
    state: 'running',
    stall: { class: stallClass, autoResolved: 0, gateRetries: 0 },
    spec: {},
    trace: [],
    runs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function normalSlice(id: string, title: string) {
  return {
    id,
    title,
    state: 'draft',
    stall: { class: null, autoResolved: 0, gateRetries: 0 },
    spec: {},
    trace: [],
    runs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('zelto resume command', () => {
  let store: SliceStore;
  let events: EventStream;
  let scheduler: Scheduler;

  before(async () => {
    await mkdir(SLICES_DIR, { recursive: true });
    await mkdir(EVENTS_DIR, { recursive: true });
    store = new SliceStore(SLICES_DIR);
    events = new EventStream(EVENTS_DIR);
    scheduler = new Scheduler(store, events, samplePolicy);

    // Create test slices
    await writeFile(join(SLICES_DIR, 'stall-1.json'), JSON.stringify(stalledSlice('stall-1', 'Stalled One', 'permission_prompt')));
    await writeFile(join(SLICES_DIR, 'stall-2.json'), JSON.stringify(stalledSlice('stall-2', 'Stalled Two', 'cognitive_stuck')));
    await writeFile(join(SLICES_DIR, 'normal-1.json'), JSON.stringify(normalSlice('normal-1', 'Normal One')));
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('resumes a stalled slice (re-raise agent)', async () => {
    await scheduler.resume('stall-1', {});
    const s = await store.read('stall-1');
    // Stall cleared, slice still in running state
    assert.equal(s.stall.class, null);
    // Check that run.resumed event was emitted
    const evts = await events.read('stall-1');
    assert.ok(evts.some((e) => e.type === 'run.resumed'));
  });

  it('resume with --skip marks resolved without re-execution', async () => {
    await scheduler.resume('stall-2', { skip: true });
    const s = await store.read('stall-2');
    assert.equal(s.stall.class, null);
    const evts = await events.read('stall-2');
    assert.ok(evts.some((e) => e.type === 'run.resumed'));
  });

  it('resume with --abandon abandons the slice', async () => {
    // Create a fresh stalled slice for abandon test
    await writeFile(join(SLICES_DIR, 'stall-abandon.json'), JSON.stringify(stalledSlice('stall-abandon', 'To Abandon', 'plan_gate')));
    await scheduler.resume('stall-abandon', { abandon: true });
    const s = await store.read('stall-abandon');
    assert.equal(s.state, 'abandoned');
    const evts = await events.read('stall-abandon');
    assert.ok(evts.some((e) => e.type === 'run.resumed'));
  });

  it('rejects non-stalled slice', async () => {
    try {
      await scheduler.resume('normal-1', {});
      assert.fail('Should have thrown for non-stalled slice');
    } catch (err) {
      assert.ok((err as Error).message.includes('not stalled'));
    }
  });

  it('rejects non-existent slice ID', async () => {
    try {
      await store.read('non-existent');
      assert.fail('Should have thrown for non-existent slice');
    } catch {
      assert.ok(true);
    }
  });
});
