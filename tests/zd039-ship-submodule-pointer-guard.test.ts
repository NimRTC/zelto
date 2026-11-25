// ZD-039：`version ship` 的守卫不认「submodule 指针错位」—— 被同一条
// `zelto merge` 豁免的东西，ship 会拦下
//
// 病灶（实测 nimrtc-v14 v3，2026-11-25）：
//
//   主仓里有 9 个 vendor submodule 的**指针与 index 记录不一致**
//   （工作区 checkout 的 commit ≠ index 里的 gitlink）。这些不是人改的代码，
//   是版本 worktree 与主仓工作区之间的既有状态差。
//
//   `zelto merge` 早就有这条豁免（ZD-021，`isSubmodulePointerMismatch`），
//   报的是「ℹ️ N 个 submodule 的指针与 index 记录不一致（与本次合并无关）」
//   然后照常合并。
//
//   但 `zelto version ship` 的守卫里**没有这一条** —— 同一个仓库、同一份
//   `git status`，merge 放行，ship 拦下：
//
//     ⚠️  主仓工作区有未提交改动，已跳过 ship：
//          M src/third_party/msquic
//          ...
//          先提交或暂存这些改动，再重新跑 zelto version ship。
//
//   人按提示去 `git checkout` 那些 vendor 目录 → 指针被 reset 成 index 的旧值
//   → 版本分支里原本能构建的 vendor 布局被改坏。
//
// 为什么这是「守卫口径分叉」而不是「守卫太严」：
//   merge 与 ship 是**同一道守卫的两个入口**。口径分叉的后果不是「多拦一次」，
//   是「人按这句提示做反而把事情做坏」。
//
// 这一组用例守的是：
//   1. 只有「submodule 指针错位」时 → ship **成功**（不拦）；
//   2. 「submodule 内部有未提交改动」（指针未变）→ 同样不拦（与 merge 一致）；
//   3. **反向**：普通文件真的被改了 → ship **仍然拦**（不能为了放行误伤真判据）；
//   4. 反向组合：指针错位 + 普通文件被改 → 拦，且拦住清单里只列普通文件。

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

function gitSafe(args: string[], cwd: string): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  return { ok: r.status === 0, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

/** 造一个「vendor 子模块」的源仓库：两个 commit，供主仓钉一个、错位到另一个。 */
function makeSubmoduleRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@zelto.local'], dir);
  git(['config', 'user.name', 'zelto test'], dir);
  writeFileSync(join(dir, 'vendor.txt'), 'v1\n', 'utf-8');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'vendor v1'], dir);
  writeFileSync(join(dir, 'vendor.txt'), 'v2\n', 'utf-8');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'vendor v2'], dir);
}

/** 主仓里一份最小可用的 zelto 项目（版本计划 + 一个已完成的切片）。 */
function makeProject(dir: string, vendorRepo: string): void {
  mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@zelto.local'], dir);
  git(['config', 'user.name', 'zelto test'], dir);
  git(['config', 'protocol.file.allow', 'always'], dir);
  writeFileSync(join(dir, 'keep.txt'), 'keep\n', 'utf-8');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'init'], dir);

  // 真 submodule：钉在 vendor v1（index 记录 v1，工作区稍后切到 v2 造「指针错位」）
  const vendorUrl = `file://${vendorRepo.replace(/\\/g, '/')}`;
  git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', vendorUrl, 'src/third_party/vendor'], dir);
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'add vendor'], dir);

  // 版本分支：从 main 建，上面有一份产物
  git(['checkout', '-q', '-b', 'version/vx'], dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'feature.txt'), 'feature\n', 'utf-8');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'version work'], dir);
  git(['checkout', '-q', 'main'], dir);

  // zelto 状态：版本计划 + 切片文件（切片状态要 completed —— ship 会核）
  mkdirSync(join(dir, '.zelto', 'slices'), { recursive: true });
  mkdirSync(join(dir, '.zelto', 'versions'), { recursive: true });
  writeFileSync(
    join(dir, '.zelto', 'versions', 'plan-1.json'),
    JSON.stringify(
      {
        id: 'plan-1',
        title: '测试计划',
        status: 'confirmed',
        createdAt: '2026-01-01T00:00:00.000Z',
        versions: [
          {
            version: 'vx',
            dependsOn: [],
            description: '测试版本',
            slices: [{ id: 'vx-slice', title: '片', module: 'm', writes: [] }],
            integrationTestDir: 'tests/integration/vx',
            status: 'integrated',
            branch: 'version/vx',
            baseCommit: null,
          },
        ],
      },
      null,
      2,
    ),
    'utf-8',
  );
  writeFileSync(
    join(dir, '.zelto', 'slices', 'vx-slice.json'),
    JSON.stringify(
      {
        id: 'vx-slice',
        title: '片',
        state: 'completed',
        spec: { path: 'specs/slices/vx-slice.md', frozenHash: null, frozenAt: null },
        acceptance: { dir: 'tests/acceptance/vx-slice/', frozenHash: null, oracleSrc: null },
        baseCommit: null,
        drift: { detected: false, reason: null, at: null },
        trace: { requirements: [], contracts: [], tests: [] },
        traceWaiver: null,
        baseline: false,
        writes: [],
        runs: [],
        clarifyRounds: 0,
        stall: { class: null, autoResolved: 0, gateRetries: 0 },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      null,
      2,
    ),
    'utf-8',
  );
}

