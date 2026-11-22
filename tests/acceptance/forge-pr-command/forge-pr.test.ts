// Acceptance test: forge-pr-command
//
// 跑的是 `dist/cli/index.js` 这个**真实 CLI 进程**，验的是
// 「命令接上去之后是不是真的能用」——
// 子命令路由、退出码、默认不真的开 PR、正文里有没有追溯块、事件落盘。
//
// **不真的连 GitHub**：那需要网络与凭证，验不了「命令接上去对不对」。
// 真要验远端交互得另开一个测试（用假 `gh` 脚本 —— 见 ADR-094 的后续）。
//
// 与单元测试（tests/core/forge/pr-body.test.ts）的分工：
//   单元测试验「body 的渲染对不对」
//   这里验「命令接上去之后行为对不对」

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');
const TEST_DIR = join(
  tmpdir(),
  `zelto-accept-forge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
);

function zelto(...args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [CLI_SCRIPT, ...args], {
    cwd: TEST_DIR,
    encoding: 'utf-8',
    timeout: 30000,
  });
  return {
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    status: result.status,
  };
}

function git(...args: string[]): void {
  const result = spawnSync('git', args, {
    cwd: TEST_DIR,
    encoding: 'utf-8',
    timeout: 20000,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

const SLICE_ID = 'forge-demo';

interface SliceFile {
  id: string;
  title: string;
  state: string;
  spec: { path: string; frozenHash: string | null };
}

async function readSlice(id: string): Promise<SliceFile> {
  const raw = await readFile(join(TEST_DIR, '.zelto', 'slices', `${id}.json`), 'utf-8');
  return JSON.parse(raw) as SliceFile;
}

async function readEvents(id: string): Promise<Array<{ type: string }>> {
  const raw = await readFile(join(TEST_DIR, '.zelto', 'events', id, 'events.jsonl'), 'utf-8');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string });
}

/**
 * 造一个「已签字」的切片 —— 开 PR 要求已签字（ADR-094 D12）。
 */
async function seedSignedSlice(id: string): Promise<void> {
  const sliceDir = join(TEST_DIR, '.zelto', 'slices');
  const lockDir = join(TEST_DIR, '.zelto', 'locks');
  const eventDir = join(TEST_DIR, '.zelto', 'events', id);
  await mkdir(sliceDir, { recursive: true });
  await mkdir(lockDir, { recursive: true });
  await mkdir(eventDir, { recursive: true });

  const specPath = join('specs', 'slices', `${id}.md`);
  await mkdir(join(TEST_DIR, 'specs', 'slices'), { recursive: true });
  await writeFile(
    join(TEST_DIR, 'specs', 'slices', `${id}.md`),
    `# ${id}\n\n## 验收标准\n\n1. 这片能做点什么\n`,
    'utf-8',
  );

  const now = new Date().toISOString();
  const slice = {
    id,
    title: `${id} 的标题`,
    state: 'completed',
    spec: { path: specPath, frozenHash: 'sha256:fakehash', frozenAt: now, boundaryHash: null },
    acceptance: { dir: `tests/acceptance/${id}/`, frozenHash: null, oracleSrc: null },
    baseCommit: null,
    drift: { detected: false, reason: null, at: null },
    trace: { requirements: ['r1'], contracts: [], tests: [] },
    traceWaiver: null,
    baseline: false,
    writes: ['src/demo.ts'],
    runs: [],
    clarifyRounds: 0,
    stall: { class: null, autoResolved: 0, gateRetries: 0 },
    createdAt: now,
    updatedAt: now,
  };
  await writeFile(join(sliceDir, `${id}.json`), JSON.stringify(slice, null, 2), 'utf-8');

  const signId = `sign-${id}-1`;
  await writeFile(
    join(lockDir, `${signId}.json`),
    JSON.stringify(
      {
        id: signId,
        sliceId: id,
        requestedAt: now,
        requestedBy: 'zelto',
        status: 'approved',
        decidedAt: now,
        decidedBy: 'human',
        comment: null,
      },
      null,
      2,
    ),
    'utf-8',
  );

  // 签字事件 —— 追溯块要引它（ADR-094 §6.3）
  await writeFile(
    join(eventDir, 'events.jsonl'),
    JSON.stringify({
      ts: now,
      runSeq: 1,
      slice: id,
      run: null,
      type: 'sign.approved',
      actor: 'human',
      payload: { signId, sliceId: id },
    }) + '\n',
    'utf-8',
  );
}

