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
  await writeSliceWithState(id, title, 'completed');
}

/**
 * 写一个指定状态的切片。
 *
 * 退回报错之后切片要回到 `frozen`（退回重跑）或 `draft`（退回上游）——
 * 那两个状态不是 `completed`，所以要能单独写。
 */
async function writeSliceWithState(id: string, title: string, state: string): Promise<void> {
  const now = new Date().toISOString();
  const slice = {
    id,
    title,
    state,
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
  status: 'pending' | 'approved' | 'rejected' | 'revoked' | 'revised' | 'returned',
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

  it('退回重跑的切片该出现在 next 里，并给出重跑命令', async () => {
    await writeSliceWithState('sent-back', '被退回重跑的切片', 'frozen');
    await writeSignRequest('sent-back', 'revised', '2026-11-02T00:00:00.000Z');

    const next = await runCli('next');
    assert.equal(next.code, 0);
    assert.ok(
      next.stdout.includes('sent-back'),
      `next 应提到被退回的切片，实际输出：\n${next.stdout}`,
    );
    assert.ok(
      next.stdout.includes('zelto run sent-back'),
      `next 应给出重跑命令，实际输出：\n${next.stdout}`,
    );
  });

  it('退回上游的切片该出现在 next 里，并指向改规格', async () => {
    await writeSliceWithState('returned-up', '被退回上游的切片', 'draft');
    await writeSignRequest('returned-up', 'returned', '2026-11-02T00:00:00.000Z');

    const next = await runCli('next');
    assert.equal(next.code, 0);
    assert.ok(
      next.stdout.includes('returned-up'),
      `next 应提到被退回上游的切片，实际输出：\n${next.stdout}`,
    );
    assert.ok(
      next.stdout.includes('zelto check returned-up'),
      `退回上游的下一步是改规格，实际输出：\n${next.stdout}`,
    );
  });

  it('退回的切片在 suggest 里该有专门的一段', async () => {
    const suggest = await runCli('suggest');
    assert.equal(suggest.code, 0);
    assert.ok(
      suggest.stdout.includes('Sent Back For Rework'),
      `suggest 应有「Sent Back For Rework」段，实际输出：\n${suggest.stdout}`,
    );
  });

  it('suggest 不该把被退回的切片重复列两次', async () => {
    const suggest = await runCli('suggest');
    const occurrences = suggest.stdout.split('sent-back').length - 1;
    assert.ok(
      occurrences <= 2,
      `suggest 里 sent-back 出现了 ${occurrences} 次（切片名 + 动作行算 2 次），不该按状态再列一遍：\n${suggest.stdout}`,
    );
  });

  it('状态与签字请求对不上时，不该报成待重跑', async () => {
    // 退完之后人又跑了（状态回到 running）—— 中间有人动过，
    // 不该在这里报「待重跑」，交给别的分支处理。
    await writeSliceWithState('moved-on', '退完又跑了的切片', 'running');
    await writeSignRequest('moved-on', 'revised', '2026-11-02T00:00:00.000Z');

    const next = await runCli('next');
    assert.ok(
      !next.stdout.includes('moved-on'),
      `状态对不上的切片不该报成待重跑，实际输出：\n${next.stdout}`,
    );
  });

  it('待重跑排在待签字前面（人刚说要改的片最该先做）', async () => {
    const next = await runCli('next');
    assert.ok(
      next.stdout.includes('sent-back'),
      `待重跑应排在最前（待签字的片还在队列里）：\n${next.stdout}`,
    );
    assert.ok(
      !next.stdout.includes('awaiting-sign'),
      `待重跑存在时不该先报待签字，实际输出：\n${next.stdout}`,
    );
  });
});
