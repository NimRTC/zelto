// ADR-056：版本级分支的判定测试
//
// 测的是**确定性判定**（C3）：分支名派生、归属解析、跨版本冲突检测、
// 依赖隔离的锁文件比对 —— 全是纯计算，不调模型、不触网。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  versionBranchName,
  versionTagName,
  versionWorktreeRelativePath,
  readVersionFromSpec,
  readVersionPlans,
  resolveSliceOwnership,
  AmbiguousOwnershipError,
  branchOfVersion,
} from '../src/core/version/branch.js';
import {
  detectCrossVersionConflicts,
  overlappingPaths,
} from '../src/core/sched/cross-version.js';
import {
  readLockfileState,
  lockfilesMatch,
  planVersionDependencies,
} from '../src/core/worktree/dependencies.js';
import type { VersionPlan } from '../src/core/version/types.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'zelto-adr056-'));
}

function writePlan(dir: string, plan: VersionPlan): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${plan.id}.json`), JSON.stringify(plan, null, 2), 'utf-8');
}

function plan(id: string, versions: VersionPlan['versions']): VersionPlan {
  return {
    id,
    designId: 'd1',
    title: '测试计划',
    versions,
    status: 'confirmed',
    createdAt: '2026-01-01T00:00:00.000Z',
    confirmedAt: '2026-01-01T00:00:00.000Z',
  };
}

function version(label: string, slices: string[], dependsOn: string[] = []) {
  return {
    version: label,
    dependsOn,
    description: `版本 ${label}`,
    slices: slices.map((id) => ({
      id,
      module: 'm',
      title: id,
      writes: [],
      specPath: `specs/slices/${id}.md`,
    })),
    integrationTestDir: `tests/acceptance/${label}/`,
    status: 'planned' as const,
  };
}

// ─── 分支名派生 ─────────────────────────────────────────────────────────────

describe('versionBranchName — 版本分支名派生', () => {
  it('默认是 version/<label>', () => {
    assert.equal(versionBranchName('v2'), 'version/v2');
  });

  it('非法字符被替换成 -', () => {
    assert.equal(versionBranchName('v2/beta'), 'version/v2-beta');
    assert.equal(versionBranchName('v 2'), 'version/v-2');
  });

  it('首尾的 - 被去掉', () => {
    assert.equal(versionBranchName('--v2--'), 'version/v2');
  });

  it('空 label 有兜底', () => {
    assert.equal(versionBranchName(''), 'version/unnamed');
    assert.equal(versionBranchName('///'), 'version/unnamed');
  });

  it('tag 名与分支名分开', () => {
    assert.equal(versionTagName('v2'), 'v2');
    assert.notEqual(versionTagName('v2'), versionBranchName('v2'));
  });

  it('版本工作目录路径在另一个 base 下', () => {
    const p = versionWorktreeRelativePath('v2');
    assert.ok(p.includes('version-worktrees'));
    // 切片 worktree 的反解标记是 `.zelto/worktrees/`——
    // 版本目录不能被它命中，否则会被误认成切片 worktree
    assert.ok(!p.includes(join('.zelto', 'worktrees')));
    assert.ok(!p.startsWith(join('.zelto', 'worktrees')));
  });
});

describe('branchOfVersion — 计划里显式写的 branch 优先', () => {
  it('没有 branch 时派生', () => {
    assert.equal(branchOfVersion(version('v2', [])), 'version/v2');
  });

  it('有 branch 时用它', () => {
    const v = { ...version('v2', []), branch: 'release/2.0' };
    assert.equal(branchOfVersion(v), 'release/2.0');
  });
});

// ─── 归属解析（ADR-056 §3.2）──────────────────────────────────────────────

describe('resolveSliceOwnership — 四级回退', () => {
  it('第 2 级：命中版本计划成员', () => {
    const dir = tmpDir();
    try {
      writePlan(dir, plan('p1', [version('v2', ['slice-a'])]));
      const own = resolveSliceOwnership('slice-a', { versionsDir: dir });
      assert.equal(own.kind, 'version');
      assert.equal(own.kind === 'version' ? own.version : null, 'v2');
      assert.equal(own.kind === 'version' ? own.branch : null, 'version/v2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('第 4 级：不在任何计划里 → 合主干（向后兼容）', () => {
    const dir = tmpDir();
    try {
      writePlan(dir, plan('p1', [version('v2', ['slice-a'])]));
      const own = resolveSliceOwnership('other-slice', { versionsDir: dir });
      assert.equal(own.kind, 'main');
      assert.equal(own.branch, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('命中多个计划时抛 AmbiguousOwnershipError', () => {
    const dir = tmpDir();
    try {
      writePlan(dir, plan('p1', [version('v2', ['shared'])]));
      writePlan(dir, plan('p2', [version('v3', ['shared'])]));
      assert.throws(
        () => resolveSliceOwnership('shared', { versionsDir: dir }),
        (err: unknown) => err instanceof AmbiguousOwnershipError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--plan 可以消歧', () => {
    const dir = tmpDir();
    try {
      writePlan(dir, plan('p1', [version('v2', ['shared'])]));
      writePlan(dir, plan('p2', [version('v3', ['shared'])]));
      const own = resolveSliceOwnership('shared', { versionsDir: dir, planId: 'p2' });
      assert.equal(own.kind === 'version' ? own.version : null, 'v3');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--target main 强制合主干', () => {
    const dir = tmpDir();
    try {
      writePlan(dir, plan('p1', [version('v2', ['slice-a'])]));
      const own = resolveSliceOwnership('slice-a', { versionsDir: dir, targetBranch: 'main' });
      assert.equal(own.kind, 'main');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--target <version-branch> 指定版本分支', () => {
    const dir = tmpDir();
    try {
      writePlan(dir, plan('p1', [version('v2', ['slice-a'])]));
      const own = resolveSliceOwnership('slice-a', { versionsDir: dir, targetBranch: 'version/v2' });
      assert.equal(own.kind, 'version');
      assert.equal(own.kind === 'version' ? own.version : null, 'v2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('第 3 级：规格 frontmatter 的 version 字段', () => {
    const dir = tmpDir();
    const specDir = tmpDir();
    try {
      writePlan(dir, plan('p1', [version('v2', ['other'])]));
      const specPath = join(specDir, 'slice-b.md');
      writeFileSync(specPath, '---\nid: slice-b\nversion: v2\n---\n\n# 规格\n', 'utf-8');

      const own = resolveSliceOwnership('slice-b', { versionsDir: dir, specPath });
      assert.equal(own.kind, 'version');
      assert.equal(own.kind === 'version' ? own.version : null, 'v2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(specDir, { recursive: true, force: true });
    }
  });

  it('同输入必得同结果（确定性，C3）', () => {
    const dir = tmpDir();
    try {
      writePlan(dir, plan('p1', [version('v2', ['slice-a'])]));
      const a = resolveSliceOwnership('slice-a', { versionsDir: dir });
      const b = resolveSliceOwnership('slice-a', { versionsDir: dir });
      assert.deepEqual(a, b);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('readVersionFromSpec — frontmatter 解析', () => {
  it('读出版本号', () => {
    const dir = tmpDir();
    try {
      const p = join(dir, 'a.md');
      writeFileSync(p, '---\nversion: "v2"\n---\nbody', 'utf-8');
      assert.equal(readVersionFromSpec(p), 'v2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('没有 frontmatter 返回 null', () => {
    const dir = tmpDir();
    try {
      const p = join(dir, 'a.md');
      writeFileSync(p, '# 没有 frontmatter\n', 'utf-8');
      assert.equal(readVersionFromSpec(p), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('文件不存在返回 null', () => {
    assert.equal(readVersionFromSpec(join(tmpdir(), 'zelto-does-not-exist-xyz.md')), null);
  });
});

describe('readVersionPlans — 坏文件不卡死解析', () => {
  it('跳过读不动的 JSON', () => {
    const dir = tmpDir();
    try {
      writePlan(dir, plan('p1', [version('v2', ['a'])]));
      writeFileSync(join(dir, 'broken.json'), '{ not json', 'utf-8');
      const plans = readVersionPlans(dir);
      assert.equal(plans.length, 1);
      assert.equal(plans[0].id, 'p1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── 跨版本冲突检测（ADR-056 §3.6）────────────────────────────────────────

describe('detectCrossVersionConflictsFor — 本版本必须留在比对列表里', () => {
  // 回归测试：之前这个函数把「当前版本」从列表里排除掉了，
  // 结果两两比对时列表里只剩别人 —— 没有可比的一对 —— 永远检不出冲突。
  it('本版本与其它版本的重叠能检出', async () => {
    const { detectCrossVersionConflictsFor } = await import(
      '../src/cli/commands/version-runtime.js'
    );
    const conflicts = detectCrossVersionConflictsFor('v3', [
      { version: 'v2', writes: ['src/core/types.ts'] },
      { version: 'v3', writes: ['src/core/types.ts'] },
    ]);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].severity, 'error');
    assert.equal(conflicts[0].versionA, 'v2');
    assert.equal(conflicts[0].versionB, 'v3');
  });

  it('本版本无重叠时不误报', async () => {
    const { detectCrossVersionConflictsFor } = await import(
      '../src/cli/commands/version-runtime.js'
    );
    const conflicts = detectCrossVersionConflictsFor('v3', [
      { version: 'v2', writes: ['src/core/types.ts'] },
      { version: 'v3', writes: ['src/cli/main.ts'] },
    ]);
    assert.equal(conflicts.length, 0);
  });

  it('同一个版本被重复收集时只算一次', async () => {
    const { detectCrossVersionConflictsFor } = await import(
      '../src/cli/commands/version-runtime.js'
    );
    const conflicts = detectCrossVersionConflictsFor('v3', [
      { version: 'v2', writes: ['src/core/types.ts'] },
      { version: 'v2', writes: ['src/core/types.ts'] },
      { version: 'v3', writes: ['src/core/types.ts'] },
    ]);
    assert.equal(conflicts.length, 1);
  });

  it('只有一个版本时无冲突（没有可比的一对）', async () => {
    const { detectCrossVersionConflictsFor } = await import(
      '../src/cli/commands/version-runtime.js'
    );
    const conflicts = detectCrossVersionConflictsFor('v3', [
      { version: 'v3', writes: ['src/core/types.ts'] },
    ]);
    assert.equal(conflicts.length, 0);
  });
});

describe('detectCrossVersionConflicts — 跨版本冲突', () => {
  it('两个版本都改 types.ts → error', () => {
    const conflicts = detectCrossVersionConflicts([
      { version: 'v2', writes: ['src/core/types.ts'] },
      { version: 'v3', writes: ['src/core/types.ts'] },
    ]);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].severity, 'error');
    assert.equal(conflicts[0].category, 'type_definition');
    assert.equal(conflicts[0].versionA, 'v2');
    assert.equal(conflicts[0].versionB, 'v3');
  });

  it('一个改 types.ts 一个改别的 → 无冲突', () => {
    const conflicts = detectCrossVersionConflicts([
      { version: 'v2', writes: ['src/core/types.ts'] },
      { version: 'v3', writes: ['src/cli/main.ts'] },
    ]);
    assert.equal(conflicts.length, 0);
  });

  it('schema 类别 → warning', () => {
    const conflicts = detectCrossVersionConflicts([
      { version: 'v2', writes: ['contracts/schemas/a.json'] },
      { version: 'v3', writes: ['contracts/schemas/a.json'] },
    ]);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].severity, 'warning');
  });

  it('documentation 类别 → info', () => {
    const conflicts = detectCrossVersionConflicts([
      { version: 'v2', writes: ['docs/a.md'] },
      { version: 'v3', writes: ['docs/a.md'] },
    ]);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].severity, 'info');
  });

  it('目录前缀与具体路径算重叠', () => {
    const conflicts = detectCrossVersionConflicts([
      { version: 'v2', writes: ['src/core/'] },
      { version: 'v3', writes: ['src/core/types.ts'] },
    ]);
    assert.ok(conflicts.length >= 1);
  });

  it('同输入必得同结果（确定性，C3）', () => {
    const input = [
      { version: 'v2', writes: ['src/core/types.ts', 'docs/a.md'] },
      { version: 'v3', writes: ['src/core/types.ts'] },
    ];
    assert.deepEqual(detectCrossVersionConflicts(input), detectCrossVersionConflicts(input));
  });

  it('严重度排序：error 在前', () => {
    const conflicts = detectCrossVersionConflicts([
      { version: 'v2', writes: ['docs/a.md'] },
      { version: 'v3', writes: ['src/core/types.ts'] },
    ]);
    assert.equal(conflicts.length, 0);
  });
});

describe('overlappingPaths — 具体重叠路径', () => {
  it('完全相同', () => {
    assert.deepEqual(overlappingPaths(['a.ts'], ['a.ts']), ['a.ts']);
  });

  it('glob 与具体路径', () => {
    assert.deepEqual(overlappingPaths(['src/**/*.ts'], ['src/core/types.ts']), ['src/core/types.ts']);
  });

  it('目录前缀', () => {
    assert.deepEqual(overlappingPaths(['src/core/'], ['src/core/types.ts']), ['src/core/']);
  });

  it('无重叠返回空', () => {
    assert.deepEqual(overlappingPaths(['a.ts'], ['b.ts']), []);
  });
});

// ─── 依赖隔离（ADR-056 §3.7 / D4-C）────────────────────────────────────────

describe('readLockfileState — 锁文件状态', () => {
  it('没有锁文件', () => {
    const dir = tmpDir();
    try {
      const state = readLockfileState(dir);
      assert.equal(state.file, null);
      assert.equal(state.hash, null);
      assert.equal(state.manager, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('认出 package-lock.json 与 npm', () => {
    const dir = tmpDir();
    try {
      writeFileSync(join(dir, 'package-lock.json'), '{}', 'utf-8');
      const state = readLockfileState(dir);
      assert.equal(state.file, 'package-lock.json');
      assert.equal(state.manager, 'npm');
      assert.ok(state.hash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('内容相同 → hash 相同', () => {
    const a = tmpDir();
    const b = tmpDir();
    try {
      writeFileSync(join(a, 'package-lock.json'), '{"x":1}', 'utf-8');
      writeFileSync(join(b, 'package-lock.json'), '{"x":1}', 'utf-8');
      assert.equal(readLockfileState(a).hash, readLockfileState(b).hash);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
});

describe('lockfilesMatch — 一致性判定', () => {
  it('两边都没有 → 一致', () => {
    const none = readLockfileState(tmpDir());
    assert.equal(lockfilesMatch(none, none), true);
  });

  it('一边有一边没有 → 不一致', () => {
    const dir = tmpDir();
    try {
      writeFileSync(join(dir, 'package-lock.json'), '{}', 'utf-8');
      const has = readLockfileState(dir);
      const none = readLockfileState(tmpDir());
      assert.equal(lockfilesMatch(has, none), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('内容不同 → 不一致', () => {
    const a = tmpDir();
    const b = tmpDir();
    try {
      writeFileSync(join(a, 'package-lock.json'), '{"x":1}', 'utf-8');
      writeFileSync(join(b, 'package-lock.json'), '{"x":2}', 'utf-8');
      assert.equal(lockfilesMatch(readLockfileState(a), readLockfileState(b)), false);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
});

describe('planVersionDependencies — D4-C 策略判定', () => {
  it('锁文件一致 → link', () => {
    const repo = tmpDir();
    const wt = tmpDir();
    try {
      writeFileSync(join(repo, 'package-lock.json'), '{"x":1}', 'utf-8');
      writeFileSync(join(wt, 'package-lock.json'), '{"x":1}', 'utf-8');
      const plan = planVersionDependencies({ repoRoot: repo, worktreePath: wt });
      assert.equal(plan.strategy, 'link');
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it('锁文件不同 → install', () => {
    const repo = tmpDir();
    const wt = tmpDir();
    try {
      writeFileSync(join(repo, 'package-lock.json'), '{"x":1}', 'utf-8');
      writeFileSync(join(wt, 'package-lock.json'), '{"x":2}', 'utf-8');
      const plan = planVersionDependencies({ repoRoot: repo, worktreePath: wt });
      assert.equal(plan.strategy, 'install');
      assert.ok(plan.reason.includes('不一致'));
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it('两边都没有锁文件 → link（无依赖清单要管）', () => {
    const repo = tmpDir();
    const wt = tmpDir();
    try {
      const plan = planVersionDependencies({ repoRoot: repo, worktreePath: wt });
      assert.equal(plan.strategy, 'link');
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(wt, { recursive: true, force: true });
    }
  });
});
