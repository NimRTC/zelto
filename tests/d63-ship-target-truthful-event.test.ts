// D-63：ship 事件里写死的 `target: 'main'` 是假话 —— 追溯链说了谎
//
// 病灶（实测 nimrtc-zelto v3，2026-11-18）：
//
//   主仓停在 `feat/remote-desktop-m1-m4` 上跑 `zelto version ship v3`。
//   ship 确实合了 —— 合进的是**主仓当前检出的分支**（ADR-056 §3.5 说的「主干」
//   = 主仓当前分支，不特指 `main`）。
//
//   但事件写的是：
//
//     { "type": "version.delivered", "payload": { "shippedTo": "main", ... } }
//
//   而 git 说：
//
//     $ git merge-base --is-ancestor v3 main ; echo $?
//     1                      ← v3 从来没进过 main
//
//   **两个证据打架**：事件说进了 main，git 说没进。
//
// 为什么要紧（C4：事件是追溯的唯一证据载体）：
//   以后查「v3 进主干了吗」，追溯链说进了 —— 而真相是没进。
//   人要么信事件（错），要么不信事件（那追溯链就没用了）。
//   **假完成比不完成更坏** —— 它让人以为可以往下走。
//
// 这一组用例守的是：
//   1. ship 落在**非 main 分支**上时，事件里的 `shippedTo` 写真实的分支名；
//   2. 落在 main 上时，写 `main`（不能把真话也改坏）；
//   3. `merge.conflict` 事件的 `target` 同样写真实分支名；
//   4. dry-run 的输出说真名 —— 人要在**动手前**知道会合到哪。

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

/** 主仓里一份最小可用的 zelto 项目（版本计划 + 一个已完成的切片）。 */
function makeProject(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@zelto.local'], dir);
  git(['config', 'user.name', 'zelto test'], dir);
  writeFileSync(join(dir, 'keep.txt'), 'keep\n', 'utf-8');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'init'], dir);

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
        spec: {
          path: 'specs/slices/vx-slice.md',
          frozenHash: null,
          frozenAt: null,
        },
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
}

/** 跑一次 `zelto version ship vx`，返回 { stdout, stderr, code } */
function runShip(cwd: string, extra: string[] = []): { stdout: string; stderr: string; code: number } {
  const cli = join(process.cwd(), 'dist', 'cli', 'index.js');
  const r = execFileSyncSafe(cli, ['version', 'ship', 'vx', ...extra], cwd);
  return r;
}

function execFileSyncSafe(
  script: string,
  args: string[],
  cwd: string,
): { stdout: string; stderr: string; code: number } {
  const r = spawnSync('node', [script, ...args], { cwd, encoding: 'utf-8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? -1 };
}

/** 读某个版本的事件流里的某类事件 */
function readEvents(dir: string, type: string): Array<Record<string, unknown>> {
  const file = join(dir, '.zelto', 'events', 'version-vx', 'events.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.type === type);
}

describe('D-63：ship 的事件必须说真话 —— 合到哪个分支就写哪个', () => {
  let dir: string;
  let repo: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zelto-d63-'));
    repo = join(dir, 'repo');
    makeProject(repo);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('主仓停在非 main 分支上 → shippedTo 写真实的分支名，不写 main', () => {
    git(['checkout', '-q', '-b', 'feat/other'], repo);

    const res = runShip(repo);
    assert.equal(res.code, 0, `ship 应当成功：${res.stdout}\n${res.stderr}`);

    const delivered = readEvents(repo, 'version.delivered');
    assert.equal(delivered.length, 1, '应当有且只有一条 version.delivered 事件');
    const payload = delivered[0].payload as Record<string, unknown>;

    // 事件说的分支 == git 上真的合进去的分支
    assert.equal(
      payload.shippedTo,
      'feat/other',
      'shippedTo 必须写真实合入的分支，而不是写死的 main',
    );

    // 交叉验证：git 说 vx 的产物确实在 feat/other 上
    assert.ok(
      git(['branch', '--contains', 'version/vx'], repo).includes('feat/other'),
      'git 应该确认版本分支的产物在 feat/other 上',
    );
  });

  it('主仓停在 main 上 → shippedTo 写 main（不能把真话也改坏）', () => {
    const res = runShip(repo);
    assert.equal(res.code, 0, `ship 应当成功：${res.stdout}\n${res.stderr}`);

    const delivered = readEvents(repo, 'version.delivered');
    const payload = delivered[0].payload as Record<string, unknown>;
    assert.equal(payload.shippedTo, 'main');
  });

  it('dry-run 的输出说真名 —— 人要在动手前知道会合到哪', () => {
    git(['checkout', '-q', '-b', 'feat/other'], repo);

    const res = runShip(repo, ['--dry-run']);
    assert.equal(res.code, 0);

    const out = res.stdout;
    assert.ok(
      out.includes('feat/other'),
      `dry-run 输出应当包含真实目标分支名：\n${out}`,
    );
    assert.ok(
      !out.includes('合入目标：主仓当前分支'),
      'dry-run 不该用「主仓当前分支」这种含糊说法',
    );
  });

  it('ship 的输出直接说「合入目标：<分支名>」', () => {
    git(['checkout', '-q', '-b', 'feat/other'], repo);

    const res = runShip(repo);
    assert.equal(res.code, 0);
    assert.ok(
      res.stdout.includes('合入目标：feat/other'),
      `ship 输出应当说明合入目标：\n${res.stdout}`,
    );
  });
});
