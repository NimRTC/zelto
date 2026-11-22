// Acceptance test: sign-revise-command
//
// 跑的是 `dist/cli/index.js` 这个**真实 CLI 进程**（不是 dist-test/ 里的产物），
// 验的是「命令接上去之后是不是真的能用」——
// 参数解析、退出码、事件落盘、状态转移、约束包内容，这些单元测试覆盖不到。
//
// 与单元测试（tests/core/review/human-feedback.test.ts）的分工：
//   单元测试验「core 里的判定逻辑对不对」
//   这里验「命令接上去之后行为对不对」
//
// 真 Git 仓库是必要的 —— 约束包的组装要读切片文件与事件流。

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
  `zelto-accept-sign-revise-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

const SLICE_ID = 'revise-demo';

interface SliceFile {
  id: string;
  title: string;
  state: string;
  spec: { path: string; frozenHash: string | null };
  writes: string[];
}

async function readSlice(id: string): Promise<SliceFile> {
  const raw = await readFile(join(TEST_DIR, '.zelto', 'slices', `${id}.json`), 'utf-8');
  return JSON.parse(raw) as SliceFile;
}

async function readEvents(id: string): Promise<Array<{ type: string; payload: Record<string, unknown> }>> {
  const path = join(TEST_DIR, '.zelto', 'events', id, 'events.jsonl');
  // 事件文件可能**根本不存在** —— 那意味着一个事件都没写。
  // 「什么都没发生」是一个合法的观测结果，不是错误。
  if (!existsSync(path)) return [];
  const raw = await readFile(path, 'utf-8');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
}

/**
 * 造一个「已过门禁、待签字」的切片。
 *
 * 直接写切片文件与签字请求文件 —— 走完整的 create→freeze→run→gate
 * 流程太重，而这里要验的是**签字门的动作**，不是门禁本身。
 */
async function seedCompletedSlice(id: string): Promise<void> {
  const sliceDir = join(TEST_DIR, '.zelto', 'slices');
  const lockDir = join(TEST_DIR, '.zelto', 'locks');
  await mkdir(sliceDir, { recursive: true });
  await mkdir(lockDir, { recursive: true });

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

  await writeFile(
    join(lockDir, `sign-${id}-1.json`),
    JSON.stringify(
      {
        id: `sign-${id}-1`,
        sliceId: id,
        requestedAt: now,
        requestedBy: 'zelto',
        status: 'pending',
        decidedAt: null,
        decidedBy: null,
        comment: null,
      },
      null,
      2,
    ),
    'utf-8',
  );
}

describe('zelto sign --revise (acceptance)', { concurrency: false }, () => {
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
    await seedCompletedSlice(SLICE_ID);
  });

  // ─── 基本动作 ────────────────────────────────────────────────────────────

  it('sign --revise without a comment is rejected', () => {
    const result = zelto('sign', SLICE_ID, '--revise');
    assert.equal(result.status, 1, 'revise without comment should exit 1');
    assert.ok(
      result.stderr.includes('必须带意见'),
      `Expected "必须带意见", got: ${result.stderr}`,
    );
  });

  it('sign --revise sends the slice back to frozen', async () => {
    const result = zelto('sign', SLICE_ID, '--revise', '--comment', '3 号那个 null 处理不对');
    assert.equal(result.status, 0, `revise should exit 0: ${result.stderr}`);

    const slice = await readSlice(SLICE_ID);
    assert.equal(slice.state, 'frozen', 'completed → frozen');
  });

  it('sign --revise records a sign.revised event with the comment', async () => {
    zelto('sign', SLICE_ID, '--revise', '--comment', '3 号那个 null 处理不对');

    const events = await readEvents(SLICE_ID);
    const revised = events.find((e) => e.type === 'sign.revised');
    assert.ok(revised, 'a sign.revised event should exist');
    assert.equal(revised.payload.comment, '3 号那个 null 处理不对');
  });

  it('sign --revise does NOT abandon the slice', async () => {
    zelto('sign', SLICE_ID, '--revise', '--comment', '细节要改');
    const slice = await readSlice(SLICE_ID);
    assert.notEqual(slice.state, 'abandoned', 'revise is not a terminal rejection');
  });

  it('sign --revise does not start a run — starting is an explicit action', async () => {
    zelto('sign', SLICE_ID, '--revise', '--comment', '细节要改');
    const slice = await readSlice(SLICE_ID);
    assert.equal(slice.state, 'frozen', 'must stay frozen, not running');
  });

  it('sign --revise without a sign request is an error', async () => {
    await rm(join(TEST_DIR, '.zelto', 'locks'), { recursive: true, force: true });
    const result = zelto('sign', SLICE_ID, '--revise', '--comment', '细节要改');
    assert.equal(result.status, 1, 'no sign request should exit 1');
    assert.ok(
      result.stderr.includes('No sign request to revise'),
      `Expected "No sign request to revise", got: ${result.stderr}`,
    );
  });

  // ─── 静默失败回归（D-19）─────────────────────────────────────────────
  //
  // 病灶：`sign --revise` 在切片**不是 completed** 时，状态转移会失败。
  // 原来的实现把这个失败 `catch {}` 吞掉，于是：
  //   签字请求被消耗（pending → revised）+ 切片状态没变 + 人看到
  //   「已退回重跑，下一步 zelto run」。
  //
  // 人照着提示跑 → 跑不了（draft 片不能跑）+ 签字请求已用掉。
  // **静默失败 + 误导提示。**

  it('sign --revise on a non-completed slice fails and changes nothing', async () => {
    // 把切片改成 draft
    const slice = await readSlice(SLICE_ID);
    slice.state = 'draft';
    await writeFile(
      join(TEST_DIR, '.zelto', 'slices', `${SLICE_ID}.json`),
      JSON.stringify(slice, null, 2),
      'utf-8',
    );

    const result = zelto('sign', SLICE_ID, '--revise', '--comment', '细节要改');
    assert.equal(result.status, 1, 'a draft slice must not be silently "revised"');
    assert.ok(
      result.stderr.includes('退回重跑失败'),
      `Expected a failure message, got: ${result.stderr}`,
    );
    assert.ok(
      result.stderr.includes('没有退回'),
      `Expected "没有退回", got: ${result.stderr}`,
    );
  });

  it('a failed sign --revise leaves the sign request usable', async () => {
    const slice = await readSlice(SLICE_ID);
    slice.state = 'draft';
    await writeFile(
      join(TEST_DIR, '.zelto', 'slices', `${SLICE_ID}.json`),
      JSON.stringify(slice, null, 2),
      'utf-8',
    );

    zelto('sign', SLICE_ID, '--revise', '--comment', '细节要改');

    // 关键：签字请求**没被消耗** —— 否则人得重新走一遍签字流程
    const raw = JSON.parse(
      await readFile(join(TEST_DIR, '.zelto', 'locks', `sign-${SLICE_ID}-1.json`), 'utf-8'),
    ) as { status: string };
    assert.equal(raw.status, 'pending', 'the sign request must remain pending');
  });

  it('a failed sign --revise writes no sign.revised event', async () => {
    const slice = await readSlice(SLICE_ID);
    slice.state = 'draft';
    await writeFile(
      join(TEST_DIR, '.zelto', 'slices', `${SLICE_ID}.json`),
      JSON.stringify(slice, null, 2),
      'utf-8',
    );

    zelto('sign', SLICE_ID, '--revise', '--comment', '细节要改');

    const events = await readEvents(SLICE_ID);
    assert.ok(
      !events.some((e) => e.type === 'sign.revised'),
      'a failed revise must not leave a sign.revised event',
    );
  });

  it('sign --revise --json reports the action', () => {
    const result = zelto('sign', SLICE_ID, '--revise', '--comment', '细节要改', '--json');
    assert.equal(result.status, 0, `revise should exit 0: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout) as { action?: string };
    assert.equal(parsed.action, 'revised');
  });

  // ─── D11：作废已批准 ────────────────────────────────────────────────────

  it('sign --revise voids an existing approval so the slice cannot be merged', async () => {
    // 先批准
    const approve = zelto('sign', SLICE_ID, '--approve', '--force');
    assert.equal(approve.status, 0, `approve should exit 0: ${approve.stderr}`);

    // 再退回 —— 这一步是**签了字又发现问题**的场景，
    // 那时已经没有 pending 请求了，所以退回必须能处理 approved 状态。
    const revise = zelto('sign', SLICE_ID, '--revise', '--comment', '还是有问题');
    assert.equal(revise.status, 0, `revise should exit 0: ${revise.stderr}`);

    // 关键：approved 的签字请求不能还在 —— 否则 merge 照样会收它
    const locks = join(TEST_DIR, '.zelto', 'locks');
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(locks);
    const statuses: string[] = [];
    for (const f of files) {
      const raw = JSON.parse(await readFile(join(locks, f), 'utf-8')) as { status: string };
      statuses.push(raw.status);
    }
    assert.ok(
      !statuses.includes('approved'),
      `no approved sign may remain, got ${statuses}`,
    );
    assert.ok(
      statuses.includes('revised'),
      `the request must be marked revised, got ${statuses}`,
    );
  });

  it('sign --revise says it voided the approval', () => {
    zelto('sign', SLICE_ID, '--approve', '--force');
    const result = zelto('sign', SLICE_ID, '--revise', '--comment', '还是有问题');
    assert.ok(
      result.stdout.includes('批准已作废'),
      `Expected the approval void to be announced, got: ${result.stdout}`,
    );
  });

  // ─── 意见进下一轮的上下文 ────────────────────────────────────────────────

  it('the reviewer comment reaches the next run constraint bundle', async () => {
    const comment = 'parseInput 的 null 处理不对，注意边界';
    zelto('sign', SLICE_ID, '--revise', '--comment', comment);

    // 约束包是 zelto 给 agent 的唯一上下文入口 —— 意见必须在那里。
    const bundle = await import('node:fs/promises').then((fs) =>
      fs.readFile(join(TEST_DIR, '.zelto', `${SLICE_ID}-bundle.json`), 'utf-8'),
    ).catch(() => null);

    // 没有跑过 run 就没有 bundle —— 那就只验事件流里有原文
    if (bundle !== null) {
      assert.ok(bundle.includes(comment), 'the comment must reach the bundle verbatim');
      assert.ok(bundle.includes('Human feedback'), 'the bundle must label the feedback');
    }

    const events = await readEvents(SLICE_ID);
    const revised = events.find((e) => e.type === 'sign.revised');
    assert.equal(revised?.payload.comment, comment);
  });
});

