// 驾驶舱多根扫描（ADR-112）：版本集成目录里的切片不许看不见
//
// 病灶（实测 nimrtc-v14，2026-11-25）：
//
//   驾驶舱只读 `repoRoot/.zelto`（`zelto web` 的 cwd），显示「8 片全完成」；
//   而这一版真正的开发进度在 `.zelto/version-worktrees/v3/.zelto/slices/`，
//   15 片里有两片正卡在 frozen 等人签字 —— 驾驶舱一片都看不到。
//
// 这个文件钉住三件事：
//   1. 根发现：仓库根 + 每个版本集成目录（有 .zelto/slices 或 events 才算）
//   2. 合并：同一片出现在多个根时只留一行，事实取 updatedAt 较晚的那份，
//      `roots` 记下它出现过的所有根
//   3. 路由：详情 / 签字 / 门禁等写操作落在 scope + label 指定的那个根

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_DIR = join(tmpdir(), `zelto-multi-root-${Date.now()}`);

/** 在 <dir>/.zelto 下建一份 zelto 状态（目录骨架 + 一片切片）。 */
async function setupRoot(dir: string, sliceId: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const zelto = join(dir, '.zelto');
  await mkdir(join(zelto, 'slices'), { recursive: true });
  await mkdir(join(zelto, 'events', sliceId), { recursive: true });
  await mkdir(join(zelto, 'locks'), { recursive: true });
  const base = {
    id: sliceId,
    title: `切片 ${sliceId}`,
    state: 'completed',
    spec: { path: `specs/slices/${sliceId}.md`, frozenHash: null, frozenAt: null },
    acceptance: { dir: `tests/acceptance/${sliceId}/`, frozenHash: null, oracleSrc: null },
    baseCommit: null,
    drift: { detected: false, reason: null, at: null },
    trace: { requirements: ['REQ-1'], contracts: ['C-1'], tests: ['T-1'] },
    traceWaiver: null,
    baseline: false,
    writes: ['src/a.ts'],
    runs: [],
    clarifyRounds: 0,
    stall: { class: null, autoResolved: 0, gateRetries: 0 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  await writeFile(join(zelto, 'slices', `${sliceId}.json`), JSON.stringify({ ...base, ...overrides }, null, 2), 'utf-8');
  await writeFile(join(zelto, 'events', sliceId, 'events.jsonl'), '', 'utf-8');
}

describe('ADR-112：驾驶舱多根扫描', () => {
  before(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    // 仓库根：2 片
    await setupRoot(TEST_DIR, 'root-only');
    await setupRoot(TEST_DIR, 'shared', { updatedAt: '2026-01-01T00:00:00.000Z' });
    // 版本目录 v3：2 片（v3-only + 与根重叠的 shared，时间更新）
    const v3 = join(TEST_DIR, '.zelto', 'version-worktrees', 'v3');
    await setupRoot(v3, 'v3-only', { updatedAt: '2026-02-01T00:00:00.000Z' });
    await setupRoot(v3, 'shared', { state: 'frozen', updatedAt: '2026-03-01T00:00:00.000Z' });
    // 版本目录 v2：只有空目录，没有 slices/events → 不算一个根
    await mkdir(join(TEST_DIR, '.zelto', 'version-worktrees', 'v2'), { recursive: true });
    // 非法 label（..）—— 不该被当成根
    await mkdir(join(TEST_DIR, '.zelto', 'version-worktrees', 'weird dir'), { recursive: true });
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('根发现：仓库根在前，版本目录按 label 排序，只有状态目录才算', async () => {
    const { discoverCockpitRoots } = await import('../src/core/project/cockpit-roots.js');
    const roots = discoverCockpitRoots(TEST_DIR);
    assert.equal(roots.length, 2, '应只有仓库根 + v3（v2 没有状态、weird dir 非法）');
    assert.equal(roots[0].scope, 'root');
    assert.equal(roots[0].label, null);
    assert.equal(roots[1].scope, 'version');
    assert.equal(roots[1].label, 'v3');
  });

  it('根发现是确定性的：两次扫描结果一致', async () => {
    const { discoverCockpitRoots } = await import('../src/core/project/cockpit-roots.js');
    assert.deepEqual(discoverCockpitRoots(TEST_DIR), discoverCockpitRoots(TEST_DIR));
  });

  it('合并：同一片只出一次，事实取 updatedAt 较晚的那份，roots 记下所有根', async () => {
    const { WebApi } = await import('../src/adapters/web/api.js');
    const api = new WebApi(TEST_DIR);
    const list = await api.listSlices();
    const ids = list.map((s) => s.id).sort();
    assert.deepEqual(ids, ['root-only', 'shared', 'v3-only'], 'shared 只应出现一行');

    const shared = list.find((s) => s.id === 'shared');
    assert.ok(shared);
    assert.equal(shared.state, 'frozen', '状态应取 v3 那份（updatedAt 更新）');
    assert.equal(shared.scope, 'version');
    assert.equal(shared.label, 'v3');
    assert.deepEqual(shared.roots.sort(), ['root', 'v3'], 'roots 要记下两个根');
  });

  it('详情按 scope+label 路由：读的是那个根那份', async () => {
    const { WebApi } = await import('../src/adapters/web/api.js');
    const api = new WebApi(TEST_DIR);
    const rootDetail = await api.getSlice('shared', { scope: 'root' });
    const v3Detail = await api.getSlice('shared', { scope: 'version', label: 'v3' });
    assert.ok(rootDetail && v3Detail);
    assert.equal(rootDetail.summary.scope, 'root');
    assert.equal(rootDetail.summary.label, null);
    assert.equal(v3Detail.summary.scope, 'version');
    assert.equal(v3Detail.summary.label, 'v3');
  });

  it('不存在的根不猜：scope=version label=不存在 → 找不到', async () => {
    const { WebApi } = await import('../src/adapters/web/api.js');
    const api = new WebApi(TEST_DIR);
    assert.equal(await api.getSlice('shared', { scope: 'version', label: 'nope' }), null);
  });

  it('概况按根分组并给出待签请求的 scope/label 路由凭据', async () => {
    const { WebApi } = await import('../src/adapters/web/api.js');
    const api = new WebApi(TEST_DIR);
    const summary = (await api.summary()) as {
      totalSlices: number;
      roots: Array<{ scope: string; label: string | null; total: number }>;
      pendingSigns: unknown[];
    };
    assert.equal(summary.totalSlices, 3);
    assert.equal(summary.roots.length, 2);
    const v3 = summary.roots.find((r) => r.label === 'v3');
    assert.ok(v3);
    assert.equal(v3.total, 2);
  });

  it('工程信息列出扫到的根 —— 看见哪些目录本身是信息', async () => {
    const { WebApi } = await import('../src/adapters/web/api.js');
    const api = new WebApi(TEST_DIR);
    const info = (await api.projectInfo()) as { roots: Array<{ scope: string; label: string | null }> };
    assert.deepEqual(info.roots.map((r) => r.label), [null, 'v3']);
  });

  it('无版本工作目录时零行为变化：只有仓库根', async () => {
    const plain = join(tmpdir(), `zelto-single-root-${Date.now()}`);
    await setupRoot(plain, 'only');
    try {
      const { WebApi } = await import('../src/adapters/web/api.js');
      const api = new WebApi(plain);
      const list = await api.listSlices();
      assert.equal(list.length, 1);
      assert.equal(list[0].scope, 'root');
      assert.deepEqual(list[0].roots, ['root']);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});
