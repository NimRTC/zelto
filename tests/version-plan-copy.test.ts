// ZD-064：版本工作目录里的计划副本**保鲜**
//
// 病灶（实测 nimrtc-v14，2026-11-27）：
//
//   仓库根的 `.zelto/versions/<id>.json` 是**运行时真源**；
//   版本工作目录 `.zelto/version-worktrees/<label>/.zelto/versions/<id>.json`
//   是它的**副本**（ADR-121 建版时复制进去的）。
//
//   ADR-121 修的是「副本**根本不存在**」—— 补了「建版时复制进去」。
//   但**复制**解决了「没有」，没解决「复制之后就再也不动了」。
//
//   后果不是「多显示一点旧信息」，是**归属解析被污染**：
//   `resolveSliceOwnership` 读的是**当前目录**下的 `.zelto/versions/`。
//   在版本工作目录里跑 merge 时读到的就是那份陈旧副本 ——
//   实测 ADR-127 修完归属后，切片 `v1-ice-recovery`：
//
//     根真源归属：v3   ← 规格自己写明归 v3
//     v5 副本归属：v1   ← 陈旧副本说的
//
//   于是「基点从哪个版本分支 tip 起」「该合到哪条分支」全按错的归属算 ——
//   追溯链说的和实际落点对不上。
//
// 所以这个测试钉住的是：**真源一改，副本就跟上**。

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  refreshPlanCopyIntoVersionWorkspace,
  refreshPlanCopiesIntoAllVersionWorkspaces,
  formatPlanCopyRefresh,
  VERSION_PLAN_SUBDIR,
  VERSION_WORKTREES_REL,
} from '../src/core/version/plan-copy.js';

/** 建一个假仓库：真源 + 若干版本工作目录。 */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zelto-plan-copy-'));
  mkdirSync(join(dir, '.zelto', 'versions'), { recursive: true });
  writeFileSync(join(dir, '.zelto', 'versions', 'plan-1.json'), '{"id":"plan-1","v":1}\n');
  return dir;
}

/** 在仓库里造一个版本工作目录（内容 = 旧的计划副本）。 */
function makeVersionWorkspace(repo: string, label: string, staleCopy?: string): string {
  const wt = join(repo, VERSION_WORKTREES_REL, label);
  mkdirSync(join(wt, VERSION_PLAN_SUBDIR), { recursive: true });
  if (staleCopy !== undefined) {
    writeFileSync(join(wt, VERSION_PLAN_SUBDIR, 'plan-1.json'), staleCopy);
  }
  return wt;
}

