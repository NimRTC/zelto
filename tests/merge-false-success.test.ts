// D-11：合并的**假成功**。
//
// 实测（漂移探查）：`zelto merge <已签字的切片>` 在目标工作区有未提交改动时，
// 合并**一步都没做**，但工具打印：
//
//     ⚠️  目标工作区有未提交改动，已跳过自动合并。
//     ✅ Merge complete (1 phases, 0 slices)
//
// 并以退出码 0 结束 —— **工具报告成功，而产物根本没进目标分支**。
// 更糟的是 `--push` 会跟着跑，推的是一条没变的分支。
//
// 根因：工作区脏的守卫返回 `aborted: false`（`aborted` 当时只表示「冲突」），
// 上层看到 `aborted === false` 就当作合并完成。
//
// 这个测试守住：**合并没发生，就不能说成功，也不能退出 0。**

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';

const TEST_DIR = join(tmpdir(), `zelto-merge-false-success-${Date.now()}`);
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

describe('D-11：合并的假成功', () => {
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

  it('工作区脏时合并不发生 → 不能报「✅ Merge complete」', async () => {
    await writeSlice('dirty-workspace-slice');
    await writeApprovedSign('dirty-workspace-slice');
    git('branch', 'slice/dirty-workspace-slice');

    // 造一个未提交改动 —— 工作区脏的守卫会挡住合并
    await writeFile(join(TEST_DIR, 'src', 'feature.ts'), 'export const x = 2;\n', 'utf-8');

    const { stdout, stderr, code } = await runCommand('merge', 'dirty-workspace-slice');
    const out = stdout + stderr;

    assert.notEqual(code, 0, `合并没发生就不该退出 0，实际输出：${out}`);
    assert.ok(
      !out.includes('✅ Merge complete'),
      `合并没发生时不能打印「Merge complete」，实际输出：${out}`,
    );
  });

  it('工作区脏时给出的中止原因指向「未提交改动」', async () => {
    const { stdout, stderr } = await runCommand('merge', 'dirty-workspace-slice');
    const out = stdout + stderr;
    assert.ok(
      out.includes('未提交改动') || out.includes('aborted'),
      `中止原因应指向未提交改动，实际输出：${out}`,
    );
  });

  it('工作区干净时合并正常完成并报 ✅', async () => {
    // 先把上一步的脏改动提交掉
    git('add', '-A');
    git('commit', '-m', 'commit dirty change');

    // 造一个带产物的分支。
    //
    // 注意顺序：`.zelto/slices/*.json` 是**未跟踪文件**，
    // `git checkout` 切分支时不会保留它 —— 所以切片状态文件必须在
    // 切回 main **之后**再写，否则会被切走。
    git('checkout', '-b', 'slice/clean-workspace-slice');
    await writeFile(join(TEST_DIR, 'src', 'feature.ts'), 'export const x = 3;\n', 'utf-8');
    git('add', '-A');
    git('commit', '-m', 'feat: slice work');
    git('checkout', 'main');

    await writeSlice('clean-workspace-slice');
    await writeApprovedSign('clean-workspace-slice');

    const { stdout, stderr, code } = await runCommand('merge', 'clean-workspace-slice');
    const output = stdout + stderr;

    assert.equal(code, 0, `工作区干净时合并应成功，实际输出：${output}`);
    assert.ok(output.includes('✅ Merge complete'), `实际输出：${output}`);
  });

  it('缺分支的切片合并失败并点名（D-11 的另一半）', async () => {
    await writeSlice('no-branch-at-all');
    await writeApprovedSign('no-branch-at-all');

    const { stdout, stderr, code } = await runCommand('merge', 'no-branch-at-all');
    const out = stdout + stderr;

    assert.notEqual(code, 0, `缺分支时不该成功，实际输出：${out}`);
    assert.ok(
      out.includes('no-branch-at-all'),
      `应点名是哪个切片缺分支，实际输出：${out}`,
    );
    assert.ok(
      !out.includes('✅ Merge complete'),
      `实际输出：${out}`,
    );
  });
});
