// Acceptance test: glossary-command
//
// 跑的是 `dist/cli/index.js` 这个**真实 CLI 进程**（不是 dist-test/ 里的产物），
// 验的是「命令接上去之后是不是真的能用」——
// 参数解析、子命令路由、退出码、事件落盘、文件读写，这些单元测试覆盖不到。
//
// 与单元测试（tests/core/glossary/）的分工：
//   单元测试验「core 里的判定逻辑对不对」
//   这里验「命令接上去之后行为对不对」

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');
const TEST_DIR = join(
  tmpdir(),
  `zelto-accept-glossary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
);
const GLOSSARY_PATH = join(TEST_DIR, '.zelto', 'glossary.json');

function zelto(...args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [CLI_SCRIPT, ...args], {
    cwd: TEST_DIR,
    encoding: 'utf-8',
    timeout: 20000,
  });
  return {
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    status: result.status,
  };
}

/** 从 stdout 里取出唯一那行 JSON（`f.data` 在 JSON 模式下输出单个对象） */
function parseJson(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe('zelto glossary (acceptance)', { concurrency: false }, () => {
  before(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    const init = zelto('init');
    assert.equal(init.status, 0, `init failed: ${init.stderr}`);
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // 每个用例从「没有词表」开始 —— 词表是全局状态，串起来会互相污染
    await rm(GLOSSARY_PATH, { force: true });
  });

  // ─── show ────────────────────────────────────────────────────────────────

  it('show on an empty project says the glossary does not exist yet', () => {
    const result = zelto('glossary', 'show');
    assert.equal(result.status, 0, `show should exit 0: ${result.stderr}`);
    assert.ok(
      result.stdout.includes('尚未建立词汇表'),
      `Expected "尚未建立词汇表", got: ${result.stdout}`,
    );
  });

  it('show --json on an empty project reports hasGlossary=false', () => {
    const result = zelto('glossary', 'show', '--json');
    assert.equal(result.status, 0);

    const parsed = parseJson(result.stdout);
    const data = parsed.data as { hasGlossary: boolean; terms: unknown[] };
    assert.equal(data.hasGlossary, false);
    assert.deepEqual(data.terms, []);
  });

  // ─── add ─────────────────────────────────────────────────────────────────

  it('add creates the glossary file', () => {
    const result = zelto('glossary', 'add', 'slice', '--meaning', '切片：一次可独立交付的作业单元');
    assert.equal(result.status, 0, `add should exit 0: ${result.stderr}`);
    assert.ok(existsSync(GLOSSARY_PATH), 'glossary.json should exist after add');
  });

  it('add stores the term with its meaning', async () => {
    zelto('glossary', 'add', 'slice', '--meaning', '切片');
    const raw = JSON.parse(await readFile(GLOSSARY_PATH, 'utf-8'));
    assert.equal(raw.terms.length, 1);
    assert.equal(raw.terms[0].term, 'slice');
    assert.equal(raw.terms[0].meaning, '切片');
  });

  it('add supports aliases and the controlled flag', async () => {
    zelto('glossary', 'add', 'slice', '--meaning', '切片', '--alias', '切片', '--controlled');
    const raw = JSON.parse(await readFile(GLOSSARY_PATH, 'utf-8'));
    assert.deepEqual(raw.terms[0].aliases, ['切片']);
    assert.equal(raw.terms[0].controlled, true);
  });

  it('add without a term is a usage error', () => {
    const result = zelto('glossary', 'add');
    assert.equal(result.status, 1, 'add without term should exit 1');
    // 错误走 stderr（JSON 模式下 `f.error` 写 stderr）
    assert.ok(result.stderr.includes('USAGE'), `Expected USAGE error, got: ${result.stderr}`);
  });

  it('add updates an existing term instead of duplicating it', async () => {
    zelto('glossary', 'add', 'slice', '--meaning', '切片');
    zelto('glossary', 'add', 'slice', '--meaning', '新的意思');

    const raw = JSON.parse(await readFile(GLOSSARY_PATH, 'utf-8'));
    assert.equal(raw.terms.length, 1, 'should not duplicate the term');
    assert.equal(raw.terms[0].meaning, '新的意思');
  });

  // ─── show（有了词表之后）────────────────────────────────────────────────

  it('show lists the terms', () => {
    zelto('glossary', 'add', 'slice', '--meaning', '切片');
    zelto('glossary', 'add', 'worktree', '--meaning', '隔离工作目录');

    const result = zelto('glossary', 'show');
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes('slice'), 'should list slice');
    assert.ok(result.stdout.includes('worktree'), 'should list worktree');
    assert.ok(result.stdout.includes('隔离工作目录'), 'should show the meaning');
  });

  it('show --json returns the whole glossary', () => {
    zelto('glossary', 'add', 'slice', '--meaning', '切片');

    const result = zelto('glossary', 'show', '--json');
    assert.equal(result.status, 0);

    const parsed = parseJson(result.stdout);
    const data = parsed.data as { hasGlossary: boolean; glossary: { terms: unknown[] } };
    assert.equal(data.hasGlossary, true);
    assert.equal(data.glossary.terms.length, 1);
  });

  // ─── remove ──────────────────────────────────────────────────────────────

  it('remove deletes the term', async () => {
    zelto('glossary', 'add', 'slice', '--meaning', '切片');
    zelto('glossary', 'add', 'worktree', '--meaning', '目录');

    const result = zelto('glossary', 'remove', 'slice');
    assert.equal(result.status, 0, `remove should exit 0: ${result.stderr}`);

    const raw = JSON.parse(await readFile(GLOSSARY_PATH, 'utf-8'));
    assert.equal(raw.terms.length, 1);
    assert.equal(raw.terms[0].term, 'worktree');
  });

  it('remove of an unknown term warns but does not fail', () => {
    zelto('glossary', 'add', 'slice', '--meaning', '切片');

    const result = zelto('glossary', 'remove', 'nonexistent');
    assert.equal(result.status, 0, 'removing an unknown term should not fail');
    // 警告走 stderr（JSON 模式下 `f.warn` 写 stderr）
    assert.ok(
      result.stderr.includes('nonexistent') || result.stderr.includes('没有'),
      `Expected a warning about the missing term, got: ${result.stderr}`,
    );
  });

  it('remove without a term is a usage error', () => {
    const result = zelto('glossary', 'remove');
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('USAGE'), `Expected USAGE error, got: ${result.stderr}`);
  });

  // ─── check ───────────────────────────────────────────────────────────────

  it('check without a glossary says so instead of pretending all is well', () => {
    const result = zelto('glossary', 'check');
    assert.equal(result.status, 0, `check should exit 0: ${result.stderr}`);
    assert.ok(
      result.stdout.includes('尚未建立词汇表'),
      `Expected "尚未建立词汇表", got: ${result.stdout}`,
    );
    // 关键：不能报「一切正常」——「还没建立」与「一切正常」是两回事
    assert.ok(
      !result.stdout.includes('一致'),
      'Must not report consistency when no glossary exists',
    );
  });

  it('check reports terms used in the specs', async () => {
    zelto('glossary', 'add', 'slice', '--meaning', '切片');

    const specDir = join(TEST_DIR, 'specs', 'slices');
    await mkdir(specDir, { recursive: true });
    await writeFile(
      join(specDir, 'demo.md'),
      '# 演示规格\n\n## 验收标准\n\n1. 这一片要改 slice 的写集。\n',
      'utf-8',
    );

    const result = zelto('glossary', 'check');
    assert.equal(result.status, 0, `check should exit 0: ${result.stderr}`);
    assert.ok(result.stdout.includes('slice'), 'should report the used term');
  });

  it('check --json returns per-spec results', async () => {
    zelto('glossary', 'add', 'slice', '--meaning', '切片');

    const specDir = join(TEST_DIR, 'specs', 'slices');
    await mkdir(specDir, { recursive: true });
    await writeFile(join(specDir, 'demo.md'), '# 演示规格\n\n这一片改 slice。\n', 'utf-8');

    const result = zelto('glossary', 'check', '--json');
    assert.equal(result.status, 0);

    const parsed = parseJson(result.stdout);
    const data = parsed.data as {
      hasGlossary: boolean;
      specs: number;
      results: Array<{ sliceId: string; report: { usedTerms: string[] } }>;
    };
    assert.equal(data.hasGlossary, true);
    assert.ok(data.specs >= 1);
    const demo = data.results.find((r) => r.sliceId === 'demo');
    assert.ok(demo, 'should have a result for the demo spec');
    assert.ok(demo.report.usedTerms.includes('slice'));
  });

  it('check --json does not treat the flag as a slice id', async () => {
    // 回归：`check --json` 的 args[1] 是 `--json`。
    // 当成切片 id 去读会撞上未捕获的 ENOENT —— 直接崩成 stack trace，
    // 而不是报「切片不存在」。
    zelto('glossary', 'add', 'slice', '--meaning', '切片');

    const result = zelto('glossary', 'check', '--json');
    assert.equal(result.status, 0, `--json must not be read as a slice id: ${result.stderr}`);
    assert.ok(!result.stderr.includes('ENOENT'), `Must not crash: ${result.stderr}`);
  });

  it('check on a nonexistent slice reports NOT_FOUND instead of crashing', () => {
    zelto('glossary', 'add', 'slice', '--meaning', '切片');

    const result = zelto('glossary', 'check', 'no-such-slice');
    assert.equal(result.status, 1, 'checking a missing slice should exit 1');
    assert.ok(!result.stderr.includes('ENOENT'), `Must not crash: ${result.stderr}`);
    assert.ok(
      result.stderr.includes('NOT_FOUND'),
      `Expected NOT_FOUND, got: ${result.stderr}`,
    );
  });

  it('add accepts the term after a flag', () => {
    const result = zelto('glossary', 'add', '--json', 'worktree');
    assert.equal(result.status, 0, `--json must not be read as the term: ${result.stderr}`);
  });

  it('check reports candidate terms outside the glossary', async () => {
    zelto('glossary', 'add', 'slice', '--meaning', '切片');

    const specDir = join(TEST_DIR, 'specs', 'slices');
    await mkdir(specDir, { recursive: true });
    await writeFile(
      join(specDir, 'demo.md'),
      '# 演示规格\n\n这一片新增 `WriteSetGuard` 这个类。\n',
      'utf-8',
    );

    const result = zelto('glossary', 'check');
    assert.equal(result.status, 0);
    assert.ok(
      result.stdout.includes('WriteSetGuard'),
      `Expected the unknown candidate term, got: ${result.stdout}`,
    );
  });

  it('check on a nonexistent slice exits 1', () => {
    zelto('glossary', 'add', 'slice', '--meaning', '切片');

    const result = zelto('glossary', 'check', 'no-such-slice');
    assert.equal(result.status, 1, 'checking a missing slice should exit 1');
  });
  // ─── 事件流 ──────────────────────────────────────────────────────────────

  it('glossary changes write an append-only event', async () => {
    zelto('glossary', 'add', 'slice', '--meaning', '切片');

    const eventFile = join(TEST_DIR, '.zelto', 'events', 'glossary', 'events.jsonl');
    assert.ok(existsSync(eventFile), 'event file should exist after add');

    const content = await readFile(eventFile, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]);
    assert.equal(last.type, 'glossary.updated');
    assert.equal(last.payload.term, 'slice');
    assert.equal(last.payload.action, 'add');
  });

  it('glossary check writes a usage_checked event', async () => {
    zelto('glossary', 'add', 'slice', '--meaning', '切片');
    zelto('glossary', 'check');

    const eventFile = join(TEST_DIR, '.zelto', 'events', 'glossary', 'events.jsonl');
    const content = await readFile(eventFile, 'utf-8');
    assert.ok(content.includes('glossary.usage_checked'), 'should record a usage check');
  });
});
