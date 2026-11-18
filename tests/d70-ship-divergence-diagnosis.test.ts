// D-70：ship 的分叉诊断必须说真话 —— 「主干前进」与「主干历史被改写」是两回事
//
// 病灶（实测 nimrtc-zelto v5，2026-11-18）：
//
// v1–v4 的 PR 是 **squash 合并**进 main 的。squash 重写了 main 的历史，
// 于是从 squash 前的分支建出来的 `version/v5` 与 main 有了**两套祖先**：
//
//   $ git merge-base --is-ancestor HEAD version/v5 ; echo $?
//   1                     ← 不是快进
//   $ git merge-base main version/v5
//   b4c66de…              ← 共同祖先在 squash 之前
//
// 合并前的提示只说：
//
//   ℹ️  主干已前进，改用合并提交（--no-ff）。
//
// 这句诊断是**错的**：真正的问题是两套历史，
// 直接合并会产生 40+ 文件的冲突，而版本分支里的产物
// 其实早已被 squash 带进 main 了。
//
// 为什么要紧：这是**人做决定前**唯一拿到的信号。
// 提示说「改用合并提交」时，人以为 --no-ff 就行；
// 真撞上 40 文件冲突时，人完全不知道该 rebase 还是该重建。
//
// ── 判据 ────────────────────────────────────────────────────────
//
// 用**版本分支记录的基点**（`version.baseCommit`）判：
//
//   - 基点仍是主干 HEAD 的祖先 → 主干只是前进，历史没被动过 → 正常 --no-ff；
//   - 基点**不再**是主干 HEAD 的祖先 → 主干历史被改写过（squash / rebase）
//     → 版本分支挂在旧历史上，合并必然大面积冲突。
//
// 为什么不用祖先关系判（`is-ancestor versionBranch HEAD`）：
// 那判的是「版本分支的提交有没有进主干」，而**正常流程里答案本来就是「没有」**
// —— 版本分支的产物正是要靠这次 ship 才进主干。
// 用它当判据会把每一次正常的 ship 都误报成分叉。
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

/**
 * 主仓里一份最小可用的 zelto 项目（版本计划 + 一个已完成的切片）。
 *
 * `baseCommit` 记的是版本分支建起来时的基点 —— ship 用它判「主干历史有没有被改写」。
 */
function makeProject(dir: string): { baseCommit: string } {
  mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@zelto.local'], dir);
  git(['config', 'user.name', 'zelto test'], dir);
  writeFileSync(join(dir, 'keep.txt'), 'keep\n', 'utf-8');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'init'], dir);

  const baseCommit = git(['rev-parse', 'HEAD'], dir).trim();

  git(['checkout', '-q', '-b', 'version/vx'], dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'feature.txt'), 'feature\n', 'utf-8');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'version work'], dir);
  git(['checkout', '-q', 'main'], dir);

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
            baseCommit,
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
        acceptance: {
          dir: 'tests/acceptance/vx-slice/',
          frozenHash: null,
          oracleSrc: null,
        },
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

  return { baseCommit };
}

/** 跑一次 `zelto version ship vx`，返回 { stdout, stderr, code } */
function runShip(cwd: string): { stdout: string; stderr: string; code: number } {
  const cli = join(process.cwd(), 'dist', 'cli', 'index.js');
  const r = spawnSync('node', [cli, 'version', 'ship', 'vx'], { cwd, encoding: 'utf-8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? -1 };
}

/**
 * 把主干历史改写成「两套祖先」—— 模拟 squash 合并 PR。
 *
 * squash 合并的效果：main 上出现一个**新根**提交（原 PR 的所有提交被压成一个），
 * 原分支的提交不在 main 的历史里。于是版本分支的基点不再是 main 的祖先。
 */
function rewriteMainHistory(repo: string): void {
  git(['checkout', '-q', '--orphan', 'squashed-main'], repo);
  git(['rm', '-rq', '--cached', '.'], repo);
  writeFileSync(join(repo, 'other.txt'), 'other\n', 'utf-8');
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'squashed upstream work'], repo);

  git(['branch', '-f', 'main', 'squashed-main'], repo);
  git(['checkout', '-q', 'main'], repo);
  git(['branch', '-D', 'squashed-main'], repo);
}

