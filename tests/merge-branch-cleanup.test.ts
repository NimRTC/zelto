// D-40：合并后清理切片分支时的两个误判。
//
// 实测（nimrtc-zelto 靶子项目，第六轮端到端复验）：
// 切片 `v1-video-processing` 合并进 `version/v1` 之后，工具报
//
//     ℹ️  Could not delete branch "slice/v1-video-processing": not fully merged into version/v1.
//        The slice's work is merged elsewhere — delete manually if intended: git branch -D ...
//
// 但产物**就在** `version/v1` 里（`git merge-base --is-ancestor` 为真）。
// 两件事都不对：
//
//  1. **判据错**：用的是 `git branch -d <切片分支> <目标分支>`。这个形式的
//     「已合并」判据仍然是 **HEAD**（主仓当前分支），不是 A 与 B 的关系。
//     而主仓 HEAD 是 `main`，`version/v1` 的产物没进 `main` → 于是拒删。
//  2. **提示错**：说「已合到别处」（merged elsewhere），实际就合在目标分支里。
//     人照着这条提示去 `git branch -D`，等于放弃 git 的安全检查。
//
// 而且 `git branch -d A B` 会**同时删掉 A 和 B** —— 实测它把 `version/v1`
// 也放进了删除列表，只因为该分支正被版本 worktree 占用才没删成。
// 哪天那个 worktree 不在了，版本分支就会被误删。
//
// 修法（D-40）：判「已合入」用 `merge-base --is-ancestor <切片分支> <目标分支>`
// —— 目标分支不存在时用 HEAD；判定通过后才执行**单参数**的
// `git branch -d <切片分支>`，并且在**目标工作目录**里执行（让 git 自己的
// 判据也是「已并入这个目录的 HEAD」）。
//
// 这个测试守住三件事：
//   1. 目标分支已含切片产物时，切片分支被真正删掉；
//   2. **目标分支不被误删**（这是原来那个形式最危险的地方）；
//   3. 没合入目标分支时，如实说「还有未合入的内容」，且**不删**任何分支。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';

