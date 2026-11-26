// E2E：plan patch --slice-state（ADR-127）+ --info 预演（ZD-059）
//
// 为什么用真 CLI：这两件事都只活在 CLI 层 —— `--slice-state` 是参数解析，
// `--info` 是「不写盘」的开关。core 的 applyPlanPatch 已经由 plan-patch.test.ts 覆盖。
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
    id: 'plan-e2e',
    designId: 'dsg-e2e',
    title: 'E2E 计划',
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

before(async () => {
  ROOT = await mkdtemp(join(tmpdir(), 'zelto-adr127-'));
  await mkdir(join(ROOT, '.zelto', 'versions'), { recursive: true });
  await writeFile(join(ROOT, '.zelto', 'versions', 'plan-e2e.json'), JSON.stringify(makePlan(), null, 2), 'utf-8');
});

describe('ADR-127 / ZD-059：plan patch 的计划态与预演', () => {
  it('--info 只展示改动，不写文件、不写事件', async () => {
    const before = await readFile(join(ROOT, '.zelto', 'versions', 'plan-e2e.json'), 'utf-8');
    const r = zelto('plan', 'patch', 'plan-e2e', '--version', 'v1', '--slice', 's-a', '--slice-state', 'completed', '--info');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /预演/);
    assert.match(r.out, /旧：draft/);
    const after = await readFile(join(ROOT, '.zelto', 'versions', 'plan-e2e.json'), 'utf-8');
    assert.equal(after, before, '--info 不许写盘');
    assert.equal(existsSync(join(ROOT, '.zelto', 'events', 'draft-plan-plan-e2e')), false, '--info 不许写事件');
  });

  it('--slice-state completed 真写入，并留下 draft.revised 事件', async () => {
    const r = zelto('plan', 'patch', 'plan-e2e', '--version', 'v1', '--slice', 's-a', '--slice-state', 'completed', '--yes');
    assert.equal(r.code, 0, r.out);
    const plan = JSON.parse(await readFile(join(ROOT, '.zelto', 'versions', 'plan-e2e.json'), 'utf-8'));
    assert.equal(plan.versions[0].slices[0].state, 'completed');
    const evFile = join(ROOT, '.zelto', 'events', 'draft-plan-plan-e2e', 'events.jsonl');
    assert.equal(existsSync(evFile), true, 'C4：修正必须写事件');
    const ev = (await readFile(evFile, 'utf-8')).trim().split('\n').map((l) => JSON.parse(l));
    const revised = ev.find((e) => e.type === 'draft.revised');
    assert.ok(revised);
    assert.equal(revised.payload.changes[0].field, 'state');
  });

  it('--slice-state 的非法值被忽略（不把计划写成垃圾态）', async () => {
    // 配一个合法的改动，确保这次**一定会写入** —— 要验的是「非法 state 没被写进去」
    const r = zelto('plan', 'patch', 'plan-e2e', '--version', 'v1', '--slice', 's-a', '--slice-state', 'bogus', '--slice-title', '片 A（改名）', '--yes');
    assert.equal(r.code, 0, r.out);
    const plan = JSON.parse(await readFile(join(ROOT, '.zelto', 'versions', 'plan-e2e.json'), 'utf-8'));
    assert.equal(plan.versions[0].slices[0].title, '片 A（改名）', '合法改动要生效');
    assert.equal(plan.versions[0].slices[0].state, 'completed', '非法 state 不许覆盖原值');
  });
});
