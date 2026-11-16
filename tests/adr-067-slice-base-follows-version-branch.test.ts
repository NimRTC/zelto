// ADR-067：切片的基点必须跟随归属版本分支推进
//
// 实测缺陷 D-28（nimrtc-zelto 第二轮演练）：
//
//   版本 v1 的第二片 `v1-engineimpl` 从**主干 HEAD** 建 worktree，
//   而不是从**版本分支的 tip**。于是 agent 看不到前一片
//   `v1-rtcpprocessor` 的产物（`rtcp_processor.hpp` 等），
//   被迫**重新实现**上一片的内容。
//
//   更糟的是写集审计的**误报**：基点..HEAD 之间的提交里混进了
//   上一片的三个文件（经一次事后快进），审计把它们算成
//   「本片 agent 越界写入」，切片退回 frozen。
//
// 两条判据要守住：
//   1. 基点解析：显式覆盖 > 已钉死 > 归属版本分支 tip > 主干 HEAD
//   2. 审计范围：只算本片自己产出的提交（`Refs-Slice:` trailer）
//
// C3：全部是确定性判定（读文件 + git），不调模型、不触网。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { resolveSliceBaseCommit } from '../src/cli/commands/shared.js';
import {
  commitsOfSlice,
  hasRefsSlice,
  auditWorktreeWrites,
} from '../src/core/sched/audit.js';
import type { VersionPlan } from '../src/core/version/types.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/** 建一个最小 git 仓库：main 分支 + 一个版本分支。 */
function makeRepo(): { root: string; head: string; versionTip: string } {
  const root = mkdtempSync(join(tmpdir(), 'zelto-adr067-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');

  writeFileSync(join(root, 'a.txt'), 'base\n', 'utf-8');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');
  const head = git(root, 'rev-parse', 'HEAD');

  // 版本分支：从 main 拉出来，加一个提交
  git(root, 'branch', 'version/v1', head);
  git(root, 'checkout', 'version/v1');
  writeFileSync(join(root, 'b.txt'), 'version content\n', 'utf-8');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'feat: version v1 work');
  const versionTip = git(root, 'rev-parse', 'HEAD');

  // 回到 main，main 不含 b.txt
  git(root, 'checkout', 'main');

  return { root, head, versionTip };
}