const TEST_DIR = join(tmpdir(), `zelto-merge-branch-cleanup-${Date.now()}`);
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: 20_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function branches(cwd: string): string[] {
  return git(cwd, 'branch', '--format=%(refname:short)')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
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

async function writeSlice(id: string, writes: string[] = ['src/feature.ts']): Promise<void> {
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
    writes,
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

/**
 * 写一份版本计划 —— 没有它，切片就不属于任何版本，
 * 归属解析会退回「合主干」，版本分支那条路径根本走不到（ADR-056 §3.2）。
 */
async function writeVersionPlan(
  label: string,
  sliceIds: string[],
  status: 'planned' | 'in_progress' = 'in_progress',
): Promise<void> {
  await mkdir(join(TEST_DIR, '.zelto', 'versions'), { recursive: true });
  const plan = {
    id: 'plan-test',
    designId: 'dsg-test',
    title: '测试计划',
    versions: [
      {
        version: label,
        dependsOn: [],
        description: '测试版本',
        slices: sliceIds.map((id) => ({
          id,
          module: 'm',
          title: id,
          writes: ['src/feature.ts'],
          specPath: `specs/slices/${id}.md`,
        })),
        integrationTestDir: `tests/acceptance/${label}/`,
        status,
        baseCommit: null,
      },
    ],
    status: 'confirmed',
    createdAt: new Date().toISOString(),
    confirmedAt: new Date().toISOString(),
  };
  await writeFile(
    join(TEST_DIR, '.zelto', 'versions', 'plan-test.json'),
    JSON.stringify(plan, null, 2),
    'utf-8',
  );
}

describe('D-40：合并后的切片分支清理', () => {
  before(async () => {
    await mkdir(join(TEST_DIR, '.zelto', 'slices'), { recursive: true });
    await mkdir(join(TEST_DIR, '.zelto', 'events'), { recursive: true });
    await mkdir(join(TEST_DIR, '.zelto', 'locks'), { recursive: true });
    await mkdir(join(TEST_DIR, 'specs', 'slices'), { recursive: true });
    await mkdir(join(TEST_DIR, 'policy'), { recursive: true });
    await mkdir(join(TEST_DIR, 'src'), { recursive: true });
    await writeFile(join(TEST_DIR, 'src', 'feature.ts'), 'export const x = 1;\n', 'utf-8');

    git(TEST_DIR, 'init', '-b', 'main');
    git(TEST_DIR, 'config', 'user.email', 'test@zelto.local');
    git(TEST_DIR, 'config', 'user.name', 'zelto test');
    git(TEST_DIR, 'add', '-A');
    git(TEST_DIR, 'commit', '-m', 'init');
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('合入主干的切片：分支被删掉，目标分支不受影响', async () => {
    git(TEST_DIR, 'checkout', '-b', 'slice/cleanup-main-slice');
    await writeFile(join(TEST_DIR, 'src', 'feature.ts'), 'export const x = 2;\n', 'utf-8');
    git(TEST_DIR, 'add', '-A');
    git(TEST_DIR, 'commit', '-m', 'feat: slice work');
    git(TEST_DIR, 'checkout', 'main');

    await writeSlice('cleanup-main-slice');
    await writeApprovedSign('cleanup-main-slice');

    const { stdout, stderr, code } = await runCommand('merge', 'cleanup-main-slice');
    const out = stdout + stderr;

    assert.equal(code, 0, `合并应成功，实际输出：${out}`);
    assert.ok(
      !branches(TEST_DIR).includes('slice/cleanup-main-slice'),
      `已合入的切片分支应被删掉，实际分支：${branches(TEST_DIR).join(', ')}`,
    );
    assert.ok(
      branches(TEST_DIR).includes('main'),
      `目标分支不该被误删，实际分支：${branches(TEST_DIR).join(', ')}`,
    );
  });

  it('合入版本分支的切片：切片分支被删掉，版本分支不被误删（D-40 的核心）', async () => {
    // ADR-056 的形态：版本分支 `version/vtest` + 版本工作目录
    git(TEST_DIR, 'branch', 'version/vtest');
    const versionDir = join(TEST_DIR, '.zelto', 'version-worktrees', 'vtest');
    await mkdir(versionDir, { recursive: true });
    git(TEST_DIR, 'worktree', 'add', versionDir, 'version/vtest');

    // 切片 worktree 从版本分支的 tip 长出来（ADR-067：基点跟随版本分支）
    const sliceDir = join(TEST_DIR, '.zelto', 'worktrees', 'version-slice');
    await mkdir(sliceDir, { recursive: true });
    git(TEST_DIR, 'worktree', 'add', '-b', 'slice/version-slice', sliceDir, 'version/vtest');
    await writeFile(join(sliceDir, 'src', 'feature.ts'), 'export const x = 3;\n', 'utf-8');
    git(sliceDir, 'add', '-A');
    git(sliceDir, 'commit', '-m', 'feat: version slice work');

    // 版本分支合入切片分支（模拟 version/v1 合入 slice/... 的结果）
    git(versionDir, 'merge', '--no-ff', 'slice/version-slice', '-m', 'Merge slice version-slice');

    // 切片状态、签字与版本计划必须写在切回主仓之后
    // （切分支会带走未跟踪文件）
    git(TEST_DIR, 'checkout', 'main');
    await writeSlice('version-slice');
    await writeApprovedSign('version-slice');
    await writeVersionPlan('vtest', ['version-slice']);

    const before = branches(TEST_DIR);
    const { stdout, stderr, code } = await runCommand('merge', 'version-slice');
    const out = stdout + stderr;

    assert.equal(code, 0, `合并应成功，实际输出：${out}`);
    const after = branches(TEST_DIR);

    assert.ok(
      !after.includes('slice/version-slice'),
      `已合入版本分支的切片分支应被删掉，实际分支：${after.join(', ')}`,
    );
    assert.ok(
      after.includes('version/vtest'),
      `版本分支绝不能被误删（D-40 的危险点），实际分支：${after.join(', ')}；合并前：${before.join(', ')}`,
    );
    assert.ok(
      !out.includes('merged elsewhere'),
      `不该报「已合到别处」—— 产物就在目标分支里，实际输出：${out}`,
    );
  });

  it('未合入目标分支时：不删分支，且如实说「还有未合入的内容」', async () => {
    // 一个有独立提交、既不在 main 也不在任何版本分支上的切片分支
    //
    // 注意顺序：`.zelto/**` 是**未跟踪文件**，`git checkout` 切分支时
    // 不会保留它 —— 所以切片状态必须写在切回 main **之后**。
    git(TEST_DIR, 'checkout', '-b', 'slice/orphan-slice');
    await writeFile(join(TEST_DIR, 'src', 'feature.ts'), 'export const x = 9;\n', 'utf-8');
    git(TEST_DIR, 'add', '-A');
    git(TEST_DIR, 'commit', '-m', 'feat: orphan work');
    git(TEST_DIR, 'checkout', 'main');

    await mkdir(join(TEST_DIR, '.zelto', 'slices'), { recursive: true });
    await mkdir(join(TEST_DIR, '.zelto', 'locks'), { recursive: true });
    await writeSlice('orphan-slice');
    await writeApprovedSign('orphan-slice');

    const before = branches(TEST_DIR);
    const { stdout, stderr } = await runCommand('merge', 'orphan-slice');
    const out = stdout + stderr;
    const after = branches(TEST_DIR);

    assert.ok(
      after.includes('slice/orphan-slice'),
      `未合入的切片分支不该被删，实际分支：${after.join(', ')}；合并前：${before.join(', ')}`,
    );
    assert.ok(
      out.includes('not merged') || out.includes('未合入'),
      `应如实说「还有未合入的内容」，实际输出：${out}`,
    );
    assert.ok(
      !out.includes('merged elsewhere'),
      `不该报「已合到别处」，实际输出：${out}`,
    );
  });
});
