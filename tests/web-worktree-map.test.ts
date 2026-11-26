// 执行目录脉络（多工作区进展）—— 驾驶舱要能回答「这场仗分成几条战线」
//
// 病灶（实测 nimrtc-v14，2026-11-26）：
//
//   同一个仓库在盘上有 6 份检出：
//
//     D:/MyOpen/nimrtc-v14                          ← 仓库根
//     D:/MyOpen/_wt_v14_code                        ← git 额外工作区（不是 zelto 建的）
//     D:/MyOpen/_wt_v14_docs                        ← 同上
//     .zelto/version-worktrees/v1..v4                ← 版本集成目录
//     .zelto/worktrees/<sliceId>                     ← 切片执行目录（zelto run 建的）
//
//   驾驶舱 ADR-112 之后只看得见前两类中的「仓库根 + 版本目录」，
//   另外两类在 UI 里**根本不存在** —— 人在那些工作区里做的事，
//   驾驶舱一个字也不提。
//
// 这个文件钉住：
//   1. discoverWorktrees 的四类判定（纯文件事实 + 注入的 git 事实）
//   2. 同一路径不重复、顺序稳定
//   3. `/api/worktrees` 把「执行目录」与「它那片的状态（借自真正的根）」并排给出

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverWorktrees, normalizeDir, type GitWorktreeEntry } from '../src/core/project/worktree-map.js';

const REPO = join(tmpdir(), `zelto-wtmap-${Date.now()}`);

async function mkZeltoState(dir: string): Promise<void> {
  await mkdir(join(dir, '.zelto', 'slices'), { recursive: true });
  await mkdir(join(dir, '.zelto', 'events'), { recursive: true });
}

describe('discoverWorktrees：四类战线分开认', () => {
  before(async () => {
    await mkZeltoState(REPO);
    await mkZeltoState(join(REPO, '.zelto', 'version-worktrees', 'v4'));
    // 执行目录：目录存在就算（里面可以有基线快照）
    await mkdir(join(REPO, '.zelto', 'worktrees', 'v4-n2-ice-tcp', '.zelto', 'slices'), { recursive: true });
    // 空目录不算版本集成目录
    await mkdir(join(REPO, '.zelto', 'version-worktrees', 'v9'), { recursive: true });
  });
  after(async () => {
    await rm(REPO, { recursive: true, force: true });
  });

  it('仓库根 / 版本目录 / 执行目录各自归类；无状态的版本目录不列', () => {
    const out = discoverWorktrees(REPO);
    const kinds = out.map((e) => `${e.kind}:${e.label ?? ''}`);
    assert.deepEqual(kinds, ['root:', 'version:v4', 'slice:v4-n2-ice-tcp']);
    assert.equal(out[0].hasZeltoState, true);
    assert.equal(out[1].hasZeltoState, true);
    // 执行目录里那份 .zelto 是基线快照 —— 照样标「有」，人自己看依据
    assert.equal(out[2].hasZeltoState, true);
    assert.match(out[2].evidence, /zelto run/);
    assert.ok(!out.some((e) => e.label === 'v9'), '空版本目录不是状态');
  });

  it('git 额外工作区：认、但不把 .zelto 底下的重复成一条', () => {
    const repoPrefix = normalizeDir(REPO);
    const git: GitWorktreeEntry[] = [
      { path: REPO, branch: 'feat/v14-turn-tls', head: '43e09ce9', detachable: false },
      { path: join(REPO, '.zelto', 'version-worktrees', 'v4'), branch: 'version/v4', head: 'a2bb408c', detachable: false },
      { path: join(REPO, '.zelto', 'worktrees', 'v4-n2-ice-tcp'), branch: 'slice/v4-n2-ice-tcp', head: '1234567', detachable: false },
      { path: 'D:/MyOpen_elsewhere/_wt_code', branch: 'feature/v14-turn-tls-code', head: 'a9aa6a08', detachable: false },
      { path: 'D:/MyOpen_elsewhere/_wt_docs', branch: null, head: 'f9af86dc', detachable: true },
    ];
    const out = discoverWorktrees(REPO, git);
    const kinds = out.map((e) => `${e.kind}:${e.label ?? e.branch ?? (e.head ?? '').slice(0, 8)}`);
    assert.deepEqual(kinds, [
      'root:feat/v14-turn-tls',
      'version:v4',
      'slice:v4-n2-ice-tcp',
      'extra:feature/v14-turn-tls-code',
      'extra:f9af86dc',
    ]);
    // 分支 / HEAD 来自 git
    assert.equal(out[1].branch, 'version/v4');
    assert.equal(out[2].branch, 'slice/v4-n2-ice-tcp');
    assert.equal(out[4].branch, null, 'detached 没有分支 —— null，不编一个');
    assert.equal(out[3].hasZeltoState, false);
    // 同一路径只出现一次
    const dirs = out.map((e) => normalizeDir(e.dir));
    assert.equal(new Set(dirs).size, dirs.length);
    void repoPrefix;
  });

  it('没有 git 事实时（不传 / 空）：行为与改造前一致，不多出一条', () => {
    const out = discoverWorktrees(REPO, []);
    assert.equal(out.filter((e) => e.kind === 'extra').length, 0);
    assert.equal(out[0].branch, null);
    assert.equal(out[0].head, null);
  });
});

