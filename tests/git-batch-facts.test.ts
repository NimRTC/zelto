// 批量 git 事实判定 —— 一次问完，不是一片一问
//
// 为什么这个文件存在：
//
// 「分支存不存在」「合没合进目标」「产物在不在目标 ref 的树上」
// 这三个判据原来都是**一条一个 git 调用**。
//
// 在真实仓库里（149 片切片 / 99 条已批准的签字请求）那是几百次
// 子进程启动 —— 实测 `zelto next` 要跑 **60 多秒**，
// Web 驾驶舱的 `/api/pending-actions` 直接超时，首屏永远停在「加载中…」。
//
// 批量化之后：`zelto next` 降到 **5 秒左右**，
// `/api/pending-actions` 降到 **1.5 秒**。
//
// **判据没变** —— 仍然是 git 事实（可到达性、文件树、历史删除），
// 只是问法从「一问一次」变成「一次问完」。所以这里断言的是
// **批量答案与逐条答案一致**，而不只是「批量答案是某个值」。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildBranchIndex,
  deletedPathsInRef,
  isBranchMergedIntoRef,
  listLocalBranches,
  refTree,
  verifyArtifactsWithTree,
} from '../src/core/git/facts.js';

const ROOT = mkdtempSync(join(tmpdir(), 'zelto-git-batch-'));

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8' });
}