describe('zelto forge pr (acceptance)', { concurrency: false }, () => {
  before(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    git('init', '-q');
    git('config', 'user.email', 'test@zelto.local');
    git('config', 'user.name', 'zelto-test');
    const init = zelto('init');
    assert.equal(init.status, 0, `init failed: ${init.stderr}`);
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await rm(join(TEST_DIR, '.zelto', 'slices'), { recursive: true, force: true });
    await rm(join(TEST_DIR, '.zelto', 'locks'), { recursive: true, force: true });
    await rm(join(TEST_DIR, '.zelto', 'events'), { recursive: true, force: true });
    await seedSignedSlice(SLICE_ID);
  });

  // ─── 默认不真的开 PR（D9）──────────────────────────────────────────────

  it('without --open it only previews — no PR is created', () => {
    const result = zelto('forge', 'pr', SLICE_ID);
    assert.equal(result.status, 0, `preview should exit 0: ${result.stderr}`);
    assert.ok(
      result.stdout.includes('预览'),
      `Expected a preview marker, got: ${result.stdout}`,
    );
    assert.ok(
      result.stdout.includes('没有开 PR'),
      `Expected "没有开 PR", got: ${result.stdout}`,
    );
  });

  it('the preview writes no forge.pr_opened event', async () => {
    zelto('forge', 'pr', SLICE_ID);
    const events = await readEvents(SLICE_ID);
    assert.ok(
      !events.some((e) => e.type === 'forge.pr_opened'),
      'a preview creates nothing — it must not claim a PR exists',
    );
  });

  // ─── 追溯链进正文 ──────────────────────────────────────────────────────

  it('the preview body carries the machine-readable trace block', () => {
    const result = zelto('forge', 'pr', SLICE_ID);
    assert.ok(
      result.stdout.includes('<!-- zelto-trace'),
      `Expected the trace block, got: ${result.stdout}`,
    );
    assert.ok(result.stdout.includes('zelto-trace/1'), 'Expected the schema version');
  });

  it('--print-body outputs only the body', () => {
    const result = zelto('forge', 'pr', SLICE_ID, '--print-body');
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes('<!-- zelto-trace'));
    assert.ok(
      !result.stdout.includes('PR 预览'),
      'print-body must not print the preview wrapper',
    );
  });

  it('the body says that merging happens in zelto, not on GitHub', () => {
    const result = zelto('forge', 'pr', SLICE_ID, '--print-body');
    assert.ok(
      result.stdout.includes('zelto merge forge-demo'),
      `Expected the explicit merge command, got: ${result.stdout}`,
    );
    assert.ok(
      result.stdout.includes('批准权在 zelto 里'),
      `Expected the approval authority statement, got: ${result.stdout}`,
    );
  });

  it('--json returns the title, body and the structured trace', () => {
    const result = zelto('forge', 'pr', SLICE_ID, '--json');
    assert.equal(result.status, 0);

    // JSON 模式的信封是 `{data: {...}}` —— 结构化载荷在 data 里。
    const parsed = JSON.parse(result.stdout) as {
      data: {
        title: string;
        base: string;
        head: string;
        body: string;
        trace: Record<string, unknown>;
      };
    };
    const data = parsed.data;
    assert.equal(data.title, '[zelto] forge-demo 的标题');
    assert.equal(data.base, 'main');
    assert.equal(data.head, 'slice/forge-demo');
    assert.equal(data.trace['schema'], 'zelto-trace/1');
    assert.equal(data.trace['sliceId'], SLICE_ID);
    assert.equal(data.trace['signId'], `sign-${SLICE_ID}-1`);
    assert.ok(data.body.includes('<!-- zelto-trace'));
  });

  // ─── D12：没签字不许开 PR ──────────────────────────────────────────────

  it('--open refuses a slice that is not signed', async () => {
    // 把签字请求改成 rejected —— 于是没有 approved 的请求
    const lockPath = join(TEST_DIR, '.zelto', 'locks', `sign-${SLICE_ID}-1.json`);
    const raw = JSON.parse(await readFile(lockPath, 'utf-8')) as Record<string, unknown>;
    raw['status'] = 'rejected';
    await writeFile(lockPath, JSON.stringify(raw, null, 2), 'utf-8');

    // 事件流里的 sign.approved 也得去掉 —— 追溯块引的是事件
    const eventPath = join(TEST_DIR, '.zelto', 'events', SLICE_ID, 'events.jsonl');
    await rm(eventPath, { force: true });

    const result = zelto('forge', 'pr', SLICE_ID, '--open');
    assert.equal(result.status, 1, 'unsigned slice must not be able to open a PR');
    assert.ok(
      result.stderr.includes('还没有签字'),
      `Expected "还没有签字", got: ${result.stderr}`,
    );
  });

  it('the preview still works for an unsigned slice', async () => {
    const lockPath = join(TEST_DIR, '.zelto', 'locks', `sign-${SLICE_ID}-1.json`);
    const raw = JSON.parse(await readFile(lockPath, 'utf-8')) as Record<string, unknown>;
    raw['status'] = 'rejected';
    await writeFile(lockPath, JSON.stringify(raw, null, 2), 'utf-8');

    const result = zelto('forge', 'pr', SLICE_ID);
    assert.equal(result.status, 0, `preview should work: ${result.stderr}`);
  });

  // ─── 错误路径 ──────────────────────────────────────────────────────────

  it('forge pr on an unknown slice is an error', () => {
    const result = zelto('forge', 'pr', 'no-such-slice');
    assert.equal(result.status, 1);
    assert.ok(
      result.stderr.includes('NOT_FOUND'),
      `Expected NOT_FOUND, got: ${result.stderr}`,
    );
  });

  it('forge without a subcommand is a usage error', () => {
    const result = zelto('forge');
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('USAGE'), `Expected USAGE, got: ${result.stderr}`);
  });
});