// ─── /api/worktrees 端到端（真实 git 仓 + 一处执行目录）──────────────

const GIT_REPO = join(tmpdir(), `zelto-wtmap-api-${Date.now()}`);

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
    trace: { requirements: [], contracts: [], tests: [] },
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

describe('/api/worktrees：执行目录的切片状态借自它真正的根', () => {
  before(async () => {
    const { execFileSync } = await import('node:child_process');
    await mkdir(GIT_REPO, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: GIT_REPO });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: GIT_REPO });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: GIT_REPO });
    await writeFile(join(GIT_REPO, 'README.md'), 'x\n', 'utf-8');
    execFileSync('git', ['add', '.'], { cwd: GIT_REPO });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: GIT_REPO });
    // 版本目录 v4：有状态，但没东西（只验脉络）
    await mkZeltoState(join(GIT_REPO, '.zelto', 'version-worktrees', 'v4'));
    // 切片在版本目录 v4 里"完成"，同时存在一个执行目录
    await writeSlice(join(GIT_REPO, '.zelto', 'version-worktrees', 'v4'), 'v4-n2-ice-tcp', 'completed');
    await mkdir(join(GIT_REPO, '.zelto', 'worktrees', 'v4-n2-ice-tcp', '.zelto', 'slices'), { recursive: true });
    // 一个真正的 git 额外工作区（不在 .zelto 底下）
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'feature/extra', join(tmpdir(), `zelto-extra-${Date.now()}`)], {
      cwd: GIT_REPO,
      stdio: 'ignore',
    });
  });
  after(async () => {
    const { execFileSync } = await import('node:child_process');
    try {
      const r = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: GIT_REPO, encoding: 'utf-8' });
      for (const line of r.split('\n')) {
        if (line.startsWith('worktree ') && !normalizeDir(line.slice(9)).endsWith(normalizeDir(GIT_REPO))) {
          execFileSync('git', ['worktree', 'remove', '--force', line.slice(9)], { cwd: GIT_REPO, stdio: 'ignore' });
        }
      }
    } catch {
      // 清理尽力而为
    }
    await rm(GIT_REPO, { recursive: true, force: true });
  });

  it('四类战线都在，且执行目录那片的 state 来自版本目录', async () => {
    const { WebApi } = await import('../src/adapters/web/api.js');
    const api = new WebApi(GIT_REPO);
    const map = (await api.worktreeMap()) as {
      entries: Array<{ kind: string; label: string | null; branch: string | null; hasZeltoState: boolean; slices: Array<{ id: string; state: string; scope: string }> }>;
    };
    const kinds = map.entries.map((e) => e.kind);
    assert.ok(kinds.includes('root'));
    assert.ok(kinds.includes('version'));
    assert.ok(kinds.includes('slice'));
    assert.ok(kinds.includes('extra'), 'git 额外工作区要出现');

    const sliceEntry = map.entries.find((e) => e.kind === 'slice');
    assert.ok(sliceEntry);
    assert.equal(sliceEntry.label, 'v4-n2-ice-tcp');
    assert.equal(sliceEntry.slices.length, 1);
    assert.equal(sliceEntry.slices[0].state, 'completed');
    assert.equal(sliceEntry.slices[0].scope, 'version', '状态借自版本目录，不是执行目录的基线快照');
  });
});

// ─── 版本战线的「活是否已在主干里」+ 版本行按计划补片 ─────────────────
//
// 病灶（实测 nimrtc-v14，2026-11-26）：驾驶舱把 v1..v4 四条版本战线
// 一视同仁地列出来，人读成「4 个版本在并行」—— 而 v1..v3 早就合进了主干。
// 另外 v4 的三条冻结切片状态落在**仓库根**（label 没改），
// `scope|label` 分组里 v4 一行都没有 —— 版本行显示「0 片」，
// 而计划里明明白白写着 v4 有三片。两处都要用文件事实补上。

const TRUNK_REPO = join(tmpdir(), `zelto-wtmap-trunk-${Date.now()}`);

