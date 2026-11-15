// 合并的两条路径之间是否判据漂移。
//
// 背景（ADR-059 §6 遗留项）：`zelto merge` 有两条路径 ——
//   不带 id → `collectMergeCandidates()`（按签字状态 + 分支状态筛）
//   带 id   → 直接读切片状态文件
//
// ADR-059 给「带 id」那条补了签字门，但两条路径的**其余判据**仍是两套独立逻辑。
// 漏判往往发生在闸门之间 —— 这个测试就是去找那几条缝。
//
// 每条用例都用真实 git 仓库 + 真实 CLI 进程，因为这些判据都依赖 git 的真实状态。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';

const TEST_DIR = join(tmpdir(), `zelto-merge-drift-${Date.now()}`);
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: TEST_DIR,
    encoding: 'utf-8',
    timeout: 20_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runCommand(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI_SCRIPT, ...args], {
      cwd: TEST_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    child.on('error', reject);
  });
}

async function writeSlice(id: string): Promise<void> {
  const now = new Date().toISOString();
  const slice = {
    id,
    title: `Slice ${id}`,
    state: 'completed',
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

describe('合并的两条路径 —— 判据漂移探查', () => {
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

  it('漂移 1：已签字但分支不存在的切片 —— 不带 id 的路径应跳过', async () => {
    await writeSlice('no-branch-slice');
    await writeApprovedSign('no-branch-slice');

    const all = await runCommand('merge');
    const allOut = all.stdout + all.stderr;

    assert.ok(
      allOut.includes('没有待合并的切片'),
      `不带 id 的路径应因分支不存在而跳过该切片，实际：${allOut}`,
    );
    assert.ok(
      !allOut.includes('no-branch-slice'),
      `分支不存在的切片不该被列进待合并，实际：${allOut}`,
    );
  });

  it('漂移 1b：带 id 的路径对「分支不存在」要有明确处置（不能静默成功）', async () => {
    await writeSlice('silent-no-branch');
    await writeApprovedSign('silent-no-branch');

    const { stdout, stderr, code } = await runCommand('merge', 'silent-no-branch');
    const out = stdout + stderr;

    // 分支不存在 → 合并无从下手，不能静默成功
    assert.notEqual(code, 0, `分支不存在时不该成功，实际输出：${out}`);
    assert.ok(
      !out.includes('没有已批准的签字'),
      `它已签字，不该被签字门拦下，实际输出：${out}`,
    );
  });

  it('漂移 2：已签字但已合入目标的切片 —— 不带 id 的路径应跳过', async () => {
    await writeSlice('already-merged-slice');
    await writeApprovedSign('already-merged-slice');
    git('branch', 'slice/already-merged-slice');

    const all = await runCommand('merge');
    const allOut = all.stdout + all.stderr;
    assert.ok(
      allOut.includes('没有待合并的切片'),
      `已合入目标的切片不该出现在待合并清单里，实际：${allOut}`,
    );
    assert.ok(
      !allOut.includes('already-merged-slice'),
      `已合入目标的切片不该被列进待合并，实际：${allOut}`,
    );
  });

  it('漂移 3：两条路径的签字判据一致（都只认 approved）', async () => {
    await writeSlice('pending-only-slice');
    const now = new Date().toISOString();
    const req = {
      id: `sign-pending-only-slice-${Date.now()}`,
      sliceId: 'pending-only-slice',
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

    const all = await runCommand('merge');
    const allOut = all.stdout + all.stderr;
    const explicit = await runCommand('merge', 'pending-only-slice');
    const explicitOut = explicit.stdout + explicit.stderr;

    assert.ok(
      !allOut.includes('pending-only-slice'),
      `pending 签字不该进待合并清单，实际：${allOut}`,
    );
    assert.ok(
      explicitOut.includes('没有已批准的签字'),
      `pending 签字应被带 id 的路径拒绝，实际：${explicitOut}`,
    );
  });

  it('漂移 4：revoked 的签字 —— 两条路径都不该放行', async () => {
    await writeSlice('revoked-only-slice');
    const now = new Date().toISOString();
    const req = {
      id: `sign-revoked-only-slice-${Date.now()}`,
      sliceId: 'revoked-only-slice',
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

    const all = await runCommand('merge');
    const allOut = all.stdout + all.stderr;
    assert.ok(
      !allOut.includes('revoked-only-slice'),
      `revoked 的签字不该进待合并清单，实际：${allOut}`,
    );

    const explicit = await runCommand('merge', 'revoked-only-slice');
    const explicitOut = explicit.stdout + explicit.stderr;
    assert.ok(
      explicitOut.includes('没有已批准的签字'),
      `revoked 的签字应被带 id 的路径拒绝，实际：${explicitOut}`,
    );
  });
});