describe('计划副本保鲜（ZD-064）', () => {
  let repo: string;

  beforeEach(() => {
    repo = makeRepo();
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  describe('同步到单个版本工作目录', () => {
    it('把真源复制进版本目录，副本内容与真源逐字一致', () => {
      const wt = makeVersionWorkspace(repo, 'v1');
      const res = refreshPlanCopyIntoVersionWorkspace(repo, wt, 'plan-1');
      assert.equal(res.synced, true);
      const copy = join(wt, VERSION_PLAN_SUBDIR, 'plan-1.json');
      assert.ok(existsSync(copy), '副本应该被创建出来');
      assert.equal(readFileSync(copy, 'utf-8'), readFileSync(join(repo, '.zelto', 'versions', 'plan-1.json'), 'utf-8'));
    });

    it('覆盖陈旧副本（不是「已存在就跳过」）', () => {
      const wt = makeVersionWorkspace(repo, 'v1', '{"id":"plan-1","v":0}\n');
      const res = refreshPlanCopyIntoVersionWorkspace(repo, wt, 'plan-1');
      assert.equal(res.synced, true);
      const copy = join(wt, VERSION_PLAN_SUBDIR, 'plan-1.json');
      assert.equal(readFileSync(copy, 'utf-8'), '{"id":"plan-1","v":1}\n');
    });

    it('内容已经一致时不重复写（幂等）', () => {
      const wt = makeVersionWorkspace(repo, 'v1');
      refreshPlanCopyIntoVersionWorkspace(repo, wt, 'plan-1');
      const copy = join(wt, VERSION_PLAN_SUBDIR, 'plan-1.json');
      const first = readFileSync(copy, 'utf-8');
      const mtimeBefore = existsSync(copy) ? statSyncSafe(copy) : 0;
      const res = refreshPlanCopyIntoVersionWorkspace(repo, wt, 'plan-1');
      assert.equal(res.synced, true);
      assert.equal(readFileSync(copy, 'utf-8'), first);
      assert.equal(statSyncSafe(copy), mtimeBefore, '内容已一致时不该重写文件');
    });

    it('真源不存在时如实报告，不静默', () => {
      const wt = makeVersionWorkspace(repo, 'v1');
      const res = refreshPlanCopyIntoVersionWorkspace(repo, wt, 'plan-nope');
      assert.equal(res.synced, false);
      assert.match(res.reason ?? '', /真源不存在/);
    });

    it('版本目录整个不存在时会建出来', () => {
      const wt = join(repo, VERSION_WORKTREES_REL, 'v9');
      const res = refreshPlanCopyIntoVersionWorkspace(repo, wt, 'plan-1');
      assert.equal(res.synced, true);
      assert.ok(existsSync(join(wt, VERSION_PLAN_SUBDIR, 'plan-1.json')));
    });
  });

  describe('同步到所有版本工作目录', () => {
    it('所有已存在的版本目录都拿到新鲜副本', () => {
      const wt1 = makeVersionWorkspace(repo, 'v1', '{"id":"plan-1","v":0}\n');
      const wt3 = makeVersionWorkspace(repo, 'v3');
      const results = refreshPlanCopiesIntoAllVersionWorkspaces(repo, 'plan-1');
      assert.equal(results.length, 2);
      assert.ok(results.every((r) => r.synced));
      assert.equal(readFileSync(join(wt1, VERSION_PLAN_SUBDIR, 'plan-1.json'), 'utf-8'), '{"id":"plan-1","v":1}\n');
      assert.equal(readFileSync(join(wt3, VERSION_PLAN_SUBDIR, 'plan-1.json'), 'utf-8'), '{"id":"plan-1","v":1}\n');
    });

    it('没有版本目录时返回空数组（不是错误）', () => {
      const results = refreshPlanCopiesIntoAllVersionWorkspaces(repo, 'plan-1');
      assert.deepEqual(results, []);
    });

    it('版本目录里没有计划文件时也补上（ADR-121 的原始病灶）', () => {
      const wt = join(repo, VERSION_WORKTREES_REL, 'v1');
      mkdirSync(wt, { recursive: true });
      const results = refreshPlanCopiesIntoAllVersionWorkspaces(repo, 'plan-1');
      assert.equal(results.length, 1);
      assert.equal(results[0].synced, true);
      assert.ok(existsSync(join(wt, VERSION_PLAN_SUBDIR, 'plan-1.json')));
    });

    it('非目录项被跳过（不会当成版本目录去同步）', () => {
      mkdirSync(join(repo, VERSION_WORKTREES_REL), { recursive: true });
      writeFileSync(join(repo, VERSION_WORKTREES_REL, 'not-a-dir.txt'), 'x');
      const wt = makeVersionWorkspace(repo, 'v1');
      const results = refreshPlanCopiesIntoAllVersionWorkspaces(repo, 'plan-1');
      assert.equal(results.length, 1);
      assert.equal(results[0].label, 'v1');
      assert.ok(existsSync(join(wt, VERSION_PLAN_SUBDIR, 'plan-1.json')));
    });

    it('版本目录里有计划但真源没了 → 报出「真源不存在」而不是假装成功', () => {
      makeVersionWorkspace(repo, 'v1', '{"id":"plan-1"}\n');
      rmSync(join(repo, '.zelto', 'versions', 'plan-1.json'));
      const results = refreshPlanCopiesIntoAllVersionWorkspaces(repo, 'plan-1');
      assert.equal(results.length, 1);
      assert.equal(results[0].synced, false);
      assert.match(results[0].reason ?? '', /真源不存在/);
    });
  });

  describe('人可读的汇报', () => {
    it('全部同步时说一句就够', () => {
      makeVersionWorkspace(repo, 'v1');
      const results = refreshPlanCopiesIntoAllVersionWorkspaces(repo, 'plan-1');
      const lines = formatPlanCopyRefresh(results);
      assert.equal(lines.length, 1);
      assert.match(lines[0], /1 个版本工作目录已与真源一致/);
    });

    it('没有版本目录时说清楚「无需同步」', () => {
      const lines = formatPlanCopyRefresh(refreshPlanCopiesIntoAllVersionWorkspaces(repo, 'plan-1'));
      assert.equal(lines.length, 1);
      assert.match(lines[0], /没有已存在的版本工作目录，无需同步/);
    });

    it('有没同步上的版本目录时逐个点名（不悄悄留坑）', () => {
      makeVersionWorkspace(repo, 'v1');
      rmSync(join(repo, '.zelto', 'versions', 'plan-1.json'));
      const lines = formatPlanCopyRefresh(refreshPlanCopiesIntoAllVersionWorkspaces(repo, 'plan-1'));
      assert.equal(lines.length, 1);
      assert.match(lines[0], /计划副本未同步/);
      assert.match(lines[0], /v1/);
    });
  });
});

/** 拿文件 mtime（毫秒）；不存在返回 0。 */
function statSyncSafe(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}
