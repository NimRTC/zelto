import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GlossaryStore,
  checkGlossaryUsage,
  parseGlossary,
  renderGlossary,
} from '../../../src/core/glossary/index.js';

const GLOSSARY = {
  version: 1,
  updatedAt: '2026-11-22T00:00:00.000Z',
  updatedBy: 'human',
  terms: [
    { term: 'slice', meaning: '切片', aliases: ['切片'], controlled: true },
    { term: 'worktree', meaning: '隔离工作目录', aliases: [], controlled: false },
  ],
};

describe('parseGlossary', () => {
  it('parses a well-formed glossary', () => {
    const g = parseGlossary(JSON.stringify(GLOSSARY));
    assert.equal(g.terms.length, 2);
    assert.equal(g.terms[0].term, 'slice');
    assert.equal(g.terms[0].controlled, true);
  });

  it('degrades to an empty glossary on malformed JSON', () => {
    const g = parseGlossary('{ not json');
    assert.deepEqual(g.terms, []);
    assert.equal(g.version, 1);
  });

  it('skips entries without a term', () => {
    const g = parseGlossary(JSON.stringify({ version: 1, terms: [{ meaning: 'x' }, { term: 'ok' }] }));
    assert.equal(g.terms.length, 1);
    assert.equal(g.terms[0].term, 'ok');
  });
});

describe('renderGlossary', () => {
  it('round-trips through parse', () => {
    const parsed = parseGlossary(renderGlossary(GLOSSARY));
    assert.equal(parsed.terms.length, 2);
    assert.deepEqual(parsed.terms.map((t) => t.term), ['slice', 'worktree']);
  });
});

describe('checkGlossaryUsage', () => {
  it('finds terms used in the text', () => {
    const g = parseGlossary(JSON.stringify(GLOSSARY));
    const report = checkGlossaryUsage('这一片改的是 slice 的写集。', g);
    assert.ok(report.usedTerms.includes('slice'));
    assert.ok(report.unusedTerms.includes('worktree'));
  });

  it('matches aliases', () => {
    const g = parseGlossary(JSON.stringify(GLOSSARY));
    const report = checkGlossaryUsage('这一片是切片级别的改动。', g);
    assert.ok(report.usedTerms.includes('slice'));
  });

  it('flags a controlled term reached through an alias', () => {
    const g = parseGlossary(JSON.stringify(GLOSSARY));
    const report = checkGlossaryUsage('这一片是切片级别的改动。', g);
    assert.equal(report.controlledViolations.length, 1);
    assert.equal(report.controlledViolations[0].canonical, 'slice');
    assert.equal(report.controlledViolations[0].used, '切片');
  });

  it('does not flag a controlled term when the canonical form is used', () => {
    const g = parseGlossary(JSON.stringify(GLOSSARY));
    const report = checkGlossaryUsage('这一片改的是 slice 的写集。', g);
    assert.equal(report.controlledViolations.length, 0);
  });

  it('matches ASCII terms on word boundaries', () => {
    const g = parseGlossary(JSON.stringify(GLOSSARY));
    // "sliced" 里含有 "slice"，但不是同一个词
    const report = checkGlossaryUsage('the code was sliced into pieces', g);
    assert.ok(!report.usedTerms.includes('slice'));
  });

  it('reports candidate terms that are outside the glossary', () => {
    const g = parseGlossary(JSON.stringify(GLOSSARY));
    const report = checkGlossaryUsage('新增 `WriteSetGuard` 这个类。', g);
    assert.ok(report.unknownTerms.includes('WriteSetGuard'));
  });

  it('does not treat paths as candidate terms', () => {
    const g = parseGlossary(JSON.stringify(GLOSSARY));
    const report = checkGlossaryUsage('改 `src/core/foo.ts` 文件。', g);
    assert.ok(!report.unknownTerms.some((t) => t.includes('/')));
  });

  it('handles an empty glossary', () => {
    const report = checkGlossaryUsage('some text', { version: 1, updatedAt: '', updatedBy: '', terms: [] });
    assert.equal(report.totalTerms, 0);
    assert.deepEqual(report.usedTerms, []);
  });
});

describe('GlossaryStore', () => {
  it('returns null when there is no glossary yet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zelto-glossary-'));
    try {
      const store = new GlossaryStore(dir);
      assert.equal(await store.exists(), false);
      assert.equal(await store.read(), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes and reads back a glossary', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zelto-glossary-'));
    try {
      const store = new GlossaryStore(dir);
      await store.upsert({ term: 'slice', meaning: '切片', aliases: [], controlled: true }, 'human');
      const read = await store.read();
      assert.ok(read);
      assert.equal(read!.terms.length, 1);
      assert.equal(read!.updatedBy, 'human');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('updates an existing term instead of duplicating it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zelto-glossary-'));
    try {
      const store = new GlossaryStore(dir);
      await store.upsert({ term: 'slice', meaning: '切片', aliases: [], controlled: true }, 'human');
      await store.upsert({ term: 'slice', meaning: '新的意思', aliases: [], controlled: true }, 'human');
      const read = await store.read();
      assert.equal(read!.terms.length, 1);
      assert.equal(read!.terms[0].meaning, '新的意思');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('removes a term', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zelto-glossary-'));
    try {
      const store = new GlossaryStore(dir);
      await store.upsert({ term: 'slice', meaning: '切片', aliases: [], controlled: true }, 'human');
      await store.upsert({ term: 'worktree', meaning: '目录', aliases: [], controlled: false }, 'human');
      const after = await store.remove('slice', 'human');
      assert.ok(after);
      assert.equal(after.terms.length, 1);
      assert.equal(after.terms[0].term, 'worktree');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the file on disk consistent with what was read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zelto-glossary-'));
    try {
      const store = new GlossaryStore(dir);
      await store.upsert({ term: 'slice', meaning: '切片', aliases: [], controlled: true }, 'human');
      const { readFile } = await import('node:fs/promises');
      const raw = JSON.parse(await readFile(store.path, 'utf-8'));
      assert.equal(raw.terms[0].term, 'slice');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
