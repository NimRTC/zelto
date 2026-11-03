import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuestionStore } from '../../../src/core/question/index.js';
import type { ParsedQuestion } from '../../../src/core/question/index.js';

const parsed: ParsedQuestion = {
  type: 'choice',
  question: '返回 404 还是 422？',
  options: ['404', '422'],
};

describe('QuestionStore — file-backed queue (C1: 状态只在文件里)', () => {
  let dir: string;
  let store: QuestionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zelto-q-'));
    store = new QuestionStore({ baseDir: join(dir, 'questions') });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('raises a pending question and writes it to disk', async () => {
    const record = await store.raise({
      sliceId: 'slice-001',
      parsed,
      zeltoSessionId: 'claude-agent-slice-001-123',
      agentSessionId: 'uuid-1',
      adapterName: 'claude-agent',
    });

    assert.equal(record.status, 'pending');
    assert.equal(record.sliceId, 'slice-001');
    assert.equal(record.severity, 'blocking');
    assert.equal(record.answer, null);
    assert.equal(record.answeredAt, null);

    const file = join(dir, 'questions', `${record.id}.json`);
    assert.ok(existsSync(file), 'question file must exist');
    const onDisk = JSON.parse(readFileSync(file, 'utf-8'));
    assert.equal(onDisk.question, '返回 404 还是 422？');
    assert.deepEqual(onDisk.options, ['404', '422']);
  });

  it('marks a question answered and keeps the answer on disk', async () => {
    const record = await store.raise({
      sliceId: 'slice-001',
      parsed,
      zeltoSessionId: 's1',
      agentSessionId: 'u1',
    });

    const answered = await store.answer(record.id, '用 404');
    assert.ok(answered);
    assert.equal(answered.status, 'answered');
    assert.equal(answered.answer, '用 404');
    assert.ok(answered.answeredAt);

    const reread = await store.read(record.id);
    assert.equal(reread?.status, 'answered');
    assert.equal(reread?.answer, '用 404');
  });

  it('refuses to answer the same question twice', async () => {
    const record = await store.raise({
      sliceId: 'slice-001',
      parsed,
      zeltoSessionId: 's1',
      agentSessionId: 'u1',
    });

    assert.ok(await store.answer(record.id, '第一次'));
    assert.equal(await store.answer(record.id, '第二次'), null);
    const reread = await store.read(record.id);
    assert.equal(reread?.answer, '第一次');
  });

  it('returns null when answering an unknown question', async () => {
    assert.equal(await store.answer('q-does-not-exist', 'x'), null);
  });

  it('lists pending questions and filters by slice', async () => {
    const a = await store.raise({ sliceId: 'slice-001', parsed, zeltoSessionId: 's1', agentSessionId: 'u1' });
    await store.raise({ sliceId: 'slice-002', parsed, zeltoSessionId: 's2', agentSessionId: 'u2' });

    assert.equal((await store.listPending()).length, 2);
    assert.equal((await store.listPending('slice-001')).length, 1);
    assert.equal((await store.listPending('slice-002'))[0].id.startsWith('q-slice-002'), true);

    await store.answer(a.id, '答了');
    const pending = await store.listPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].sliceId, 'slice-002');
    assert.equal((await store.listByStatus('answered')).length, 1);
  });

  it('returns an empty list when the questions dir does not exist', async () => {
    const empty = new QuestionStore({ baseDir: join(dir, 'missing') });
    assert.deepEqual(await empty.list(), []);
    assert.deepEqual(await empty.listPending(), []);
  });

  it('builds a deterministic id from slice id and timestamp', () => {
    assert.equal(QuestionStore.makeId('slice-001', 42), 'q-slice-001-42');
  });
});
