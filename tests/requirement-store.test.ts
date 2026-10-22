// Tests for RequirementStore — file-based requirement persistence

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { RequirementStore } from '../src/core/requirements/store.js';
import type { RequirementDoc } from '../src/core/requirements/types.js';

const TEST_DIR = join(tmpdir(), `zelto-req-store-test-${Date.now()}`);

function makeSampleReq(id: string, status: 'draft' | 'confirmed' = 'draft'): RequirementDoc {
  return {
    id,
    title: `Test ${id}`,
    userInput: 'user wants a login system',
    spec: '# Login System\n\n## Overview\nA login system.',
    status,
    supersedes: null,
    acceptanceCriteria: ['Users can register', 'Users can login'],
    createdAt: new Date().toISOString(),
    confirmedAt: status === 'confirmed' ? new Date().toISOString() : null,
  };
}

describe('RequirementStore', () => {
  let store: RequirementStore;

  before(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    store = new RequirementStore(TEST_DIR);
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('saves and reads a requirement', async () => {
    const req = makeSampleReq('req-test-1');
    await store.save(req);

    const loaded = await store.read('req-test-1');
    assert.equal(loaded.id, 'req-test-1');
    assert.equal(loaded.title, 'Test req-test-1');
    assert.equal(loaded.status, 'draft');
    assert.equal(loaded.acceptanceCriteria.length, 2);
    assert.ok(loaded.spec.includes('Login System'));
  });

  it('lists requirements sorted by creation time', async () => {
    const req2 = makeSampleReq('req-test-2');
    req2.createdAt = new Date(Date.now() + 1000).toISOString();
    await store.save(req2);

    const list = await store.list();
    assert.ok(list.length >= 2);

    // Most recent first
    const idx2 = list.findIndex((r) => r.id === 'req-test-2');
    const idx1 = list.findIndex((r) => r.id === 'req-test-1');
    assert.ok(idx2 < idx1, 'newest should be first');
  });

  it('checks existence', async () => {
    assert.ok(await store.exists('req-test-1'));
    assert.ok(!(await store.exists('req-nonexistent')));
  });

  it('updates status on confirm', async () => {
    const req = makeSampleReq('req-confirm-test');
    await store.save(req);

    const loaded = await store.read('req-confirm-test');
    loaded.status = 'confirmed';
    loaded.confirmedAt = new Date().toISOString();
    await store.save(loaded);

    const confirmed = await store.read('req-confirm-test');
    assert.equal(confirmed.status, 'confirmed');
    assert.ok(confirmed.confirmedAt);
  });

  it('preserves full spec content through save/read cycle', async () => {
    const spec = '# Full Spec\n\n## Details\nMulti-line\ncontent\nwith\n\nblank lines.';
    const req: RequirementDoc = {
      id: 'req-full-spec',
      title: 'Full Spec Test',
      userInput: 'test input',
      spec,
      status: 'draft',
      supersedes: null,
      acceptanceCriteria: ['Criterion 1'],
      createdAt: new Date().toISOString(),
      confirmedAt: null,
    };
    await store.save(req);

    const loaded = await store.read('req-full-spec');
    assert.equal(loaded.spec, spec);
  });

  it('returns empty list for uninitialized directory', async () => {
    const emptyStore = new RequirementStore(join(TEST_DIR, 'nonexistent'));
    const list = await emptyStore.list();
    assert.deepEqual(list, []);
  });

  it('throws on reading nonexistent requirement', async () => {
    await assert.rejects(
      () => store.read('req-nonexistent'),
      /not found/,
    );
  });
});
