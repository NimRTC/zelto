/**
 * 回归测试：`next` / `suggest` 不得推荐早已签过字的切片。
 *
 * 背景（ADR-018）：签字不改切片状态 —— SIGN_APPROVE 停在 `completed`。
 * 于是 `completed` 同时表示「门禁②过了」与「人已经签了」，光看状态分不出。
 * 修复前 `zelto next` 会叫人去签三周前就签过的切片，`zelto suggest` 会把
 * 上百条历史切片全列出来。
 *
 * 判据改为取签字请求的状态（`.zelto/locks/sign-*.json`），与 `inbox`/`merge` 同源。
 *
 * 这些用例跑真实 CLI 进程（dist/cli/index.js），所以必须先 `npm run build`。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_DIR = join(tmpdir(), `zelto-next-suggest-${Date.now()}`);
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');

function runCli(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI_SCRIPT, ...args], {
      cwd: TEST_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }));
    child.on('error', reject);
  });
}

/** 写一个已完成的切片（状态 completed） */
async function writeSlice(id: string, title: string): Promise<void> {
  const now = new Date().toISOString();
  const slice = {
    id,
    title,
    state: 'completed',
    spec: { path: `specs/slices/${id}.md`, frozenHash: null, frozenAt: null },
    acceptance: { dir: `tests/acceptance/${id}`, frozenHash: null, oracleSrc: null },
    baseCommit: null,
    drift: { detected: false, reason: null, at: null },
    trace: { requirements: [], contracts: [], tests: [] },
    traceWaiver: null,
    baseline: false,
    writes: [],
    runs: [],
    stall: { class: null, reason: null, detectedAt: null, resumeCount: 0 },
    createdAt: now,
    updatedAt: now,
  };
  await writeFile(join(TEST_DIR, '.zelto', 'slices', `${id}.json`), JSON.stringify(slice, null, 2));
}

/** 写一条签字请求 */
async function writeSignRequest(
  sliceId: string,
  status: 'pending' | 'approved' | 'rejected' | 'revoked',
  requestedAt: string,
): Promise<void> {
  const req = {
    id: `sign-${sliceId}-${Date.now()}`,
    sliceId,
    requestedAt,
    requestedBy: 'zelto',
    status,
    decidedAt: status === 'pending' ? null : requestedAt,
    decidedBy: status === 'pending' ? null : 'human',
    comment: null,
  };
  await writeFile(
    join(TEST_DIR, '.zelto', 'locks', `${req.id}.json`),
    JSON.stringify(req, null, 2),
  );
}

before(async () => {
  await mkdir(join(TEST_DIR, '.zelto', 'slices'), { recursive: true });
  await mkdir(join(TEST_DIR, '.zelto', 'locks'), { recursive: true });
  await mkdir(join(TEST_DIR, '.zelto', 'events'), { recursive: true });
});

after(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe('next / suggest 的待办判据', () => {
  it('已签字的切片不该被推荐签字', async () => {
    await writeSlice('signed-old', '早就签过的切片');
    await writeSignRequest('signed-old', 'approved', '2026-10-01T00:00:00.000Z');

    const next = await runCli('next');
    assert.equal(next.code, 0);
    assert.ok(
      !next.stdout.includes('signed-old'),
      `next 不该提到已签字的切片，实际输出：\n${next.stdout}`,
    );

    const suggest = await runCli('suggest');
    assert.equal(suggest.code, 0);
    assert.ok(
      !suggest.stdout.includes('signed-old'),
      `suggest 不该提到已签字的切片，实际输出：\n${suggest.stdout}`,
    );
  });

  it('待签字的切片该被推荐，且给出签字命令', async () => {
    await writeSlice('awaiting-sign', '等着人签字的切片');
    await writeSignRequest('awaiting-sign', 'pending', '2026-11-01T00:00:00.000Z');

    const next = await runCli('next');
    assert.equal(next.code, 0);
    assert.ok(next.stdout.includes('awaiting-sign'), `next 应提到待签字切片：\n${next.stdout}`);
    assert.ok(
      next.stdout.includes('zelto sign awaiting-sign --approve'),
      `next 应给出签字命令：\n${next.stdout}`,
    );

    const suggest = await runCli('suggest');
    assert.ok(suggest.stdout.includes('awaiting-sign'), `suggest 应提到待签字切片：\n${suggest.stdout}`);
  });

  it('没有签字请求的历史切片不该被报成待办', async () => {
    // 接管既有项目时 `project scan` 生成的基线切片：状态 completed，
    // 但既没有签字请求也没有分支 —— 产物早就在主干上了，没东西可签。
    await writeSlice('legacy-baseline', '接管项目时的基线切片');

    const next = await runCli('next');
    assert.ok(
      !next.stdout.includes('legacy-baseline'),
      `next 不该把无签字请求的历史切片报成待办：\n${next.stdout}`,
    );
  });

  it('待办排序：先签字，再合并', async () => {
    const next = await runCli('next');
    assert.ok(next.stdout.includes('awaiting-sign'), `待签字切片应排在最前：\n${next.stdout}`);
  });
});