// ─── spec revise（退回上游）──────────────────────────────────────────────────

describe('zelto spec revise (acceptance)', { concurrency: false }, () => {
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
    await seedCompletedSlice(SLICE_ID);
  });

  it('spec revise without a comment is rejected', () => {
    const result = zelto('spec', 'revise', SLICE_ID);
    assert.equal(result.status, 1, 'revise without comment should exit 1');
    assert.ok(
      result.stderr.includes('必须带意见'),
      `Expected "必须带意见", got: ${result.stderr}`,
    );
  });

  it('spec revise sends the slice back to draft', async () => {
    const result = zelto('spec', 'revise', SLICE_ID, '--comment', '方向不对');
    assert.equal(result.status, 0, `spec revise should exit 0: ${result.stderr}`);

    const slice = await readSlice(SLICE_ID);
    assert.equal(slice.state, 'draft', 'completed → draft (the spec must change)');
  });

  it('spec revise records a sign.returned event', async () => {
    zelto('spec', 'revise', SLICE_ID, '--comment', '方向不对');

    const events = await readEvents(SLICE_ID);
    const returned = events.find((e) => e.type === 'sign.returned');
    assert.ok(returned, 'a sign.returned event should exist');
    assert.equal(returned.payload.comment, '方向不对');
  });

  it('spec revise refuses a slice that is not completed', async () => {
    // 把切片改成 draft
    const slice = await readSlice(SLICE_ID);
    slice.state = 'draft';
    await writeFile(
      join(TEST_DIR, '.zelto', 'slices', `${SLICE_ID}.json`),
      JSON.stringify(slice, null, 2),
      'utf-8',
    );

    const result = zelto('spec', 'revise', SLICE_ID, '--comment', '方向不对');
    assert.equal(result.status, 1, 'a draft slice cannot be sent upstream');
    assert.ok(
      result.stderr.includes('BAD_STATE') || result.stderr.includes('只有 completed'),
      `Expected a state error, got: ${result.stderr}`,
    );
  });

  it('a refused spec revise leaves the sign request usable', async () => {
    const slice = await readSlice(SLICE_ID);
    slice.state = 'draft';
    await writeFile(
      join(TEST_DIR, '.zelto', 'slices', `${SLICE_ID}.json`),
      JSON.stringify(slice, null, 2),
      'utf-8',
    );

    zelto('spec', 'revise', SLICE_ID, '--comment', '方向不对');

    const raw = JSON.parse(
      await readFile(join(TEST_DIR, '.zelto', 'locks', `sign-${SLICE_ID}-1.json`), 'utf-8'),
    ) as { status: string };
    assert.equal(raw.status, 'pending', 'the sign request must remain pending');
  });
});
