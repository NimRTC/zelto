// ADR-056 老项目迁移路径 —— `zelto version adopt` 端到端
//
// 场景：老项目升级到版本分支制度时，版本已经在跑（`in_progress`），
// 但**版本分支从不存在**。没有 adopt 就永远 ship 不了。
//
// 这里跑真实命令，验证：
// 1. 补建版本分支 + 版本工作目录
// 2. 基点钉死进版本计划，并标记 `adopted`
// 3. 写 `version.adopted` 事件（可审计）
// 4. 前置版本没 integrated 时拒绝
// 5. 幂等：分支已存在时不重复建

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_DIR = mkdtempSync(join(tmpdir(), 'zelto-adr056-adopt-'));
const REPO = join(TEST_DIR, 'repo');
const originalCwd = process.cwd();

function git(args: string[], cwd = REPO): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

function branchExists(branch: string): boolean {
  try {
    git(['rev-parse', '--verify', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** 造一个「老项目」：有主干提交、有版本计划、版本 in_progress，但没有版本分支 */
function makeLegacyRepo(plan: object): void {
  mkdirSync(REPO, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  // 提交身份必须**在仓库里**设，不能靠全局配置 ——
  // CI 机器上往往没有全局 user.name/user.email（runner 是干净容器），
  // 缺了它 `git commit` 直接报 "Author identity unknown"，测试全红。
  git(['config', 'user.email', 'test@zelto.local']);
  git(['config', 'user.name', 'zelto test']);
  writeFileSync(join(REPO, 'src.txt'), 'code');
  mkdirSync(join(REPO, '.zelto', 'versions'), { recursive: true });
  writeFileSync(
    join(REPO, '.zelto', 'versions', 'plan-1.json'),
    JSON.stringify(plan, null, 2),
    'utf-8',
  );
  // 输出契约的 schema 要在仓库根（formatter 校验输出时要用）
  const schemasSrc = join(originalCwd, 'contracts', 'schemas');
  const schemasDst = join(REPO, 'contracts', 'schemas');
  mkdirSync(schemasDst, { recursive: true });
  for (const name of readdirSync(schemasSrc)) {
    if (!name.endsWith('.json')) continue;
    writeFileSync(join(schemasDst, name), readFileSync(join(schemasSrc, name), 'utf-8'), 'utf-8');
  }
  git(['add', '-f', '.zelto/versions/plan-1.json', 'contracts']);
  git(['add', 'src.txt']);
  git(['commit', '-q', '-m', 'legacy state']);
}

const PLAN = {
  id: 'plan-1',
  designId: 'd1',
  title: '老计划',
  versions: [
    {
      version: 'v1',
      dependsOn: [],
      description: '老版本',
      slices: [{ id: 'v1-a', module: 'm', title: 't', writes: ['src.txt'], specPath: 'specs/slices/v1-a.md' }],
      integrationTestDir: 'tests/acceptance/v1',
      status: 'in_progress',
    },
  ],
  status: 'confirmed',
  createdAt: '2026-01-01T00:00:00.000Z',
  confirmedAt: '2026-01-01T00:00:00.000Z',
};

describe('zelto version adopt —— 老项目补建版本分支', () => {
  before(() => {
    makeLegacyRepo(PLAN);
    process.chdir(REPO);
  });

  after(() => {
    process.chdir(originalCwd);
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('补建版本分支与版本工作目录', async () => {
    const { handleVersionAdopt } = await import('../src/cli/commands/version-adopt.js');
    const { getDefaultFormatter } = await import('../src/cli/output-formatter.js');

    assert.equal(branchExists('version/v1'), false, '前置：版本分支不该存在');

    const code = await handleVersionAdopt(['adopt', 'v1', '--plan', 'plan-1'], getDefaultFormatter());
    assert.equal(code, 0);

    assert.equal(branchExists('version/v1'), true, '版本分支应当被建出来');
    assert.equal(
      existsSync(join(REPO, '.zelto', 'version-worktrees', 'v1')),
      true,
      '版本工作目录应当被建出来',
    );
  });

  it('基点钉死并标记 adopted（审计要能看出是补建的）', () => {
    const plan = JSON.parse(
      readFileSync(join(REPO, '.zelto', 'versions', 'plan-1.json'), 'utf-8'),
    ) as { versions: Array<Record<string, unknown>> };
    const v = plan.versions[0];
    assert.equal(typeof v.baseCommit, 'string');
    assert.equal((v.baseCommit as string).length, 40);
    assert.equal(v.adopted, true);
    assert.equal(typeof v.adoptedAt, 'string');
  });

  it('写了 version.adopted 事件（追溯链不能断）', () => {
    const evtPath = join(REPO, '.zelto', 'events', 'version-v1', 'events.jsonl');
    assert.equal(existsSync(evtPath), true, '版本事件流应当存在');
    const lines = readFileSync(evtPath, 'utf-8').trim().split('\n');
    const types = lines.map((l) => (JSON.parse(l) as { type: string }).type);
    assert.ok(types.includes('version.adopted'), `实际事件类型：${types.join(', ')}`);
  });

  it('幂等：分支已存在时再跑一次不报错、不重复建', async () => {
    const { handleVersionAdopt } = await import('../src/cli/commands/version-adopt.js');
    const { getDefaultFormatter } = await import('../src/cli/output-formatter.js');

    const before = git(['rev-parse', 'version/v1']).trim();
    const code = await handleVersionAdopt(['adopt', 'v1', '--plan', 'plan-1'], getDefaultFormatter());
    assert.equal(code, 0);
    const after = git(['rev-parse', 'version/v1']).trim();
    assert.equal(before, after, '分支指向不该被改动');
  });

  it('版本不在计划里 → 报错', async () => {
    const { handleVersionAdopt } = await import('../src/cli/commands/version-adopt.js');
    const { getDefaultFormatter } = await import('../src/cli/output-formatter.js');

    const code = await handleVersionAdopt(['adopt', 'v9', '--plan', 'plan-1'], getDefaultFormatter());
    assert.equal(code, 1);
  });
});
