// 版本基点：计划里钉死的 baseCommit 优先于主干 HEAD
//
// 背景（nimrtc 1.4 演练）：版本要接在一条**不是主干**的分支上
// （`feat/v14-turn-tls`），而这种接法下 `version/<label>` 的 tip 就是那个
// 提交本身 —— 再「跟着分支 tip 走」只会把钉死的基点换掉。所以：
//   1. 计划里钉了 baseCommit → 就从这个提交建分支（哪怕它不是主干 HEAD）
//   2. 钉了但解析不出来 → 报错，不静默退回主干
//   3. 没钉 → 维持旧行为（主干 HEAD）
//
// C3：全部是确定性判定（读文件 + git），不调模型、不触网。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { resolveVersionBaseCommit } from '../src/cli/commands/version-runtime.js';
import { applyPlanPatch } from '../src/core/version/patch.js';
import type { VersionPlan } from '../src/core/version/types.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function makePlan(opts: { branch?: string; baseCommit?: string | null }): VersionPlan {
  return {
    id: 'plan-v14',
    designId: 'd1',
    title: '钉基点',
    versions: [
      {
        version: 'v14',
        dependsOn: [],
        description: '版本 v14',
        slices: [],
        integrationTestDir: 'tests/acceptance/v14/',
        status: 'planned',
        branch: opts.branch,
        baseCommit: opts.baseCommit ?? null,
      },
    ],
    status: 'confirmed',
    createdAt: '2026-01-01T00:00:00.000Z',
    confirmedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('版本基点：计划钉死的 baseCommit', () => {
  let root: string;
  let mainHead: string;
  let featTip: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'zelto-version-base-'));
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    writeFileSync(join(root, 'a.txt'), 'base\n', 'utf-8');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'base');
    mainHead = git(root, 'rev-parse', 'HEAD');

    // 一条不是主干的分支——模拟 feat/v14-turn-tls
    git(root, 'checkout', '-b', 'feat/v14-turn-tls');
    writeFileSync(join(root, 'b.txt'), 'feat\n', 'utf-8');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'feat: v14 work');
    featTip = git(root, 'rev-parse', 'HEAD');
    git(root, 'checkout', 'main');
    git(root, 'checkout', '--detach', mainHead);
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('钉死的 baseCommit 胜过主干 HEAD', () => {
    const { commit, source } = resolveVersionBaseCommit(
      makePlan({ branch: 'feat/v14-turn-tls', baseCommit: featTip }).versions[0],
      makePlan({}),
      root,
    );
    assert.equal(commit, featTip);
    assert.notEqual(commit, mainHead);
    assert.match(source, /钉死/);
  });

  it('钉死的 baseCommit 解析不出来 → 报错，不回退主干', () => {
    const { commit, source } = resolveVersionBaseCommit(
      makePlan({ baseCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }).versions[0],
      makePlan({}),
      root,
    );
    assert.equal(commit, null);
    assert.match(source, /解析不出来/);
  });

  it('没钉 → 仍是主干 HEAD', () => {
    const { commit, source } = resolveVersionBaseCommit(
      makePlan({}).versions[0],
      makePlan({}),
      root,
    );
    assert.equal(commit, mainHead);
    assert.equal(source, '主干 HEAD');
  });

  it('有前置版本且其分支存在 → 仍然优先取前置版本 tip', () => {
    const plan = makePlan({ baseCommit: mainHead });
    plan.versions[0].dependsOn = ['v13'];
    plan.versions.unshift({
      // 前置版本的 label 派生成 `version/v13`；用 branch 字段指向真实存在的分支
      version: 'v13',
      dependsOn: [],
      description: 'v13',
      slices: [],
      integrationTestDir: 'tests/acceptance/v13/',
      status: 'integrated',
      branch: 'feat/v14-turn-tls',
    });
    const { commit, source } = resolveVersionBaseCommit(plan.versions[1], plan, root);
    assert.equal(commit, featTip);
    assert.match(source, /前置版本 v13/);
  });
});

describe('plan-patch 能钉死版本基点', () => {
  // 背景（ZD-004）：版本基点只能从 main HEAD 推出来，但有一类版本必须
  // 从非主干的地方拉（nimrtc v1.4 开发在 feat/v14-turn-tls 上）。
  // 没有这条通道时只能手改 `.zelto/versions/<id>.json` —— 追溯链上的谎言（C4）。

  function planWith(baseCommit: string | null): VersionPlan {
    return {
      id: 'plan-x',
      designId: 'd',
      title: 't',
      versions: [
        {
          version: 'v14',
          dependsOn: [],
          description: 'desc',
          slices: [],
          integrationTestDir: 'tests/acceptance/v14/',
          status: 'planned',
          baseCommit,
        },
      ],
      status: 'confirmed',
      createdAt: '2026-01-01T00:00:00.000Z',
      confirmedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  it('applyPlanPatch 写入 baseCommit 并记进 changed', () => {
    const result = applyPlanPatch(planWith(null), {
      versions: [{ version: 'v14', baseCommit: 'abc123' }],
    });

    assert.equal(result.plan.versions[0].baseCommit, 'abc123');
    const change = result.changed.find((c) => c.field === 'baseCommit');
    assert.ok(change, 'baseCommit 的变化必须记进 changed（事件留痕，C4）');
    assert.equal(change.before, null);
    assert.equal(change.after, 'abc123');
  });

  it('不传 baseCommit → 不动它', () => {
    const result = applyPlanPatch(planWith('keepme'), {
      versions: [{ version: 'v14', description: '新描述' }],
    });

    assert.equal(result.plan.versions[0].baseCommit, 'keepme');
  });

  it('传 null → 清掉基点，回到默认解析', () => {
    const result = applyPlanPatch(planWith('old'), {
      versions: [{ version: 'v14', baseCommit: null }],
    });

    assert.equal(result.plan.versions[0].baseCommit, null);
    const change = result.changed.find((c) => c.field === 'baseCommit');
    assert.ok(change);
    assert.equal(change.before, 'old');
    assert.equal(change.after, null);
  });

  it('没找到的版本 → 记进 missingVersions，不静默', () => {
    const result = applyPlanPatch(planWith(null), {
      versions: [{ version: 'v99', baseCommit: 'abc123' }],
    });

    assert.deepEqual(result.missingVersions, ['v99']);
  });
});