describe('D-70：ship 必须区分「主干前进」与「主干历史被改写」', () => {
  let dir: string;
  let repo: string;
  let baseCommit: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zelto-d70-'));
    repo = join(dir, 'repo');
    ({ baseCommit } = makeProject(repo));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('主干只是前进（基点仍是 HEAD 的祖先）→ 仍然说「主干已前进」', () => {
    // main 上加一个提交 —— 基点还在 main 的历史里，只是 main 前进了
    writeFileSync(join(repo, 'main-only.txt'), 'main only\n', 'utf-8');
    git(['add', '-A'], repo);
    git(['commit', '-q', '-m', 'main moved on'], repo);

    const res = runShip(repo);
    assert.equal(res.code, 0, `ship 应当成功：${res.stdout}\n${res.stderr}`);
    assert.ok(
      res.stdout.includes('主干已前进'),
      `普通的主干前进应当仍然说「主干已前进」：\n${res.stdout}`,
    );
    assert.ok(
      !res.stdout.includes('已分叉'),
      `普通的主干前进不该报「已分叉」：\n${res.stdout}`,
    );
  });

  it('主干历史被改写（squash）→ 必须说「已分叉」，不能还说「主干已前进」', () => {
    rewriteMainHistory(repo);

    // 前置确认：基点确实不再是 main 的祖先
    // （--is-ancestor 在「不是祖先」时退出码为 1，这是正常结果，不能当成命令失败）
    const isAncestor = spawnSync('git', ['merge-base', '--is-ancestor', baseCommit, 'main'], {
      cwd: repo,
      encoding: 'utf-8',
    });
    assert.notEqual(
      isAncestor.status,
      0,
      '改写历史后基点不该再是 main 的祖先（is-ancestor 应退出 1）',
    );

    const res = runShip(repo);
    const out = res.stdout;

    assert.ok(
      out.includes('已分叉'),
      `历史分叉时必须说「已分叉」：\n${out}`,
    );
    assert.ok(
      !out.includes('主干已前进，改用合并提交'),
      `历史分叉时不能说「主干已前进，改用合并提交」—— 那正是原来的错话：\n${out}`,
    );
  });

  it('历史分叉时给出可执行的解法（rebase 到主干）', () => {
    rewriteMainHistory(repo);

    const res = runShip(repo);
    const out = res.stdout;

    assert.ok(
      out.includes('rebase'),
      `分叉提示应当给出 rebase 解法：\n${out}`,
    );
    assert.ok(
      out.includes('共同祖先'),
      `分叉提示应当说清共同祖先：\n${out}`,
    );
    assert.ok(
      out.includes('version/vx'),
      `分叉提示应当点名版本分支：\n${out}`,
    );
  });

  it('版本基点没记录时不误报分叉（保守：不乱说）', () => {
    // 把计划里的 baseCommit 清掉 —— 判据没有依据时不该喊「分叉」
    const planPath = join(repo, '.zelto', 'versions', 'plan-1.json');
    const plan = JSON.parse(readFileSync(planPath, 'utf-8')) as Record<string, unknown>;
    const versions = plan.versions as Array<Record<string, unknown>>;
    versions[0].baseCommit = null;
    writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf-8');

    writeFileSync(join(repo, 'main-only.txt'), 'main only\n', 'utf-8');
    git(['add', '-A'], repo);
    git(['commit', '-q', '-m', 'main moved on'], repo);

    const res = runShip(repo);
    assert.equal(res.code, 0, `ship 应当成功：${res.stdout}\n${res.stderr}`);
    assert.ok(
      !res.stdout.includes('已分叉'),
      `没有基点可判时不该误报「已分叉」：\n${res.stdout}`,
    );
  });
});
