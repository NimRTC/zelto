// ADR-114：驾驶舱的分支可见性与计划对照 —— 「完成」到底在哪儿完成
//
// 病灶（实测 nimrtc-v14，2026-11-25）：
//
//   `.zelto/version-worktrees/v3/.zelto/slices/` 里 15 片全是 completed，
//   而 `version/v3` 分支上 `git ls-tree .zelto/slices/` 只有 3 片基线 ——
//   另外 12 片的「完成」只存在于那台机器的磁盘上（`.zelto/` 在 .gitignore 里）。
//
//   驾驶舱原来只看盘上的 state：「15 片全完成」说的是磁盘，不是分支；
//   版本计划里那 16 项的状态（全是 draft）和盘上状态也从没并排出现过。
//
// 这个文件钉住：
//   1. annotateBranchEvidence 的三态：在分支（true）/ 仅在盘上（false）/ 不知道（null）
//   2. 判据按「这一行事实所在的根」问 git（ADR-112 决策三的精神）
//   3. /api/summary 的偏移 —— listSlices 的行带上 onBranch
//   4. 计划对照：planCoverage 把「计划 / 盘上 / 分支」分开数，不合成

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { annotateBranchEvidence, annotateBranchEvidenceAsync, type AsyncGitProbe, type GitProbe } from '../src/core/project/branch-evidence.js';

function root(scope: 'root' | 'version', label: string | null, dir: string) {
  return { root: { scope, label, dir } };
}

/** 可控的 git 探针：把「真实的 git」换成一张表。 */
function fakeProbe(table: {
  tracked: Record<string, boolean | null>;
  head: Record<string, string | null>;
}): GitProbe {
  return {
    trackedAtHead(dir, rel) {
      const k = `${dir}|${rel}`;
      return k in table.tracked ? table.tracked[k] : false;
    },
    readAtHead(dir, rel) {
      return table.head[`${dir}|${rel}`] ?? null;
    },
  };
}

describe('ADR-114：分支证据三态', () => {
  it('在分支 / 仅在盘上 / 不知道 三种情形分开报', () => {
    const rootDir = join(tmpdir(), 'proj');
    const v3Dir = join(tmpdir(), 'proj', '.zelto', 'version-worktrees', 'v3');
    const probe = fakeProbe({
      tracked: {
        [`${rootDir}|.zelto/slices/on-branch.json`]: true,
        [`${v3Dir}|.zelto/slices/only-disk.json`]: false,
        // nogit-dir 返回 null = 拿不到 git 证据
        [`${join(tmpdir(), 'nogit')}|.zelto/slices/unknown.json`]: null,
      },
      head: {
        [`${rootDir}|.zelto/slices/on-branch.json`]: JSON.stringify({ state: 'frozen' }),
      },
    });
    const roots = [
      root('root', null, rootDir),
      root('version', 'v3', v3Dir),
      root('version', 'v9', join(tmpdir(), 'nogit')),
    ];
    const rows = [
      { id: 'on-branch', scope: 'root' as const, label: null, state: 'completed', onBranch: null, committedState: null },
      { id: 'only-disk', scope: 'version' as const, label: 'v3', state: 'completed', onBranch: null, committedState: null },
      { id: 'unknown', scope: 'version' as const, label: 'v9', state: 'running', onBranch: null, committedState: null },
    ];

    const out = annotateBranchEvidence(roots, rows, probe);
    assert.equal(out[0].onBranch, true);
    assert.equal(out[0].committedState, 'frozen');
    assert.equal(out[1].onBranch, false);
    assert.equal(out[1].committedState, null);
    assert.equal(out[2].onBranch, null, '拿不到证据时说「不知道」，不说「没有」');
    // 不改入参
    assert.equal(rows[0].onBranch, null);
  });

  it('判据按「这一行所在的根」问 git —— 不同根各自的跟踪状态分开', () => {
    const rootDir = join(tmpdir(), 'p2');
    const v3Dir = join(tmpdir(), 'p2', '.zelto', 'version-worktrees', 'v3');
    const probe = fakeProbe({
      tracked: {
        // 同一 id：根里在分支上、v3 里只在盘上
        [`${rootDir}|.zelto/slices/shared.json`]: true,
        [`${v3Dir}|.zelto/slices/shared.json`]: false,
      },
      head: {
        [`${rootDir}|.zelto/slices/shared.json`]: JSON.stringify({ state: 'completed' }),
      },
    });
    const roots = [root('root', null, rootDir), root('version', 'v3', v3Dir)];
    const out = annotateBranchEvidence(
      roots,
      [
        { id: 'shared', scope: 'root' as const, label: null, state: 'completed', onBranch: null, committedState: null },
        { id: 'shared', scope: 'version' as const, label: 'v3', state: 'completed', onBranch: null, committedState: null },
      ],
      probe,
    );
    assert.equal(out[0].onBranch, true);
    assert.equal(out[1].onBranch, false);
  });
});