function runShip(cwd: string, extra: string[] = []): { stdout: string; stderr: string; code: number } {
  const cli = join(process.cwd(), 'dist', 'cli', 'index.js');
  const r = spawnSync('node', [cli, 'version', 'ship', 'vx', ...extra], { cwd, encoding: 'utf-8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? -1 };
}

function readEvents(dir: string, type: string): Array<Record<string, unknown>> {
  const file = join(dir, '.zelto', 'events', 'version-vx', 'events.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.type === type);
}

/** 把 submodule 工作区切到 index 记录之外的 commit，造「指针错位」。 */
function misalignSubmodule(repo: string, vendorDir: string): void {
  const indexPin = git(['rev-parse', 'HEAD:src/third_party/vendor'], repo).trim();
  const other = git(['-C', vendorDir, 'rev-list', '--all'], repo)
    .split('\n')
    .map((l) => l.trim())
    .filter((h) => h && h !== indexPin);
  assert.ok(other.length > 0, '测试前提：vendor 仓库里应当有一个不同于 index 的 commit');
  git(['-C', vendorDir, 'checkout', '-q', other[0]], repo);
}

describe('ZD-039：ship 守卫与 merge 同口径 —— submodule 指针错位不算脏', () => {
  let dir: string;
  let repo: string;
  let vendorRepo: string;
  let vendorDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zelto-zd039-'));
    vendorRepo = join(dir, 'vendor-src');
    repo = join(dir, 'repo');
    makeSubmoduleRepo(vendorRepo);
    makeProject(repo, vendorRepo);
    vendorDir = join(repo, 'src', 'third_party', 'vendor');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('submodule 指针与 index 不一致 → ship 不拦，且输出里如实报出', () => {
    misalignSubmodule(repo, vendorDir);

    // 前提自检：这一步确实让 git status 报出该路径
    const statusBefore = git(['status', '--porcelain'], repo);
    assert.match(statusBefore, /src\/third_party\/vendor/, '测试前提：指针错位应当出现在 git status 里');

    const res = runShip(repo);
    assert.equal(res.code, 0, `指针错位不该拦住 ship：${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /指针与 index 记录不一致/, '输出要如实报出被豁免的是哪一类');

    const delivered = readEvents(repo, 'version.delivered');
    assert.equal(delivered.length, 1, 'ship 真的要发生 —— 不只是「没报错」');
  });

  it('submodule 内部有未提交改动（指针未变）→ ship 不拦', () => {
    writeFileSync(join(vendorDir, 'vendor.txt'), 'dirty inside the submodule\n', 'utf-8');

    const statusBefore = git(['status', '--porcelain'], repo);
    assert.match(statusBefore, /src\/third_party\/vendor/, '测试前提：内部脏应当出现在 git status 里');

    const res = runShip(repo);
    assert.equal(res.code, 0, `submodule 内部脏不该拦住 ship：${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /只有内部脏标记/, '输出要如实报出被豁免的是哪一类');
  });

  it('反向：普通文件真被改了 → ship 仍然拦（豁免不得放宽真判据）', () => {
    writeFileSync(join(repo, 'keep.txt'), 'modified by the human\n', 'utf-8');

    const res = runShip(repo);
    assert.notEqual(res.code, 0, '人改了普通文件必须拦住');
    assert.match(res.stdout, /主仓工作区有未提交改动/);
    assert.match(res.stdout, /keep\.txt/, '要被拦住的那一行点名');

    const delivered = readEvents(repo, 'version.delivered');
    assert.equal(delivered.length, 0, '被拦住的 ship 不许写 version.delivered');

    // 主干确实没动 —— 守卫失败时不许合并
    const head = git(['rev-parse', 'HEAD'], repo).trim();
    const ff = gitSafe(['merge-base', '--is-ancestor', 'version/vx', head], repo);
    assert.equal(ff.ok, false, '被拦下的 ship 不许把版本分支合进主干');
  });

  it('反向组合：指针错位 + 普通文件也改了 → 仍然拦，且拦住清单只列普通文件', () => {
    misalignSubmodule(repo, vendorDir);
    writeFileSync(join(repo, 'keep.txt'), 'modified by the human\n', 'utf-8');

    const res = runShip(repo);
    assert.notEqual(res.code, 0, '普通文件被改时必须拦住 —— 指针豁免不能顺带放过它');
    assert.match(res.stdout, /keep\.txt/, '报的是普通文件');
    assert.doesNotMatch(
      res.stdout.split('主仓工作区有未提交改动')[1] ?? '',
      /src\/third_party\/vendor/,
      '指针错位那条不该被算进「拦住的那几条」',
    );
  });
});
