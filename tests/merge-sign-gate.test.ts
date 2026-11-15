// ADR-018 §3.1：签字门 —— 合并必须要求已批准的签字。
//
// 实测缺陷 D-6：显式给 id 的合并路径（`zelto merge <id>`）是直连的，
// 只要切片存在就往下走。实测中 `zelto merge <id> --plan <plan-id>`
// 在切片尚未签字时直接提交并合并了。
//
// 本测试守住两件事：
//   1. 未签字 → 拒绝合并（退出码非 0）
//   2. 已签字 → 合并路径能走通（不被新判据误伤）
//
// 注意：合并路径要求 git 仓库与 slice 分支。这里用一个最小 git 仓库 +
// 手工造的切片状态文件 + 手工造的签字请求文件，绕开 agent 执行。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';

const TEST_DIR = join(tmpdir(), `zelto-merge-sign-gate-test-${Date.now()}`);
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: TEST_DIR,
    encoding: 'utf-8',
    timeout: 20_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runCommand(...args: string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI_SCRIPT, ...args], {
      cwd: TEST_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => resolve({ stdout: stdout || stderr, code: code ?? 1 }));
    child.on('error', reject);
  });
}

/** 造一个处于 frozen 状态的切片状态文件 */
async function writeSlice(id: string): Promise<void> {
  const now = new Date().toISOString();
  const slice = {
    id,
    title: `Slice ${id}`,
    state: 'frozen',
    spec: { path: `specs/slices/${id}.md`, frozenHash: 'hash', frozenAt: now },
    acceptance: { dir: `tests/acceptance/${id}/`, frozenHash: null, oracleSrc: null },
    baseCommit: null,
    drift: { detected: false, reason: null, at: null },
    trace: { requirements: [], contracts: [], tests: [] },
    traceWaiver: null,
    baseline: false,
    writes: ['src/feature.ts'],
    runs: [],
    stall: { class: null, autoResolved: 0, gateRetries: 0 },
    createdAt: now,
    updatedAt: now,
  };
  await writeFile(
    join(TEST_DIR, '.zelto', 'slices', `${id}.json`),
    JSON.stringify(slice, null, 2),
    'utf-8',
  );
}

/** 造一个已批准的签字请求 */
async function writeApprovedSign(sliceId: string): Promise<void> {
  const now = new Date().toISOString();
  const req = {
    id: `sign-${sliceId}-${Date.now()}`,
    sliceId,
    requestedAt: now,
    requestedBy: 'human',
    status: 'approved',
    decidedAt: now,
    decidedBy: 'human',
    comment: null,
  };
  await writeFile(
    join(TEST_DIR, '.zelto', 'locks', `${req.id}.json`),
    JSON.stringify(req, null, 2),
    'utf-8',
  );
}

