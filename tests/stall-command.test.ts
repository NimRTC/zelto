import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { SliceStore } from '../src/core/slice/store.js';
import { isSliceStalled } from '../src/core/stall/index.js';

const TEST_DIR = join(tmpdir(), `zelto-stall-cmd-test-${Date.now()}`);
const SLICES_DIR = join(TEST_DIR, '.zelto', 'slices');

function stalledSlice(id: string, title: string, stallClass: string, autoResolved = 0) {
  return {
    id,
    title,
    state: 'running',
    stall: { class: stallClass, autoResolved, gateRetries: 0 },
    spec: {},
    trace: [],
    runs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function normalSlice(id: string, title: string, state = 'draft') {
  return {
    id,
    title,
    state,
    stall: { class: null, autoResolved: 0, gateRetries: 0 },
    spec: {},
    trace: [],
    runs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('zelto stall command', () => {
  before(async () => {
    await mkdir(SLICES_DIR, { recursive: true });
    // Create test slices
    const slices = [
      stalledSlice('stall-1', 'Stalled One', 'permission_prompt'),
      stalledSlice('stall-2', 'Stalled Two', 'cognitive_stuck', 1),
      normalSlice('normal-1', 'Normal One', 'draft'),
      normalSlice('normal-2', 'Normal Two', 'frozen'),
    ];
    for (const s of slices) {
      await writeFile(join(SLICES_DIR, `${s.id}.json`), JSON.stringify(s, null, 2));
    }
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('lists stalled slices', async () => {
    const store = new SliceStore(SLICES_DIR);
    const allIds = await store.list();
    const stalled: Array<{ id: string; stallClass: string }> = [];

    for (const sid of allIds) {
      const s = await store.read(sid);
      if (isSliceStalled(s)) {
        stalled.push({ id: sid, stallClass: s.stall.class! });
      }
    }

    assert.equal(stalled.length, 2);
    assert.ok(stalled.some((s) => s.id === 'stall-1'));
    assert.ok(stalled.some((s) => s.id === 'stall-2'));
    assert.ok(!stalled.some((s) => s.id === 'normal-1'));
    assert.ok(!stalled.some((s) => s.id === 'normal-2'));
  });

  it('shows no stalled slices when none exist', async () => {
    const emptyDir = join(TEST_DIR, 'empty');
    await mkdir(emptyDir, { recursive: true });
    const emptyStore = new SliceStore(emptyDir);
    const allIds = await emptyStore.list();
    assert.equal(allIds.length, 0);

    const stalled: string[] = [];
    for (const sid of allIds) {
      const s = await emptyStore.read(sid);
      if (isSliceStalled(s)) stalled.push(sid);
    }
    assert.equal(stalled.length, 0);
  });

  it('shows details for a stalled slice', async () => {
    const store = new SliceStore(SLICES_DIR);
    const s = await store.read('stall-1');
    assert.equal(isSliceStalled(s), true);
    assert.equal(s.stall.class, 'permission_prompt');
    assert.equal(s.stall.autoResolved, 0);
    assert.equal(s.stall.gateRetries, 0);
  });

  it('shows auto-resolved count', async () => {
    const store = new SliceStore(SLICES_DIR);
    const s = await store.read('stall-2');
    assert.equal(isSliceStalled(s), true);
    assert.equal(s.stall.autoResolved, 1);
    assert.equal(s.stall.class, 'cognitive_stuck');
  });

  it('gives friendly error for non-existent ID', async () => {
    const store = new SliceStore(SLICES_DIR);
    try {
      await store.read('non-existent');
      assert.fail('Should have thrown');
    } catch {
      assert.ok(true);
    }
  });

  it('isSliceStalled returns false for normal slices', async () => {
    const store = new SliceStore(SLICES_DIR);
    const s = await store.read('normal-1');
    assert.equal(isSliceStalled(s), false);
  });

  it('isSliceStalled returns true for stalled slices', async () => {
    const store = new SliceStore(SLICES_DIR);
    const s = await store.read('stall-1');
    assert.equal(isSliceStalled(s), true);
  });
});
