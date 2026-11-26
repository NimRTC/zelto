// ADR-121：版本工作目录里的归属解析不许兜底合主干
//
// 测的是**确定性判定**（C3）：归属解析在「版本上下文」与「非版本上下文」
// 两种口径下的行为差异，以及显式 `--target` 的优先级。
//
// 病灶背景见 docs/adr/adr-121-version-context-ownership-fail-closed.md：
// 版本工作目录里 `.zelto/versions/` 是空的 → 归属解析落空 →
// 兜底合主干 → 13 个切片绕过版本分支直接进了主干。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveSliceOwnership,
  AmbiguousOwnershipError,
  UnresolvedOwnershipError,
  readVersionPlans,
} from '../src/core/version/branch.js';
import type { VersionPlan } from '../src/core/version/types.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'zelto-adr116-'));
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

function version(label: string, slices: string[]) {
  return {
    version: label,
    dependsOn: [],
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

function writePlan(dir: string, p: VersionPlan): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${p.id}.json`), JSON.stringify(p, null, 2), 'utf-8');
}

// ─── 决策二：版本上下文里 fail closed ──────────────────────────────────────

describe('resolveSliceOwnership — 版本上下文里解析不出归属就停下', () => {
  it('版本上下文 + 空计划目录 → 抛 UnresolvedOwnershipError（不再兜底合主干）', () => {
    const dir = tmpDir();
    try {
      const emptyVersions = join(dir, 'versions');
      mkdirSync(emptyVersions, { recursive: true });

      assert.throws(
        () =>
          resolveSliceOwnership('v1-some-slice', {
            versionsDir: emptyVersions,
            versionContext: true,
          }),
        (err: unknown) => {
          assert.ok(err instanceof UnresolvedOwnershipError);
          assert.equal(err.sliceId, 'v1-some-slice');
          return true;
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('错误信息说清「要合进哪个版本分支」，并给出两条出路', () => {
    const dir = tmpDir();
    try {
      const emptyVersions = join(dir, 'versions');
      mkdirSync(emptyVersions, { recursive: true });

      try {
        resolveSliceOwnership('v1-x', { versionsDir: emptyVersions, versionContext: true });
        assert.fail('应该抛 UnresolvedOwnershipError');
      } catch (err) {
        assert.ok(err instanceof UnresolvedOwnershipError);
        assert.match(err.message, /--target version\//);
        assert.match(err.message, /--target main/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('版本上下文 + 计划里有这片 → 正常解析出版本分支', () => {
    const dir = tmpDir();
    try {
      const versions = join(dir, 'versions');
      writePlan(versions, plan('p1', [version('v1', ['v1-a', 'v1-b'])]));

      const own = resolveSliceOwnership('v1-a', {
        versionsDir: versions,
        versionContext: true,
      });
      assert.equal(own.kind, 'version');
      if (own.kind === 'version') {
        assert.equal(own.version, 'v1');
        assert.equal(own.branch, 'version/v1');
        assert.equal(own.planId, 'p1');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('版本上下文 + 计划里有这片但不在这一版 → 抛错（不兜底）', () => {
    const dir = tmpDir();
    try {
      const versions = join(dir, 'versions');
      writePlan(versions, plan('p1', [version('v1', ['v1-a'])]));

      assert.throws(
        () => resolveSliceOwnership('not-in-plan', { versionsDir: versions, versionContext: true }),
        UnresolvedOwnershipError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── 向后兼容：非版本上下文仍兜底 ──────────────────────────────────────────

describe('resolveSliceOwnership — 非版本上下文保持老行为（ADR-056 向后兼容）', () => {
  it('老项目（无版本计划）→ 兜底合主干', () => {
    const dir = tmpDir();
    try {
      const emptyVersions = join(dir, 'versions');
      mkdirSync(emptyVersions, { recursive: true });

      const own = resolveSliceOwnership('legacy-slice', { versionsDir: emptyVersions });
      assert.equal(own.kind, 'main');
      assert.equal(own.branch, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('老项目 + versionContext 未传 → 兜底合主干', () => {
    const dir = tmpDir();
    try {
      const emptyVersions = join(dir, 'versions');
      mkdirSync(emptyVersions, { recursive: true });

      const own = resolveSliceOwnership('legacy-slice', {
        versionsDir: emptyVersions,
        versionContext: false,
      });
      assert.equal(own.kind, 'main');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('计划里有这片 → 无论是不是版本上下文，都解析出版本分支', () => {
    const dir = tmpDir();
    try {
      const versions = join(dir, 'versions');
      writePlan(versions, plan('p1', [version('v1', ['v1-a'])]));

      for (const versionContext of [true, false]) {
        const own = resolveSliceOwnership('v1-a', { versionsDir: versions, versionContext });
        assert.equal(own.kind, 'version');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── 决策三：显式 --target 不被兜底吞掉 ────────────────────────────────────

describe('resolveSliceOwnership — 显式 --target 不被兜底吞掉', () => {
  it('显式 --target version/v3 但计划里反查不到 → 仍然用那个分支', () => {
    const dir = tmpDir();
    try {
      const emptyVersions = join(dir, 'versions');
      mkdirSync(emptyVersions, { recursive: true });

      const own = resolveSliceOwnership('any-slice', {
        versionsDir: emptyVersions,
        targetBranch: 'version/v3',
        versionContext: true,
      });
      assert.equal(own.kind, 'version');
      if (own.kind === 'version') {
        assert.equal(own.branch, 'version/v3');
        assert.equal(own.version, 'v3');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('显式 --target version/v3 且计划里能反查到 → version 与 planId 都补齐', () => {
    const dir = tmpDir();
    try {
      const versions = join(dir, 'versions');
      writePlan(versions, plan('p1', [version('v3', ['v3-a'])]));

      const own = resolveSliceOwnership('v3-a', {
        versionsDir: versions,
        targetBranch: 'version/v3',
        versionContext: true,
      });
      assert.equal(own.kind, 'version');
      if (own.kind === 'version') {
        assert.equal(own.version, 'v3');
        assert.equal(own.planId, 'p1');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('显式 --target main → 仍然合主干（人明确要求的，不是猜的）', () => {
    const dir = tmpDir();
    try {
      const versions = join(dir, 'versions');
      writePlan(versions, plan('p1', [version('v1', ['v1-a'])]));

      const own = resolveSliceOwnership('v1-a', {
        versionsDir: versions,
        targetBranch: 'main',
        versionContext: true,
      });
      assert.equal(own.kind, 'main');
      assert.equal(own.branch, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── 歧义仍然歧义（不与新错误混淆）────────────────────────────────────────

describe('resolveSliceOwnership — 歧义与「解析不出」是两种错', () => {
  it('命中多个计划 → 仍是 AmbiguousOwnershipError', () => {
    const dir = tmpDir();
    try {
      const versions = join(dir, 'versions');
      writePlan(versions, plan('p1', [version('v1', ['dup'])]));
      writePlan(versions, plan('p2', [version('v2', ['dup'])]));

      assert.throws(
        () => resolveSliceOwnership('dup', { versionsDir: versions, versionContext: true }),
        AmbiguousOwnershipError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── 决策一：计划复制进版本工作目录 ─────────────────────────────────────────

describe('版本工作目录里能看到计划（ADR-121 决策一）', () => {
  it('复制后归属解析在版本上下文里成功', async () => {
    const repo = tmpDir();
    const wt = join(repo, '.zelto', 'version-worktrees', 'v3');
    try {
      // 仓库根的「真源」
      const srcVersions = join(repo, '.zelto', 'versions');
      writePlan(srcVersions, plan('p1', [version('v3', ['v3-a', 'v3-b'])]));

      // 版本工作目录：先建出来（空的 .zelto/versions/）
      mkdirSync(join(wt, '.zelto', 'versions'), { recursive: true });

      // 复制（与 version-runtime 里的做法一致）
      const src = join(srcVersions, 'p1.json');
      const dest = join(wt, '.zelto', 'versions', 'p1.json');
      writeFileSync(dest, readFileSync(src, 'utf-8'), 'utf-8');

      assert.ok(existsSync(dest));

      // 在版本工作目录里解析（模拟在那个目录里跑 merge）
      const own = resolveSliceOwnership('v3-a', {
        versionsDir: join(wt, '.zelto', 'versions'),
        versionContext: true,
      });
      assert.equal(own.kind, 'version');
      if (own.kind === 'version') {
        assert.equal(own.branch, 'version/v3');
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('没复制之前 → 版本上下文里解析不出归属（病灶本身）', () => {
    const repo = tmpDir();
    const wt = join(repo, '.zelto', 'version-worktrees', 'v3');
    try {
      const srcVersions = join(repo, '.zelto', 'versions');
      writePlan(srcVersions, plan('p1', [version('v3', ['v3-a'])]));

      // 版本工作目录里没有计划文件
      mkdirSync(join(wt, '.zelto', 'versions'), { recursive: true });

      assert.throws(
        () =>
          resolveSliceOwnership('v3-a', {
            versionsDir: join(wt, '.zelto', 'versions'),
            versionContext: true,
          }),
        UnresolvedOwnershipError,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('仓库根读得到计划时（非版本上下文）解析成功', () => {
    const repo = tmpDir();
    try {
      const srcVersions = join(repo, '.zelto', 'versions');
      writePlan(srcVersions, plan('p1', [version('v3', ['v3-a'])]));

      const plans = readVersionPlans(srcVersions);
      assert.equal(plans.length, 1);
      assert.equal(plans[0].versions[0].slices.length, 1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
