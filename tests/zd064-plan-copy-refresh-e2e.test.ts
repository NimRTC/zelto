// ZD-064 E2E：`zelto plan patch` 之后，版本工作目录里的计划副本必须跟上真源
//
// 为什么用真 CLI：保鲜这个动作**只在 CLI 层被触发**（core 的两个函数
// 由 version-plan-copy.test.ts 覆盖）。这里验的是「改计划 → 副本跟上」
// 这条链在真实进程里跑得通。
//
// 病灶（实测 nimrtc-v14，2026-11-27）：版本工作目录里的计划副本是建版那一刻
// 复制进去的，之后**再也不会更新**。`resolveSliceOwnership` 读的是**当前目录**
// 下的 `.zelto/versions/` —— 于是在版本目录里跑 merge 时读到的是陈旧副本，
// 归属解析按错的归属算。
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 向上查找含 `dist/cli/index.js` 的主仓（dist-test/ 与 worktree 里都没有 dist/）。 */
function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'dist', 'cli', 'index.js'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}
const REPO_ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
const CLI = join(REPO_ROOT, 'dist', 'cli', 'index.js');

let ROOT = '';

function zelto(...args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

function makePlan() {
  return {
    id: 'plan-copy-e2e',
    designId: 'dsg-e2e',
    title: '副本保鲜 E2E',
    status: 'confirmed',
    createdAt: '2026-01-01T00:00:00.000Z',
    confirmedAt: '2026-01-01T00:00:00.000Z',
    versions: [
      {
        version: 'v1',
        dependsOn: [],
        description: '第一版',
        integrationTestDir: 'tests/acceptance/v1/',
        status: 'in_progress',
        slices: [
          { id: 's-a', module: 'm', title: '片 A', writes: ['src/a.cpp'], specPath: 'specs/slices/s-a.md', state: 'draft' },
        ],
      },
    ],
  };
}

const PLAN_ID = 'plan-copy-e2e';

before(async () => {
  ROOT = await mkdtemp(join(tmpdir(), 'zelto-plan-copy-e2e-'));
  await mkdir(join(ROOT, '.zelto', 'versions'), { recursive: true });
  await writeFile(join(ROOT, '.zelto', 'versions', `${PLAN_ID}.json`), JSON.stringify(makePlan(), null, 2), 'utf-8');
});

describe('ZD-064 E2E：plan patch 会把版本目录里的计划副本同步到真源', () => {
  it('陈旧副本在 patch 之后跟上真源（归属解析不再读到旧计划）', async () => {
    // 造一个版本工作目录，里面放**陈旧**的副本（模拟 ADR-121 建版时复制进去的那份）
    const wt = join(ROOT, '.zelto', 'version-worktrees', 'v1');
    await mkdir(join(wt, '.zelto', 'versions'), { recursive: true });
    const stale = JSON.stringify(makePlan(), null, 2).replace('"title": "片 A"', '"title": "旧标题"');
    await writeFile(join(wt, '.zelto', 'versions', `${PLAN_ID}.json`), stale, 'utf-8');

    const copyPath = join(wt, '.zelto', 'versions', `${PLAN_ID}.json`);
    const truthPath = join(ROOT, '.zelto', 'versions', `${PLAN_ID}.json`);

    // 副本此刻确实是陈旧的
    assert.notEqual(await readFile(copyPath, 'utf-8'), await readFile(truthPath, 'utf-8'));

    // 改计划 —— 副本应该自动跟上
    const r = zelto('plan', 'patch', PLAN_ID, '--version', 'v1', '--slice', 's-a', '--slice-title', '新标题', '--yes');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /新标题/);

    assert.equal(
      await readFile(copyPath, 'utf-8'),
      await readFile(truthPath, 'utf-8'),
      '版本目录里的副本应该与真源逐字一致',
    );

    await rm(wt, { recursive: true, force: true });
  });

  it('没有版本工作目录时也能 patch 成功（保鲜不是硬依赖）', async () => {
    const r = zelto('plan', 'patch', PLAN_ID, '--version', 'v1', '--slice', 's-a', '--slice-title', '又一个标题', '--yes');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /计划副本：没有已存在的版本工作目录，无需同步/);
  });

  it('--info 预演不写盘，副本也不动（没发生就不记）', async () => {
    const wt = join(ROOT, '.zelto', 'version-worktrees', 'v2');
    await mkdir(join(wt, '.zelto', 'versions'), { recursive: true });
    const copyPath = join(wt, '.zelto', 'versions', `${PLAN_ID}.json`);
    await writeFile(copyPath, '{"stale":true}\n', 'utf-8');

    const r = zelto('plan', 'patch', PLAN_ID, '--version', 'v1', '--slice', 's-a', '--slice-title', '预演标题', '--info');
    assert.equal(r.code, 0, r.out);
    assert.equal(await readFile(copyPath, 'utf-8'), '{"stale":true}\n', '预演不该动副本');

    await rm(join(ROOT, '.zelto', 'version-worktrees', 'v2'), { recursive: true, force: true });
  });
});