function writePlan(dir: string, plan: VersionPlan): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${plan.id}.json`), JSON.stringify(plan, null, 2), 'utf-8');
}

function makePlan(id: string, label: string, sliceIds: string[]): VersionPlan {
  return {
    id,
    designId: 'd1',
    title: '测试计划',
    versions: [
      {
        version: label,
        dependsOn: [],
        description: `版本 ${label}`,
        slices: sliceIds.map((sid) => ({
          id: sid,
          module: 'M',
          title: sid,
          writes: ['src/**'],
          specPath: `specs/slices/${sid}.md`,
          state: 'draft',
        })),
        integrationTestDir: `tests/acceptance/${label}/`,
        status: 'in_progress',
      },
    ],
    status: 'confirmed',
    createdAt: '2026-01-01T00:00:00.000Z',
    confirmedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('ADR-067：基点解析', () => {
  let repo: { root: string; head: string; versionTip: string };
  let versionsDir: string;

  before(() => {
    repo = makeRepo();
    versionsDir = join(repo.root, '.zelto', 'versions');
  });

  after(() => {
    rmSync(repo.root, { recursive: true, force: true });
  });

  it('切片属于版本 → 基点取版本分支的 tip（不是主干 HEAD）', () => {
    writePlan(versionsDir, makePlan('plan-1', 'v1', ['slice-a', 'slice-b']));

    const base = resolveSliceBaseCommit('slice-b', null, {
      repoRoot: repo.root,
      versionsDir,
    });

    assert.equal(base.source, 'version-branch');
    assert.equal(base.version, 'v1');
    assert.equal(base.commit, repo.versionTip);
    // 关键断言：不能是主干 HEAD —— 那是 D-28 的根因
    assert.notEqual(base.commit, repo.head);
  });

  it('切片不属于任何版本 → 退回主干 HEAD', () => {
    const base = resolveSliceBaseCommit('orphan-slice', null, {
      repoRoot: repo.root,
      versionsDir,
    });

    assert.equal(base.source, 'head');
    assert.equal(base.commit, null);
  });

  it('已钉死的基点不被版本分支 tip 覆盖（ADR-041 §3.2 可复现）', () => {
    const pinned = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const base = resolveSliceBaseCommit('slice-b', pinned, {
      repoRoot: repo.root,
      versionsDir,
    });

    assert.equal(base.source, 'pinned');
    assert.equal(base.commit, pinned);
  });

  it('显式 override 优先于一切', () => {
    const override = 'cafebabecafebabecafebabecafebabecafebabe';
    const base = resolveSliceBaseCommit('slice-b', 'deadbeef', {
      override,
      repoRoot: repo.root,
      versionsDir,
    });

    assert.equal(base.source, 'override');
    assert.equal(base.commit, override);
  });

  it('归属歧义不阻塞执行 —— 退回主干 HEAD 并留痕（D2）', () => {
    // 两个计划都含 slice-b
    writePlan(versionsDir, makePlan('plan-amb-a', 'v1', ['slice-b']));
    writePlan(versionsDir, makePlan('plan-amb-b', 'v2', ['slice-b']));

    const base = resolveSliceBaseCommit('slice-b', null, {
      repoRoot: repo.root,
      versionsDir,
    });

    assert.equal(base.source, 'head');
    assert.ok(base.note, '歧义降级必须有 note 说明原因');
    assert.match(base.note as string, /归属解析失败/);
  });

  it('版本分支不存在 → 退回主干 HEAD 并说明原因', () => {
    writePlan(versionsDir, makePlan('plan-missing', 'v9', ['slice-x']));

    const base = resolveSliceBaseCommit('slice-x', null, {
      repoRoot: repo.root,
      versionsDir,
    });

    assert.equal(base.source, 'head');
    assert.ok(base.note, '必须说明「版本分支不存在」');
    assert.match(base.note as string, /version\/v9/);
  });
});

describe('ADR-067：审计只算本片产出的提交', () => {
  let repo: { root: string; head: string; versionTip: string };

  before(() => {
    repo = makeRepo();
  });

  after(() => {
    rmSync(repo.root, { recursive: true, force: true });
  });

  it('hasRefsSlice 精确匹配切片 id', () => {
    assert.equal(hasRefsSlice('feat(x)\n\nRefs-Slice: v1-a', 'v1-a'), true);
    // 前缀不能匹配
    assert.equal(hasRefsSlice('feat(x)\n\nRefs-Slice: v1-ab', 'v1-a'), false);
    // 大小写不敏感的 key
    assert.equal(hasRefsSlice('feat(x)\n\nrefs-slice: v1-a', 'v1-a'), true);
    assert.equal(hasRefsSlice('feat(x)\n\nRefs-Slice: v1-a', 'v1-b'), false);
    assert.equal(hasRefsSlice('没有 trailer', 'v1-a'), false);
  });

  it('commitsOfSlice 只返回带本片 trailer 的提交', () => {
    // 在 main 上造三个提交：本片一个、别片一个、无 trailer 一个
    git(repo.root, 'checkout', 'main');
    writeFileSync(join(repo.root, 'own.txt'), 'own\n', 'utf-8');
    git(repo.root, 'add', '.');
    git(repo.root, 'commit', '-m', 'feat(v1-a): 本片产出\n\nRefs-Slice: v1-a');
    const ownCommit = git(repo.root, 'rev-parse', 'HEAD');

    writeFileSync(join(repo.root, 'other.txt'), 'other\n', 'utf-8');
    git(repo.root, 'add', '.');
    git(repo.root, 'commit', '-m', 'feat(v1-b): 别片产出\n\nRefs-Slice: v1-b');

    writeFileSync(join(repo.root, 'plain.txt'), 'plain\n', 'utf-8');
    git(repo.root, 'add', '.');
    git(repo.root, 'commit', '-m', 'chore: 无关提交');

    const base = repo.head;
    const commits = commitsOfSlice(repo.root, base, 'HEAD', 'v1-a');

    assert.deepEqual(commits, [ownCommit], '只能返回本片的提交');
  });

  it('D-28 场景：上一片的文件不算本片越界', () => {
    // 复现：基点之后进来一个别片的提交，它改了不在本片写集里的文件
    const worktree = join(repo.root, 'wt');
    // main 已被主工作区占用 —— 用一个独立分支（git 不允许同一分支签出两处）
    git(repo.root, 'branch', 'wt-branch', repo.head);
    git(repo.root, 'worktree', 'add', worktree, 'wt-branch');

    // 本片提交：改一个在写集内的文件
    writeFileSync(join(worktree, 'in-set.txt'), 'agent change\n', 'utf-8');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-m', 'feat(v1-a): agent 产出\n\nRefs-Slice: v1-a');

    // 别片提交：改一个不在本片写集里的文件（D-28 里是上一片的三个文件）
    writeFileSync(join(worktree, 'out-of-set.txt'), 'other slice\n', 'utf-8');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-m', 'feat(v1-b): 上一片产出\n\nRefs-Slice: v1-b');

    // 老行为：基点..HEAD 全部提交 → 越界
    const legacy = auditWorktreeWrites(worktree, ['in-set.txt'], {
      baseCommit: repo.head,
    });
    assert.ok(
      legacy.violations.includes('out-of-set.txt'),
      '老行为会把别片的文件算成越界（这是 D-28 的误报来源）',
    );

    // 新行为：只算本片产出的提交 → 不越界
    const scoped = auditWorktreeWrites(worktree, ['in-set.txt'], {
      baseCommit: repo.head,
      sliceId: 'v1-a',
    });
    assert.deepEqual(
      scoped.violations,
      [],
      `本片不该有越界，实际：${JSON.stringify(scoped.violations)}`,
    );
    assert.ok(
      scoped.changed.includes('in-set.txt'),
      '本片自己的改动仍要在审计范围内',
    );
  });

  it('本片自己的越界写入仍会被抓到（过滤不能变成放行）', () => {
    const worktree = join(repo.root, 'wt2');
    git(repo.root, 'branch', 'wt2-branch', repo.head);
    git(repo.root, 'worktree', 'add', worktree, 'wt2-branch');

    // 本片提交里改了一个不在写集内的文件
    writeFileSync(join(worktree, 'bad.txt'), 'bad\n', 'utf-8');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-m', 'feat(v1-a): 越界产出\n\nRefs-Slice: v1-a');

    const scoped = auditWorktreeWrites(worktree, ['in-set.txt'], {
      baseCommit: repo.head,
      sliceId: 'v1-a',
    });

    assert.ok(
      scoped.violations.includes('bad.txt'),
      `本片自己的越界必须被抓到，实际：${JSON.stringify(scoped.violations)}`,
    );
  });
});