describe('zelto merge —— 签字门（ADR-018）', () => {
  before(async () => {
    await mkdir(join(TEST_DIR, '.zelto', 'slices'), { recursive: true });
    await mkdir(join(TEST_DIR, '.zelto', 'events'), { recursive: true });
    await mkdir(join(TEST_DIR, '.zelto', 'locks'), { recursive: true });
    await mkdir(join(TEST_DIR, 'specs', 'slices'), { recursive: true });
    await mkdir(join(TEST_DIR, 'policy'), { recursive: true });
    await mkdir(join(TEST_DIR, 'src'), { recursive: true });

    await writeFile(join(TEST_DIR, 'src', 'feature.ts'), 'export const x = 1;\n', 'utf-8');

    git('init', '-b', 'main');
    git('config', 'user.email', 'test@zelto.local');
    git('config', 'user.name', 'zelto test');
    git('add', '-A');
    git('commit', '-m', 'init');
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('未签字的切片不能合并（D-6 回归）', async () => {
    await writeSlice('unsigned-slice');

    const { stdout, code } = await runCommand('merge', 'unsigned-slice');
    assert.notEqual(code, 0, '未签字的切片必须被拒绝合并');
    assert.ok(
      stdout.includes('没有已批准的签字'),
      `错误信息应指出缺签字，实际输出：${stdout}`,
    );
    assert.ok(stdout.includes('unsigned-slice'), '错误信息应点名是哪一片未签字');
  });

  it('未签字的切片即使带 --plan 也被拒绝（D-6 回归）', async () => {
    await writeSlice('unsigned-plan-slice');

    const { stdout, code } = await runCommand('merge', 'unsigned-plan-slice', '--plan', 'plan-1');
    assert.notEqual(code, 0, '--plan 不得绕过签字门');
    assert.ok(stdout.includes('没有已批准的签字'), `实际输出：${stdout}`);
  });

  it('未签字的切片即使带 --dry-run 也被拒绝（判据在 dry-run 之前）', async () => {
    await writeSlice('unsigned-dryrun-slice');

    const { stdout, code } = await runCommand('merge', 'unsigned-dryrun-slice', '--dry-run');
    assert.notEqual(code, 0, '--dry-run 也应先过签字门');
    assert.ok(stdout.includes('没有已批准的签字'), `实际输出：${stdout}`);
  });

  it('已签字的切片通过签字门（不被误伤）', async () => {
    await writeSlice('signed-slice');
    await writeApprovedSign('signed-slice');

    // 判据在签字门：已签字的切片不该被拦下。
    // --dry-run 不触碰分支，即使没有 slice/<id> 分支也能走完计划生成。
    const { stdout } = await runCommand('merge', 'signed-slice', '--dry-run');
    assert.ok(
      !stdout.includes('没有已批准的签字'),
      `已签字的切片不该被签字门拦下，实际输出：${stdout}`,
    );
  });

  it('批次里只要有一片未签字，整批都拒绝', async () => {
    await writeSlice('batch-signed');
    await writeApprovedSign('batch-signed');
    await writeSlice('batch-unsigned');

    const { stdout, code } = await runCommand('merge', 'batch-signed', 'batch-unsigned');
    assert.notEqual(code, 0, '批次含未签字切片时必须整批拒绝');
    assert.ok(stdout.includes('batch-unsigned'), '应点名未签字的那一片');
  });

  it('签字请求存在但状态是 pending 时仍拒绝', async () => {
    await writeSlice('pending-sign-slice');
    const now = new Date().toISOString();
    const req = {
      id: `sign-pending-sign-slice-${Date.now()}`,
      sliceId: 'pending-sign-slice',
      requestedAt: now,
      requestedBy: 'zelto',
      status: 'pending',
      decidedAt: null,
      decidedBy: null,
      comment: null,
    };
    await writeFile(
      join(TEST_DIR, '.zelto', 'locks', `${req.id}.json`),
      JSON.stringify(req, null, 2),
      'utf-8',
    );

    const { stdout, code } = await runCommand('merge', 'pending-sign-slice');
    assert.notEqual(code, 0, 'pending 的签字请求不算已批准');
    assert.ok(stdout.includes('没有已批准的签字'), `实际输出：${stdout}`);
  });

  it('revoked 的签字请求不算已批准', async () => {
    await writeSlice('revoked-sign-slice');
    const now = new Date().toISOString();
    const req = {
      id: `sign-revoked-sign-slice-${Date.now()}`,
      sliceId: 'revoked-sign-slice',
      requestedAt: now,
      requestedBy: 'human',
      status: 'revoked',
      decidedAt: now,
      decidedBy: 'human',
      comment: '签错了',
    };
    await writeFile(
      join(TEST_DIR, '.zelto', 'locks', `${req.id}.json`),
      JSON.stringify(req, null, 2),
      'utf-8',
    );

    const { stdout, code } = await runCommand('merge', 'revoked-sign-slice');
    assert.notEqual(code, 0, 'revoked 的签字不算已批准');
    assert.ok(stdout.includes('没有已批准的签字'), `实际输出：${stdout}`);
  });

  it('签字门判据只读文件，不写切片状态（签名门拒绝后状态不变）', async () => {
    await writeSlice('state-unchanged-slice');
    const before = JSON.parse(
      await readFile(join(TEST_DIR, '.zelto', 'slices', 'state-unchanged-slice.json'), 'utf-8'),
    );

    await runCommand('merge', 'state-unchanged-slice');

    const after = JSON.parse(
      await readFile(join(TEST_DIR, '.zelto', 'slices', 'state-unchanged-slice.json'), 'utf-8'),
    );
    assert.equal(after.state, before.state, '被签字门拒绝不应改动切片状态');
  });
});