describe('批量 git 事实判定', () => {
  before(() => {
    git(['init', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);

    mkdirSync(join(ROOT, 'src'), { recursive: true });
    writeFileSync(join(ROOT, 'src', 'a.ts'), 'export const a = 1;\n', 'utf-8');
    writeFileSync(join(ROOT, 'src', 'b.ts'), 'export const b = 2;\n', 'utf-8');
    git(['add', '.']);
    git(['commit', '-m', 'init']);

    // 一个已合入 main 的分支
    git(['checkout', '-b', 'feature/merged']);
    writeFileSync(join(ROOT, 'src', 'c.ts'), 'export const c = 3;\n', 'utf-8');
    git(['add', '.']);
    git(['commit', '-m', 'add c']);
    git(['checkout', 'main']);
    git(['merge', '--no-ff', 'feature/merged', '-m', 'merge feature/merged']);

    // 一个还没合入 main 的分支
    git(['checkout', '-b', 'feature/open']);
    writeFileSync(join(ROOT, 'src', 'd.ts'), 'export const d = 4;\n', 'utf-8');
    git(['add', '.']);
    git(['commit', '-m', 'add d']);
    git(['checkout', 'main']);

    // 一个把文件删掉的分支
    git(['checkout', '-b', 'feature/delete']);
    git(['rm', 'src/b.ts']);
    git(['commit', '-m', 'delete b']);
    git(['checkout', 'main']);
  });

  after(() => {
    rmSync(ROOT, { recursive: true, force: true });
  });

  // ── 分支索引 ──────────────────────────────────────────────────────────

  it('分支索引列出全部分支（一次 for-each-ref）', () => {
    const index = buildBranchIndex(ROOT);
    assert.ok(index.branches.has('main'));
    assert.ok(index.branches.has('feature/merged'));
    assert.ok(index.branches.has('feature/open'));
    assert.ok(index.branches.has('feature/delete'));
  });

  it('已合入 HEAD 的分支集合与逐条判定一致', () => {
    const index = buildBranchIndex(ROOT);

    // 逐条判定的基准答案 —— 每次一次 git 调用
    const perBranch = new Set<string>();
    for (const b of index.branches) {
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', b, 'HEAD'], {
          cwd: ROOT,
          stdio: 'ignore',
        });
        perBranch.add(b);
      } catch {
        // 不是祖先
      }
    }

    assert.deepEqual([...index.mergedIntoHead].sort(), [...perBranch].sort());
  });

  it('`listLocalBranches` 与索引里的分支集合一致', () => {
    const index = buildBranchIndex(ROOT);
    const direct = listLocalBranches(ROOT);
    assert.deepEqual([...direct].sort(), [...index.branches].sort());
  });

  it('「合没合入某个 ref」走索引：已合入的合、未合入的不合', () => {
    const index = buildBranchIndex(ROOT);
    assert.equal(isBranchMergedIntoRef(index, 'feature/merged', 'refs/heads/main', ROOT), true);
    assert.equal(isBranchMergedIntoRef(index, 'feature/open', 'refs/heads/main', ROOT), false);
  });

  it('索引里的 mergedCache 只问一次（第二次走缓存）', () => {
    const index = buildBranchIndex(ROOT);
    const before = index.mergedCache.size;
    isBranchMergedIntoRef(index, 'feature/open', 'refs/heads/main', ROOT);
    assert.equal(index.mergedCache.size, before + 1);
    // 再问一次 —— 缓存命中，不再新增条目
    isBranchMergedIntoRef(index, 'feature/delete', 'refs/heads/main', ROOT);
    assert.equal(index.mergedCache.size, before + 1);
  });

  // ── 文件树 ────────────────────────────────────────────────────────────

  it('ref 树一次给出全部路径（含目录）', () => {
    const cache = new Map();
    const tree = refTree(cache, 'refs/heads/main', ROOT);
    assert.ok(tree.files.has('src/a.ts'));
    assert.ok(tree.files.has('src/b.ts'));
    assert.ok(tree.files.has('src/c.ts'));
    // 被删掉的 d.ts 不在 main 上
    assert.ok(!tree.files.has('src/d.ts'));
    assert.ok(tree.dirs.has('src/'));
  });

  it('文件树按 ref 缓存（同一 ref 只查一次）', () => {
    const cache = new Map();
    refTree(cache, 'refs/heads/main', ROOT);
    assert.equal(cache.size, 1);
    refTree(cache, 'refs/heads/main', ROOT);
    assert.equal(cache.size, 1, '第二次应当走缓存');
  });

  // ── 产物核实 ──────────────────────────────────────────────────────────

  it('产物核实：全在树上 → 没有缺失', () => {
    const cache = new Map();
    const deleted = new Map();
    const res = verifyArtifactsWithTree(
      ['src/a.ts', 'src/c.ts'],
      'refs/heads/main',
      ROOT,
      cache,
      deleted,
    );
    assert.deepEqual(res.missing, []);
    assert.equal(res.satisfied.length, 2);
  });

  it('产物核实：有不在树上的 → 列入缺失', () => {
    const cache = new Map();
    const deleted = new Map();
    const res = verifyArtifactsWithTree(
      ['src/a.ts', 'src/d.ts'],
      'refs/heads/main',
      ROOT,
      cache,
      deleted,
    );
    assert.deepEqual(res.missing, ['src/d.ts']);
  });

  it('产物核实：被删掉的路径算「已就位」（搬迁类切片）', () => {
    const cache = new Map();
    const deleted = new Map();
    // src/b.ts 在 feature/delete 上被删了 —— 历史上算「已删除」
    const res = verifyArtifactsWithTree(
      ['src/b.ts'],
      'refs/heads/feature/delete',
      ROOT,
      cache,
      deleted,
    );
    // feature/delete 的树上没有 b.ts，但历史上删过 → 算已就位
    assert.deepEqual(res.missing, []);
    assert.deepEqual(res.satisfied, ['src/b.ts']);
  });

  it('glob 写集保守地算「已就位」（实际由运行时守卫逐写判定管着）', () => {
    const cache = new Map();
    const deleted = new Map();
    const res = verifyArtifactsWithTree(['src/**'], 'refs/heads/main', ROOT, cache, deleted);
    assert.deepEqual(res.missing, []);
    assert.deepEqual(res.satisfied, ['src/**']);
  });

  it('删除历史一次问完（全部被删过的路径）', () => {
    const cache = new Map();
    const deleted = deletedPathsInRef(cache, 'refs/heads/feature/delete', ROOT);
    assert.ok(deleted.has('src/b.ts'));
    // 再问一次走缓存
    const again = deletedPathsInRef(cache, 'refs/heads/feature/delete', ROOT);
    assert.equal(again, deleted);
  });

  it('产物核实的答案与逐条核实一致', () => {
    // 逐条核实的基准答案 —— 每条路径一次 ls-tree + 一次 log
    const writes = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'];
    const perPathMissing: string[] = [];
    for (const p of writes) {
      const exists = execFileSync(
        'git',
        ['ls-tree', '-r', '--name-only', 'refs/heads/main', '--', p],
        { cwd: ROOT, encoding: 'utf-8' },
      )
        .split('\n')
        .some((l) => l.trim().length > 0);
      if (exists) continue;

      const wasDeleted = execFileSync(
        'git',
        ['log', '--diff-filter=D', '--name-only', '--format=%H', '-1', 'refs/heads/main', '--', p],
        { cwd: ROOT, encoding: 'utf-8' },
      )
        .split('\n')
        .some((l) => l.trim() === p);
      if (!wasDeleted) perPathMissing.push(p);
    }

    const res = verifyArtifactsWithTree(
      writes,
      'refs/heads/main',
      ROOT,
      new Map(),
      new Map(),
    );
    assert.deepEqual(res.missing, perPathMissing);
  });
});
