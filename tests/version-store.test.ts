// Tests for VersionStore — file-based version plan persistence

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { VersionStore } from '../src/core/version/store.js';
import type { VersionPlan } from '../src/core/version/types.js';

const TEST_DIR = join(tmpdir(), `zelto-version-store-test-${Date.now()}`);

function makeSamplePlan(id: string): VersionPlan {
  return {
    id,
    designId: 'dsg-1',
    title: `Plan ${id}`,
    versions: [
      {
        version: 'v1',
        dependsOn: [],
        description: 'Core features',
        slices: [
          { id: 'v1-core', module: 'Core', title: 'Core module', writes: ['src/core/**'], specPath: 'specs/slices/v1-core.md', state: 'draft' },
        ],
        integrationTestDir: 'tests/acceptance/v1/',
        status: 'planned',
      },
      {
        version: 'v2',
        dependsOn: ['v1'],
        description: 'Extended features',
        slices: [
          { id: 'v2-ext', module: 'Ext', title: 'Ext module', writes: ['src/ext/**'], specPath: 'specs/slices/v2-ext.md', state: 'draft' },
        ],
        integrationTestDir: 'tests/acceptance/v2/',
        status: 'planned',
      },
    ],
    status: 'draft',
    createdAt: new Date().toISOString(),
    confirmedAt: null,
  };
}

describe('VersionStore', () => {
  let store: VersionStore;

  before(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    store = new VersionStore(TEST_DIR);
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('saves and reads a version plan', async () => {
    const plan = makeSamplePlan('plan-test-1');
    await store.save(plan);

    const loaded = await store.read('plan-test-1');
    assert.equal(loaded.id, 'plan-test-1');
    assert.equal(loaded.designId, 'dsg-1');
    assert.equal(loaded.versions.length, 2);
    assert.equal(loaded.status, 'draft');
  });

  it('lists plans with summaries', async () => {
    const list = await store.list();
    assert.ok(list.length >= 1);
    const item = list.find((p) => p.id === 'plan-test-1');
    assert.ok(item);
    assert.equal(item!.versionCount, 2);
  });

  it('checks existence', async () => {
    assert.ok(await store.exists('plan-test-1'));
    assert.ok(!(await store.exists('plan-nonexistent')));
  });

  it('updates version status', async () => {
    await store.updateVersionStatus('plan-test-1', 'v1', 'in_progress');
    const plan = await store.read('plan-test-1');
    const v1 = plan.versions.find((v) => v.version === 'v1');
    assert.equal(v1!.status, 'in_progress');
  });

  it('chains version status transitions', async () => {
    await store.updateVersionStatus('plan-test-1', 'v1', 'integrated');
    await store.updateVersionStatus('plan-test-1', 'v1', 'delivered');

    const plan = await store.read('plan-test-1');
    const v1 = plan.versions.find((v) => v.version === 'v1');
    assert.equal(v1!.status, 'delivered');
  });

  it('updates plan-level status to confirmed', async () => {
    const plan = makeSamplePlan('plan-confirm-test');
    await store.save(plan);

    plan.status = 'confirmed';
    plan.confirmedAt = new Date().toISOString();
    await store.save(plan);

    const loaded = await store.read('plan-confirm-test');
    assert.equal(loaded.status, 'confirmed');
    assert.ok(loaded.confirmedAt);
  });

  it('preserves slices through save/read cycle', async () => {
    const plan = await store.read('plan-test-1');
    const v2 = plan.versions.find((v) => v.version === 'v2');
    assert.equal(v2!.slices.length, 1);
    assert.equal(v2!.slices[0].id, 'v2-ext');
    assert.equal(v2!.slices[0].writes[0], 'src/ext/**');
  });

  it('throws on updating nonexistent version', async () => {
    await assert.rejects(
      () => store.updateVersionStatus('plan-test-1', 'v99', 'in_progress'),
      /not found/,
    );
  });

  it('returns empty list for uninitialized directory', async () => {
    const emptyStore = new VersionStore(join(TEST_DIR, 'nonexistent'));
    const list = await emptyStore.list();
    assert.deepEqual(list, []);
  });
});
