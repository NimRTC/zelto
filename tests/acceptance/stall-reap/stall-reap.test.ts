// ADR-053 · `zelto stall --reap` 的命令行行为（acceptance）
//
// 验的是命令层的那一半：死切片被挑出来、退回 frozen、留痕、
// 提问回路不被误伤。没有死切片时是空操作。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');
const TEST_DIR = join(
  tmpdir(),
  `zelto-accept-reap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
);
const SLICES_DIR = join(TEST_DIR, '.zelto', 'slices');

function zelto(...args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [CLI_SCRIPT, ...args], {
    cwd: TEST_DIR,
    encoding: 'utf-8',
  });
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim(), status: result.status };
}

/** 手工写一片处于指定状态、带指定停机分类的切片 */
async function writeSlice(
  id: string,
  state: 'running' | 'frozen',
  stallClass: string | null,
): Promise<void> {
  await writeFile(
    join(SLICES_DIR, `${id}.json`),
    JSON.stringify({
      id,
      title: `Slice ${id}`,
      state,
      spec: { path: `specs/slices/${id}.md`, frozenHash: null, frozenAt: null },
      acceptance: { dir: '', frozenHash: null, oracleSrc: null },
      baseCommit: null,
      drift: { detected: false, reason: null, at: null },
      trace: { requirements: [], contracts: [], tests: [] },
      traceWaiver: null,
      writes: [],
      runs: [{ at: '2026-11-11T00:00:00.000Z', ok: false, exitCode: 1 }],
      stall: { class: stallClass, autoResolved: 0, gateRetries: 0 },
      createdAt: '2026-11-11T00:00:00.000Z',
      updatedAt: '2026-11-11T00:00:00.000Z',
    }),
    'utf-8',
  );
}

async function readSlice(id: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(SLICES_DIR, `${id}.json`), 'utf-8'));
}

describe('zelto stall --reap (acceptance)', { concurrency: false }, () => {
  before(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    const init = zelto('init');
    assert.equal(init.status, 0, `init failed: ${init.stderr}`);
    await mkdir(SLICES_DIR, { recursive: true });
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('没有死切片时是空操作，退出码 0', async () => {
    await writeSlice('clean-slice', 'frozen', 'environment_failure');

    const result = zelto('stall', '--reap');

    assert.equal(result.status, 0, `reap failed: ${result.stderr}`);
    assert.match(result.stdout, /没有死切片/);
  });

  it('死切片被退回 frozen，停机分类保留', async () => {
    await writeSlice('dead-slice', 'running', 'environment_failure');

    const result = zelto('stall', '--reap');

    assert.equal(result.status, 0, `reap failed: ${result.stderr}`);
    assert.match(result.stdout, /已清理 1 个死切片/);

    const slice = await readSlice('dead-slice');
    assert.equal(slice.state, 'frozen', 'running 必须退回 frozen');
    const stall = slice.stall as { class: string | null };
    assert.equal(stall.class, 'environment_failure', '停机分类必须保留');
  });

  it('提问回路不被误伤', async () => {
    await writeSlice('question-slice', 'running', 'agent_question');

    const result = zelto('stall', '--reap');

    assert.equal(result.status, 0);
    const slice = await readSlice('question-slice');
    assert.equal(slice.state, 'running', '提问回路的 agent 还活着，不该被退掉');
  });

  it('--dry-run 只列不改', async () => {
    await writeSlice('dry-slice', 'running', 'environment_failure');

    const result = zelto('stall', '--reap', '--dry-run');

    assert.equal(result.status, 0, `reap failed: ${result.stderr}`);
    assert.match(result.stdout, /dry-run/);
    const slice = await readSlice('dry-slice');
    assert.equal(slice.state, 'running', '--dry-run 不得改状态');
  });

  it('--json 输出机器可读结果', async () => {
    await writeSlice('json-slice', 'running', 'context_exhaustion');

    const result = zelto('stall', '--reap', '--json');

    assert.equal(result.status, 0, `reap failed: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    const mine = parsed.reaped.find((r: { sliceId: string }) => r.sliceId === 'json-slice');
    assert.ok(mine, '本次清理必须包含 json-slice');
    assert.equal(mine.to, 'frozen');
  });

  it('清理留下 slice.state.changed 事件（C4）', async () => {
    await writeSlice('trace-slice', 'running', 'environment_failure');

    zelto('stall', '--reap');

    const eventsFile = join(TEST_DIR, '.zelto', 'events', 'trace-slice', 'events.jsonl');
    assert.ok(existsSync(eventsFile), '事件文件应当存在');
    const raw = await readFile(eventsFile, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    const reaped = lines
      .map((l) => JSON.parse(l))
      .find((e) => e.type === 'slice.state.changed' && e.payload?.reaped === true);
    assert.ok(reaped, '批量清理必须留痕');
    assert.equal(reaped.payload.from, 'running');
    assert.equal(reaped.payload.to, 'frozen');
  });

  it('停机列表里单列死切片', async () => {
    await writeSlice('listed-slice', 'running', 'environment_failure');

    const result = zelto('stall');

    assert.equal(result.status, 0);
    assert.match(result.stdout, /死切片/);
    assert.match(result.stdout, /listed-slice/);
  });
});
