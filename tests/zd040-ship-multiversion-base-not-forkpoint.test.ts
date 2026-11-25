// ZD-040：多版本链里 `version.baseCommit` 是「依赖版本的 tip」，不是「分叉点」
// —— 拿它判分叉 = 每次 ship 都误报
//
// 病灶（实测 nimrtc-v14 v3 ship，2026-11-25）：
//
//   nimb obra v1.4 的版本链是 v1 → v2 → v3（v2 dependsOn v1，v3 dependsOn v2）。
//   `version.start` 给 v3 记的 `baseCommit` 是 **v2 的 tip**（`dd396cd5`）。
//
//   主干 `feat/v14-turn-tls` 从 v1.3.0 tag（`ff9d64b0`）分出、踩出自己的提交。
//   v2 的 tip 永远不会进主干（v2 是版本分支，它的产物要等 ship 才进主干）——
//   于是 `git merge-base --is-ancestor dd396cd5 feat/v14-turn-tls` 退出 1。
//
//   ship 拿这一条判「主干历史被改写」→ 报「已分叉」→ 给出
//   `git rebase --onto feat/v14-turn-tls ff9d64b0 version/v3` ——
//   而真实的冲突只有 6 个文件，**根本不是分叉**。
//
//   后果：人按提示去 rebase 一条干净的历史 → 106 个提交被逐个重放、
//   vendor 子模块指针大面积错位。**误报比不报更坏**。
//
// 判据（修正后）：
//   1. baseCommit 仍是版本分支的祖先（版本分支没被改写）；
//   2. 共同祖先不早于 baseCommit（主干在分叉点之后仍沿原历史走）。
//   两条都成立 → 「主干已前进」，正常 --no-ff。
//
// 这一组用例守的是：
//   1. 多版本链（baseCommit = 依赖版本 tip，不在主干里）→ **不**报分叉；
//   2. 版本分支被 rebase 过（baseCommit 不在它的历史里）→ 仍然报分叉；
//   3. D-70 的真场景（主干被 squash 成新根）+ 多版本链 baseCommit
//      → 仍然报分叉（不能为了修误报而漏掉真分叉）。

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

function gitSafe(args: string[], cwd: string): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  return { ok: r.status === 0, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

/**
 * 造一条**多版本链**：
 *
 *   trunk (main)
 *     │
 *     ├─ v1.3.0 基点（fork-point，两线共同的起点）
 *     │
 *     ├──► main 上的独立工作（主干前进）
 *     │
 *     └──► version/v1 ──► version/v2 ──► version/v3
 *
 * v3 的 `baseCommit` 记的是 **v2 的 tip**（依赖版本），
 * 那条 tip 一旦不在主干里 —— 正是真实项目里的形态。
 */
function makeChainProject(dir: string): { v2Tip: string; forkPoint: string } {
  mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@zelto.local'], dir);
  git(['config', 'user.name', 'zelto test'], dir);
  writeFileSync(join(dir, 'keep.txt'), 'keep\n', 'utf-8');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'v1.3.0 base'], dir);
  const forkPoint = git(['rev-parse', 'HEAD'], dir).trim();

  // 主干在自己的路上前进（版本分支没有任何一条提交进主干）
  writeFileSync(join(dir, 'trunk.txt'), 'trunk work\n', 'utf-8');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'trunk advances'], dir);

  // 版本链 v1 → v2 → v3
  git(['checkout', '-q', '-b', 'version/v1', 'main'], dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'v1.txt'), 'v1\n', 'utf-8');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'v1 work'], dir);

  git(['checkout', '-q', '-b', 'version/v2', 'version/v1'], dir);
  writeFileSync(join(dir, 'src', 'v2.txt'), 'v2\n', 'utf-8');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'v2 work'], dir);
  const v2Tip = git(['rev-parse', 'HEAD'], dir).trim();

  git(['checkout', '-q', '-b', 'version/v3'], dir);
  writeFileSync(join(dir, 'src', 'v3.txt'), 'v3\n', 'utf-8');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'v3 work'], dir);

  git(['checkout', '-q', 'main'], dir);

  // zelto 状态：v3 的 baseCommit 记 v2 的 tip（真实项目形态）
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
            branch: 'version/v3',
            baseCommit: v2Tip,
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

  return { v2Tip, forkPoint };
}

