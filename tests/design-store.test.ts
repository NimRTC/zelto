// Tests for DesignStore — file-based design persistence

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { DesignStore } from '../src/core/design/store.js';
import type { DesignDoc } from '../src/core/design/types.js';

const TEST_DIR = join(tmpdir(), `zelto-design-store-test-${Date.now()}`);

function makeSampleDesign(id: string, reqId: string): DesignDoc {
  return {
    id,
    requirementId: reqId,
    title: `Design ${id}`,
    body: `# ${id}\n\n## Modules\n\n### Auth\n- **职责**: handles auth`,
    modules: [
      { name: 'Auth', description: 'handles auth', filePatterns: ['src/auth/**'], dependencies: [] },
    ],
    status: 'draft',
    supersedes: null,
    createdAt: new Date().toISOString(),
    confirmedAt: null,
  };
}

describe('DesignStore', () => {
  let store: DesignStore;

  before(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    store = new DesignStore(TEST_DIR);
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('saves and reads a design', async () => {
    const design = makeSampleDesign('dsg-test-1', 'req-1');
    await store.save(design);

    const loaded = await store.read('dsg-test-1');
    assert.equal(loaded.id, 'dsg-test-1');
    assert.equal(loaded.requirementId, 'req-1');
    assert.equal(loaded.modules.length, 1);
    assert.equal(loaded.modules[0].name, 'Auth');
  });

  it('lists designs with summaries', async () => {
    const list = await store.list();
    assert.ok(list.length >= 1);

    const item = list.find((d) => d.id === 'dsg-test-1');
    assert.ok(item);
    assert.equal(item!.requirementId, 'req-1');
    assert.equal(item!.moduleCount, 1);
  });

  it('checks existence', async () => {
    assert.ok(await store.exists('dsg-test-1'));
    assert.ok(!(await store.exists('dsg-nonexistent')));
  });

  it('updates status on confirm', async () => {
    const design = makeSampleDesign('dsg-confirm-test', 'req-2');
    await store.save(design);

    const loaded = await store.read('dsg-confirm-test');
    loaded.status = 'confirmed';
    loaded.confirmedAt = new Date().toISOString();
    await store.save(loaded);

    const confirmed = await store.read('dsg-confirm-test');
    assert.equal(confirmed.status, 'confirmed');
    assert.ok(confirmed.confirmedAt);
  });

  it('preserves modules with multiple entries', async () => {
    const design: DesignDoc = {
      id: 'dsg-multi-module',
      requirementId: 'req-3',
      title: 'Multi Module',
      body: '...',
      modules: [
        { name: 'Core', description: 'core module', filePatterns: ['src/core/**'], dependencies: [] },
        { name: 'API', description: 'api module', filePatterns: ['src/api/**'], dependencies: ['Core'] },
        { name: 'UI', description: 'ui module', filePatterns: ['src/ui/**'], dependencies: ['API'] },
      ],
      status: 'draft',
      supersedes: null,
      createdAt: new Date().toISOString(),
      confirmedAt: null,
    };
    await store.save(design);

    const loaded = await store.read('dsg-multi-module');
    assert.equal(loaded.modules.length, 3);
    assert.deepEqual(loaded.modules[1].dependencies, ['Core']);
  });

  it('returns empty list for uninitialized directory', async () => {
    const emptyStore = new DesignStore(join(TEST_DIR, 'nonexistent'));
    const list = await emptyStore.list();
    assert.deepEqual(list, []);
  });

  it('throws on reading nonexistent design', async () => {
    await assert.rejects(
      () => store.read('dsg-nonexistent'),
      /not found/,
    );
  });
});