describe('版本战线：已并入主干 + 计划补片', () => {
  let extraDir = '';
  before(async () => {
    const { execFileSync } = await import('node:child_process');
    const git = (args: string[], cwd = TRUNK_REPO) =>
      execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    await mkdir(TRUNK_REPO, { recursive: true });
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 't@t']);
    git(['config', 'user.name', 't']);
    await writeFile(join(TRUNK_REPO, '.gitignore'), '.zelto/\n', 'utf-8');
    await writeFile(join(TRUNK_REPO, 'README.md'), 'x\n', 'utf-8');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'init']);

    // v4：在主干之外的分支上（还没合）。
    // 注意目录不能事先存在：`git worktree add <dir>` 对已存在的目录直接报
    // "already exists"（不管里面是不是空的）。git 自己会把中间目录建出来。
    // 不能事先 mkdir 这个目录：`git worktree add <dir>` 对已存在的目录直接报
    // "already exists"（不管里面是不是空的）。git 自己会建出中间目录。
    // 分支名带唯一后缀：`git worktree add` 是**按路径**登记在 git 里的，
    // 同名分支在多个临时仓之间反复建/删会让 git 报 "already exists"。
    const v4Dir = join(TRUNK_REPO, '.zelto', 'version-worktrees', 'v4');
    git(['worktree', 'add', '-q', '-b', `version/v4-${Date.now()}`, v4Dir]);
    // v4 必须在主干之外**有自己的提交**——否则它 HEAD 就是主干 HEAD 本身，
    // `merge-base --is-ancestor` 判成「已在主干」，测的就不是「未合并」那条路。
    await writeFile(join(v4Dir, 'v4.txt'), 'v4\n', 'utf-8');
    git(['add', 'v4.txt'], v4Dir);
    git(['commit', '-q', '-m', 'v4 work'], v4Dir);
    await mkZeltoState(join(TRUNK_REPO, '.zelto', 'version-worktrees', 'v4'));
    // v3：合进主干之前的另一条分支，合完再建目录
    extraDir = join(tmpdir(), `zelto-wtmap-trunk-x-${Date.now()}`);
    git(['worktree', 'add', '-q', '-b', 'version/v3', extraDir]);
    await writeFile(join(extraDir, 'v3.txt'), 'v3\n', 'utf-8');
    git(['add', 'v3.txt'], extraDir);
    git(['commit', '-q', '-m', 'v3 work'], extraDir);
    git(['merge', '--no-ff', '-q', '-m', 'merge v3', 'version/v3']);
    // v3 的状态目录建在**主干检出**里（盘上事实：.zelto 被 ignore，任何检出都可以有）。
    // 注意先把 v3 工作区删掉：那个检出还在时 `git worktree list` 会把它列成
    // 一条 __extra__ 战线，压过后面按目录发现的版本战线 —— 而这里的场景是
    // 「v3 早已收起，只剩盘上的状态目录」。
    git(['worktree', 'remove', '--force', extraDir]);
    await mkZeltoState(join(TRUNK_REPO, '.zelto', 'version-worktrees', 'v3'));

    // 计划：v4 点名三片；它们的切片状态在**仓库根**（label 没改）
    const plan = {
      id: 'plan-test',
      designId: 'd',
      title: 't',
      status: 'confirmed',
      createdAt: '2026-01-01T00:00:00.000Z',
      confirmedAt: '2026-01-01T00:00:00.000Z',
      versions: [
        {
          version: 'v4',
          dependsOn: [],
          description: 'd',
          integrationTestDir: '',
          status: 'in_progress',
          slices: ['v4-a', 'v4-b'].map((id) => ({
            id, module: 'm', title: id, writes: [], specPath: `specs/slices/${id}.md`,
          })),
        },
        {
          version: 'v3',
          dependsOn: [],
          description: 'd',
          integrationTestDir: '',
          status: 'delivered',
          slices: [],
        },
      ],
    };
    await mkdir(join(TRUNK_REPO, '.zelto', 'versions'), { recursive: true });
    await writeFile(join(TRUNK_REPO, '.zelto', 'versions', 'plan-test.json'), JSON.stringify(plan), 'utf-8');
    await writeSlice(TRUNK_REPO, 'v4-a', 'frozen');
    await writeSlice(TRUNK_REPO, 'v4-b', 'frozen');
  });
  after(async () => {
    const { execFileSync } = await import('node:child_process');
    try {
      for (const line of execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: TRUNK_REPO, encoding: 'utf-8' }).split('\n')) {
        if (line.startsWith('worktree ') && normalizeDir(line.slice(9)) !== normalizeDir(TRUNK_REPO)) {
          execFileSync('git', ['worktree', 'remove', '--force', line.slice(9)], { cwd: TRUNK_REPO, stdio: 'ignore' });
        }
      }
    } catch {
      // 尽力而为
    }
    await rm(TRUNK_REPO, { recursive: true, force: true });
    await rm(extraDir, { recursive: true, force: true });
  });

  it('已合进主干的版本标 mergedIntoTrunk=true，未合的标 false', async () => {
    const { WebApi } = await import('../src/adapters/web/api.js');
    const map = (await new WebApi(TRUNK_REPO).worktreeMap()) as {
      entries: Array<{ kind: string; label: string | null; mergedIntoTrunk?: boolean | null }>;
    };
    const v3 = map.entries.find((e) => e.kind === 'version' && e.label === 'v3');
    const v4 = map.entries.find((e) => e.kind === 'version' && e.label === 'v4');
    assert.ok(v3 && v4, JSON.stringify(map.entries.map((e) => [e.kind, e.label, e.mergedIntoTrunk])));
    assert.equal(v3.mergedIntoTrunk, true, 'v3 的 HEAD 是主干祖先 = 已并入');
    assert.equal(v4.mergedIntoTrunk, false, 'v4 有自己没合进主干的提交: ' + JSON.stringify(map.entries.filter((e) => e.label === 'v4')));
  });

  it('版本行的切片按计划补齐（状态在根、label 未改也要出现）', async () => {
    const { WebApi } = await import('../src/adapters/web/api.js');
    const map = (await new WebApi(TRUNK_REPO).worktreeMap()) as {
      entries: Array<{ kind: string; label: string | null; slices: Array<{ id: string; state: string }> }>;
    };
    const v4 = map.entries.find((e) => e.kind === 'version' && e.label === 'v4');
    assert.ok(v4);
    const ids = v4.slices.map((s) => s.id);
    assert.deepEqual(ids, ['v4-a', 'v4-b'], '计划点名的切片要出现在这条版本战线上');
    assert.equal(v4.slices[0].state, 'frozen');
  });

  it('没有本地主干时退到远端主干（nimrtc 形态：本地没有 main）', async () => {
    const { execFileSync } = await import('node:child_process');
    // 一个干净仓库：本地只有 feat-x，远端（bare）有 main。
    // 版本目录 v3 是普通检出目录，HEAD = feat-x 的提交（已合进远端 main）。
    const bare = join(tmpdir(), `zelto-trunk-bare-${Date.now()}`);
    const seed = join(tmpdir(), `zelto-trunk-seed-${Date.now()}`);
    const local = join(tmpdir(), `zelto-trunk-local-${Date.now()}`);
    const g = (args: string[], cwd: string) =>
      execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    await mkdir(seed, { recursive: true });
    await mkdir(bare, { recursive: true });
    g(['init', '-q', '-b', 'main'], bare);
    g(['init', '-q', '-b', 'main'], seed);
    g(['config', 'user.email', 't@t'], seed);
    g(['config', 'user.name', 't'], seed);
    g(['commit', '-q', '--allow-empty', '-m', 'init'], seed);
    await writeFile(join(seed, 'a.txt'), 'a\n', 'utf-8');
    g(['add', '.'], seed);
    g(['commit', '-q', '-m', 'a'], seed);
    // 远端 main 是第一个提交，第二个提交在 feat-x 上并已合回 main
    g(['checkout', '-q', '-b', 'feat-x'], seed);
    await writeFile(join(seed, 'b.txt'), 'b\n', 'utf-8');
    g(['add', '.'], seed);
    g(['commit', '-q', '-m', 'b'], seed);
    g(['checkout', '-q', 'main'], seed);
    g(['merge', '-q', '--ff', 'feat-x'], seed);
    g(['symbolic-ref', 'HEAD', 'refs/heads/main'], bare);
    g(['config', 'receive.denyCurrentBranch', 'ignore'], bare);
    g(['push', '-q', bare, 'main', 'feat-x'], seed);

    g(['clone', '-q', '-b', 'feat-x', bare, local], seed);
    await mkZeltoState(join(local, '.zelto', 'version-worktrees', 'v3'));
    const { WebApi } = await import('../src/adapters/web/api.js');
    const map = (await new WebApi(local).worktreeMap()) as {
      entries: Array<{ kind: string; label: string | null; mergedIntoTrunk?: boolean | null; branch: string | null }>;
    };
    const v3 = map.entries.find((e) => e.kind === 'version' && e.label === 'v3');
    assert.ok(v3, JSON.stringify(map.entries.map((e) => [e.kind, e.label])));
    assert.equal(v3.mergedIntoTrunk, true, JSON.stringify(map.entries.map((e) => [e.kind, e.label, e.branch, e.mergedIntoTrunk])));
    // 本地没有 main；它检出在 feat-x 上 —— 普通检出目录的 HEAD 已合进远端 main
    assert.equal(v3.mergedIntoTrunk, true, JSON.stringify(map.entries.map((e) => [e.kind, e.label, e.branch, e.mergedIntoTrunk])));
    await rm(bare, { recursive: true, force: true });
    await rm(seed, { recursive: true, force: true });
    await rm(local, { recursive: true, force: true });
  });
});
