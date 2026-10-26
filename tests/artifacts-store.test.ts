// Tests for ArtifactStore

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ArtifactStore } from '../src/core/artifacts/store.js';

const TEST_DIR = join(tmpdir(), 'zelto-artifact-test');

describe('ArtifactStore', () => {
  let store: ArtifactStore;

  before(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    store = new ArtifactStore(TEST_DIR);
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('stores an artifact from a file', async () => {
    const filePath = join(TEST_DIR, 'test-output.txt');
    await writeFile(filePath, 'hello world', 'utf-8');

    const art = await store.store('slice-1', 'build', 'Test output', filePath);
    assert.ok(art.id.startsWith('art-'), `id should start with art-: ${art.id}`);
    assert.equal(art.sliceId, 'slice-1');
    assert.equal(art.type, 'build');
    assert.ok(art.hash.startsWith('sha256:'), `hash should be sha256: ${art.hash}`);
    assert.equal(art.mimeType, 'text/plain');

    // Verify it was persisted
    const read = await store.read(art.id);
    assert.equal(read.label, 'Test output');
  });

  it('stores an artifact from a buffer', async () => {
    const buf = Buffer.from('{ "key": "value" }');
    const art = await store.storeBuffer('slice-1', 'analysis', 'JSON analysis', buf, 'report.json');

    assert.equal(art.mimeType, 'application/json');
    assert.equal(art.size, buf.length);

    const read = await store.read(art.id);
    assert.equal(read.type, 'analysis');
  });

  it('lists artifacts by slice', async () => {
    // Store artifacts for different slices
    await store.storeBuffer('slice-a', 'test-report', 'Test A1', Buffer.from('a1'), 'a1.txt');
    await store.storeBuffer('slice-a', 'test-report', 'Test A2', Buffer.from('a2'), 'a2.txt');
    await store.storeBuffer('slice-b', 'build', 'Build B', Buffer.from('b1'), 'b1.txt');

    const sliceA = await store.list('slice-a');
    assert.equal(sliceA.length, 2);
    assert.ok(sliceA.every((a) => a.sliceId === 'slice-a'));

    const sliceB = await store.list('slice-b');
    assert.equal(sliceB.length, 1);
    assert.equal(sliceB[0].label, 'Build B');

    const all = await store.list();
    assert.equal(all.length, 5); // 2 from before + 3 new
  });

  it('deletes an artifact by id', async () => {
    const art = await store.storeBuffer('slice-del', 'log', 'To delete', Buffer.from('del'), 'del.log');
    await store.delete(art.id);

    await assert.rejects(
      () => store.read(art.id),
      /ENOENT/,
    );
  });

  it('deletes all artifacts for a slice', async () => {
    await store.storeBuffer('slice-clean', 'log', 'Clean 1', Buffer.from('c1'), 'c1.log');
    await store.storeBuffer('slice-clean', 'log', 'Clean 2', Buffer.from('c2'), 'c2.log');

    const count = await store.deleteBySlice('slice-clean');
    assert.equal(count, 2);

    const remaining = await store.list('slice-clean');
    assert.equal(remaining.length, 0);
  });

  it('verifies hash', async () => {
    const content = Buffer.from('verify me');
    const art = await store.storeBuffer('slice-hash', 'build', 'Hash check', content, 'hash.txt');

    const valid = await store.verifyHash(art.id, content);
    assert.equal(valid, true);

    const invalid = await store.verifyHash(art.id, Buffer.from('tampered'));
    assert.equal(invalid, false);
  });

  it('guesses mime types correctly', async () => {
    const testCases = [
      { name: 'script.js', expected: 'application/javascript' },
      { name: 'style.css', expected: 'text/css' },
      { name: 'doc.md', expected: 'text/markdown' },
      { name: 'data.json', expected: 'application/json' },
      { name: 'unknown.xyz', expected: 'application/octet-stream' },
    ];

    for (const tc of testCases) {
      const art = await store.storeBuffer('slice-mime', 'other', tc.name, Buffer.from('x'), tc.name);
      assert.equal(art.mimeType, tc.expected, `MIME for ${tc.name}`);
    }
  });
});