// ─── 计划对照（WebApi 级）─────────────────────────────────────────────

const REPO = join(tmpdir(), `zelto-plan-coverage-${Date.now()}`);

async function writeSlice(dir: string, id: string, state: string): Promise<void> {
  const zelto = join(dir, '.zelto');
  await mkdir(join(zelto, 'slices'), { recursive: true });
  await mkdir(join(zelto, 'events', id), { recursive: true });
  const base = {
    id,
    title: `切片 ${id}`,
    state,
    spec: { path: `specs/slices/${id}.md`, frozenHash: null, frozenAt: null },
    acceptance: { dir: `tests/acceptance/${id}/`, frozenHash: null, oracleSrc: null },
    baseCommit: null,
    drift: { detected: false, reason: null, at: null },
    trace: { requirements: ['REQ-1'], contracts: [], tests: [] },
    traceWaiver: null,
    baseline: false,
    writes: [],
    runs: [],
    clarifyRounds: 0,
    stall: { class: null, autoResolved: 0, gateRetries: 0 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  await writeFile(join(zelto, 'slices', `${id}.json`), JSON.stringify(base, null, 2), 'utf-8');
  await writeFile(join(zelto, 'events', id, 'events.jsonl'), '', 'utf-8');
}

describe('ADR-114：计划对照（计划 / 盘上 / 分支 分开数）', () => {
  before(async () => {
    await mkdir(join(REPO, '.zelto', 'versions'), { recursive: true });
    // 仓库根：一片 completed、一片 draft
    await writeSlice(REPO, 'r-done', 'completed');
    await writeSlice(REPO, 'r-todo', 'draft');
    // 版本目录 v3：一片 completed —— 仓库根看不到它，只有版本目录里有
    const v3 = join(REPO, '.zelto', 'version-worktrees', 'v3');
    await writeSlice(v3, 'v3-only', 'completed');
    // 计划（放在版本目录里 —— 版本目录的计划是真源）
    const plan = {
      id: 'plan-x',
      designId: 'dsg-x',
      title: '示例计划',
      status: 'confirmed',
      createdAt: '2026-01-01T00:00:00.000Z',
      confirmedAt: '2026-01-01T00:00:00.000Z',
      versions: [
        {
          version: 'v3',
          dependsOn: [],
          description: '第一版',
          integrationTestDir: 'tests/version/v3',
          status: 'in_progress',
          slices: [
            { id: 'r-done', module: 'm', title: 'done', writes: [], specPath: 'specs/slices/r-done.md', state: 'draft' },
            { id: 'plan-only', module: 'm', title: '只在计划里', writes: [], specPath: 'specs/slices/plan-only.md', state: 'draft' },
          ],
        },
      ],
    };
    await mkdir(join(v3, '.zelto', 'versions'), { recursive: true });
    await writeFile(join(v3, '.zelto', 'versions', 'plan-x.json'), JSON.stringify(plan, null, 2), 'utf-8');
  });
  after(async () => {
    await rm(REPO, { recursive: true, force: true });
  });

  it('读到版本目录里的计划，并按片给出计划/盘上对照', async () => {
    const { WebApi } = await import('../src/adapters/web/api.js');
    const api = new WebApi(REPO);
    const coverage = (await api.planCoverage()) as {
      plans: Array<{
        id: string;
        scope: string;
        label: string | null;
        versions: Array<{
          version: string;
          slices: Array<{ id: string; onDisk: boolean; actualState: string | null; plannedState: string }>;
          counts: { planned: number; onDisk: number; completed: number; onBranch: number; artifactOnBranch: number };
        }>;
      }>;
    };
    assert.equal(coverage.plans.length, 1);
    const p = coverage.plans[0];
    assert.equal(p.id, 'plan-x');
    assert.equal(p.scope, 'version');
    assert.equal(p.label, 'v3');

    const v = p.versions[0];
    // artifactOnBranch 是 ADR-126 新加的列：测试仓库里没有 Refs-Slice 提交，恒 0
    // artifactOnAncestor 是 ADR-126r2 的祖先列，同仓库同分支下同为 0
    assert.deepEqual(v.counts, {
      planned: 2,
      onDisk: 1,
      completed: 1,
      onBranch: 0,
      artifactOnBranch: 0,
      artifactOnAncestor: 0,
    });
    const done = v.slices.find((s) => s.id === 'r-done');
    assert.ok(done);
    assert.equal(done.plannedState, 'draft', '计划里那份仍是 draft —— 计划没跟上盘上');
    assert.equal(done.actualState, 'completed');
    const onlyPlan = v.slices.find((s) => s.id === 'plan-only');
    assert.equal(onlyPlan?.onDisk, false);
  });

  it('listSlices 的行带上 onBranch（非 git 目录 → null，不是 false）', async () => {
    const { WebApi } = await import('../src/adapters/web/api.js');
    const api = new WebApi(REPO);
    const rows = await api.listSlices();
    const done = rows.find((r) => r.id === 'r-done');
    assert.ok(done);
    assert.equal(done.onBranch, null);
  });
});

// ─── 异步探针（驾驶舱的路径）──────────────────────────────────────────
//
// 为什么必须有用例钉住异步版：同步 `execFileSync` 会把事件循环卡住 ——
// 实测 24 行切片让 `/api/slices` 阻塞 93 秒，`/api/health` 也跟着排队，
// 驾驶舱页面永远停在「加载中…」。异步版与同步版**判据逐字相同**，
// 这里钉的是「同一张假表，两个实现给出同一份答案」。

function fakeAsyncProbe(table: {
  tracked: Record<string, boolean | null>;
  head: Record<string, string | null>;
}): AsyncGitProbe {
  return {
    async trackedAtHeadMany(dir, rels) {
      let unknown = false;
      const same = new Set<string>();
      const notTracked = new Set<string>();
      for (const rel of rels) {
        const k = `${dir}|${rel}`;
        const v = k in table.tracked ? (table.tracked[k] as boolean | null) : false;
        if (v === null) unknown = true;
        else if (v) same.add(rel);
        else notTracked.add(rel);
      }
      return unknown ? null : { same, notTracked };
    },
    async readAtHeadMany(dir, rels) {
      return new Map(rels.map((rel) => [rel, table.head[`${dir}|${rel}`] ?? null]));
    },
  };
}

describe('ADR-114：异步探针与同步探针给出同一份证据', () => {
  it('三态、按根问 git、不改入参 —— 与 annotateBranchEvidence 逐条一致', async () => {
    const rootDir = join(tmpdir(), 'proj-a');
    const v3Dir = join(tmpdir(), 'proj-a', '.zelto', 'version-worktrees', 'v3');
    const table = {
      tracked: {
        [`${rootDir}|.zelto/slices/on-branch.json`]: true,
        [`${v3Dir}|.zelto/slices/only-disk.json`]: false,
        [`${join(tmpdir(), 'nogit-a')}|.zelto/slices/unknown.json`]: null,
      },
      head: {
        [`${rootDir}|.zelto/slices/on-branch.json`]: JSON.stringify({ state: 'frozen' }),
      },
    };
    const roots = [
      root('root', null, rootDir),
      root('version', 'v3', v3Dir),
      root('version', 'v9', join(tmpdir(), 'nogit-a')),
    ];
    const rows = [
      { id: 'on-branch', scope: 'root' as const, label: null, state: 'completed', onBranch: null, committedState: null },
      { id: 'only-disk', scope: 'version' as const, label: 'v3', state: 'completed', onBranch: null, committedState: null },
      { id: 'unknown', scope: 'version' as const, label: 'v9', state: 'running', onBranch: null, committedState: null },
    ];

    const sync = annotateBranchEvidence(roots, rows, fakeProbe(table));
    const async = await annotateBranchEvidenceAsync(roots, rows, fakeAsyncProbe(table));

    assert.deepEqual(async, sync);
    assert.equal(async[0].committedState, 'frozen');
    assert.equal(async[1].onBranch, false);
    assert.equal(async[2].onBranch, null);
    assert.equal(rows[0].onBranch, null, '异步版也不许改入参');
  });

  it('探针抛错 → 这一行是「不知道」，不是「不在」', async () => {
    const rootDir = join(tmpdir(), 'proj-b');
    const probe: AsyncGitProbe = {
      async trackedAtHeadMany() {
        throw new Error('git 起不来');
      },
      async readAtHeadMany() {
        return new Map();
      },
    };
    const out = await annotateBranchEvidenceAsync(
      [root('root', null, rootDir)],
      [{ id: 'x', scope: 'root' as const, label: null, state: 'completed', onBranch: null, committedState: null }],
      probe,
    );
    assert.equal(out[0].onBranch, null);
  });
});