function runShip(cwd: string): { stdout: string; stderr: string; code: number } {
  const cli = join(process.cwd(), 'dist', 'cli', 'index.js');
  const r = spawnSync('node', [cli, 'version', 'ship', 'vx'], { cwd, encoding: 'utf-8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? -1 };
}

describe('ZD-040：多版本链里 baseCommit ≠ 分叉点 —— ship 不许因此误报分叉', () => {
  let dir: string;
  let repo: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zelto-zd040-'));
    repo = join(dir, 'repo');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('baseCommit 是依赖版本的 tip（不在主干里）→ 主干只是前进，不报分叉', () => {
    makeChainProject(repo);

    const res = runShip(repo);
    assert.ok(
      !res.stdout.includes('已分叉'),
      `多版本链不该报「已分叉」：\n${res.stdout}`,
    );
    // 主干只是前进 → 要么 fast-forward，要么 --no-ff，
    // 但**绝不能**把人引去 rebase
    assert.ok(
      !res.stdout.includes('rebase --onto'),
      `不该把人引去 rebase 一条干净的历史：\n${res.stdout}`,
    );
    // ship 真的发生了（快进或 --no-ff 都行 —— 版本产物进了主干）
    const merged = gitSafe(['merge-base', '--is-ancestor', 'version/v3', 'main'], repo);
    assert.equal(merged.ok, true, `ship 成功后版本分支应当在主干里：\n${res.stdout}`);
  });

  it('反向：版本分支被 rebase 过（baseCommit 不在它的历史里）→ 仍报分叉', () => {
    makeChainProject(repo);
    const planPath = join(repo, '.zelto', 'versions', 'plan-1.json');
    const slicePath = join(repo, '.zelto', 'slices', 'vx-slice.json');
    const planText = readFileSync(planPath, 'utf-8');
    const sliceText = readFileSync(slicePath, 'utf-8');
    const v2Tip = (JSON.parse(planText).versions[0].baseCommit as string) ?? '';
    assert.ok(v2Tip, '自检前提：baseCommit 应当被记录');

    // 把 version/v3 重放到一个**独立的新根**上：baseCommit（v2 tip）不在它的历史里，
    // 且它也不在主干的历史线上（必然 --no-ff，才会打诊断）。
    git(['checkout', '-q', 'version/v3'], repo);
    git(['checkout', '-q', '--orphan', 'rebuilt-v3'], repo);
    git(['rm', '-rq', '--cached', '.'], repo);
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'v3.txt'), 'v3\n', 'utf-8');
    git(['add', '-A'], repo);
    git(['commit', '-q', '-m', 'v3 work, rebuilt on a new root'], repo);
    git(['branch', '-f', 'version/v3', 'rebuilt-v3'], repo);
    git(['checkout', '-q', '-f', 'main'], repo);
    git(['branch', '-D', 'rebuilt-v3'], repo);

    // orphan 分支的 `git rm -r --cached` 只动 index，checkout -f 会把 working tree
    // 还原成 main 的形态 —— 但 `.zelto/` 是被 .gitignore 的，还原不到。
    // 显式写回 zelto 状态（与 makeChainProject 造的一致）。
    mkdirSync(join(repo, '.zelto', 'versions'), { recursive: true });
    mkdirSync(join(repo, '.zelto', 'slices'), { recursive: true });
    writeFileSync(planPath, planText, 'utf-8');
    writeFileSync(slicePath, sliceText, 'utf-8');
    // 写回后被 git 视为「未跟踪」→ ship 的工作区守卫会拦。
    // 放到 index 里（不 commit）—— 这等价于 makeChainProject 里
    // `.zelto/` 创建后直接跑 ship 的形态（`isZeltoStatePath` 豁免仅针对**已跟踪**文件）。
    git(['add', '-f', '.zelto/versions/plan-1.json', '.zelto/slices/vx-slice.json'], repo);
    git(['commit', '-q', '-m', 'zelto state for the rebase scenario'], repo);

    // 自检：baseCommit 确实已经不在 version/v3 的历史里
    const stillAncestor = gitSafe(['merge-base', '--is-ancestor', v2Tip, 'version/v3'], repo);
    assert.equal(stillAncestor.ok, false, '自检前提：baseCommit 应当已经不在 version/v3 的历史里');

    const res = runShip(repo);
    assert.ok(
      res.stdout.includes('已分叉'),
      `版本分支被改写后必须报「已分叉」：\n${res.stdout}\n${res.stderr}`,
    );
  });

  it('反向：主干被 squash 成新根（D-70 真场景）→ 仍报分叉', () => {
    makeChainProject(repo);
    // 主干整体换成一个独立的新根 —— 共同祖先变成了空（不再是 forkPoint）
    git(['checkout', '-q', '--orphan', 'squashed-main'], repo);
    git(['rm', '-rq', '--cached', '.'], repo);
    writeFileSync(join(repo, 'other.txt'), 'other\n', 'utf-8');
    git(['add', '-A'], repo);
    git(['commit', '-q', '-m', 'squashed upstream work'], repo);
    git(['branch', '-f', 'main', 'squashed-main'], repo);
    git(['checkout', '-q', 'main'], repo);
    git(['branch', '-D', 'squashed-main'], repo);

    const res = runShip(repo);
    assert.ok(
      res.stdout.includes('已分叉'),
      `主干被改写成新根后必须报「已分叉」：\n${res.stdout}`,
    );
  });
});
