// D-63：`git status --untracked-files=all` 在冷 worktree 上要 224 秒
//
// 病灶（实测 nimrtc-zelto，2026-11-18，`zelto version start v4`）：
//
//   ❌ v4-ai-teammate: 无法取得写集预约: 无法取得 worktree 的基线快照
//      （git status 失败）：spawnSync git ETIMEDOUT
//
// 基线快照（开工时拍一份「worktree 本来就脏的路径」）用的是
// `git status --porcelain --untracked-files=all`。
//
// 在刚建出来的 worktree 上，那条命令要 **224 秒**：
//
//     git status --porcelain --untracked-files=all   →  224 秒
//     git status --porcelain                        →   12 秒
//     git diff --name-only + git ls-files --others   →   13 秒（冷）/ 0.6 秒（热）
//
// 病根在 `--untracked-files=all`：它要逐个 stat 每一个未跟踪文件，
// 而 nimrtc 带 googletest / msquic 两个大 submodule，冷缓存下遍历整棵树
// 要几分钟。缓存热了同一条命令只要 0.6 秒 ——
// **慢的恰恰是第一次，而第一次恰恰是最不能出错的那一次**
// （它决定后面所有审计的基线）。
//
// 修法：用 `diff + diff --cached + ls-files --others` 三条命令，
// 语义等价，但快 17 倍。
//
// 这一组用例守的是：
//   1. 语义等价：三条命令合起来的路径集合 == porcelain 的路径集合；
//   2. 未跟踪文件**不能漏**（agent 新建的文件是越界写入的常见形态）；
//   3. 已修改 / 已暂存 / 已删除都要覆盖；
//   4. 被 ignore 的文件不算（.gitignore 里的不该算「变了」）。

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listChangedPaths } from '../src/core/sched/audit.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** porcelain 的路径集合（旧的、慢的那条命令） */
function porcelainPaths(repo: string): Set<string> {
  const out = git(['status', '--porcelain', '--untracked-files=all'], repo);
  const paths = new Set<string>();
  for (const line of out.split('\n')) {
    if (line.length < 4) continue;
    if (line.startsWith('!!')) continue;
    let p = line.slice(3).trim();
    const arrow = p.indexOf(' -> ');
    if (arrow >= 0) p = p.slice(arrow + 4);
    paths.add(p.replace(/\\/g, '/'));
  }
  return paths;
}

describe('D-63：列改动用快路径，但语义必须一样', () => {
  let dir: string;
  let repo: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zelto-d63-'));
    repo = join(dir, 'repo');
    mkdirSync(repo, { recursive: true });
    git(['init', '-q', '-b', 'main'], repo);
    git(['config', 'user.email', 'test@zelto.local'], repo);
    git(['config', 'user.name', 'zelto test'], repo);
    writeFileSync(join(repo, 'tracked.txt'), 'a\n');
    writeFileSync(join(repo, 'staged.txt'), 'b\n');
    writeFileSync(join(repo, 'deleted.txt'), 'c\n');
    writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n');
    git(['add', '-A'], repo);
    git(['commit', '-q', '-m', 'init'], repo);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('干净的工作区 → 空集合', () => {
    assert.deepEqual(listChangedPaths(repo), []);
  });

  it('未跟踪的新文件**不能漏**（agent 新建文件是越界常见形态）', () => {
    writeFileSync(join(repo, 'brand-new.py'), 'x\n');
    const fast = listChangedPaths(repo);
    const slow = porcelainPaths(repo);
    assert.ok(fast.includes('brand-new.py'), '快路径漏了未跟踪文件');
    assert.deepEqual(new Set(fast), slow);
  });

  it('已修改 / 已暂存 / 已删除都覆盖', () => {
    writeFileSync(join(repo, 'tracked.txt'), 'changed\n');
    writeFileSync(join(repo, 'staged.txt'), 'staged change\n');
    git(['add', 'staged.txt'], repo);
    rmSync(join(repo, 'deleted.txt'));

    const fast = new Set(listChangedPaths(repo));
    const slow = porcelainPaths(repo);
    assert.ok(fast.has('tracked.txt'), '漏了已修改');
    assert.ok(fast.has('staged.txt'), '漏了已暂存');
    assert.ok(fast.has('deleted.txt'), '漏了已删除');
    assert.deepEqual(fast, slow);
  });

  it('被 ignore 的文件不算「变了」', () => {
    writeFileSync(join(repo, 'ignored.txt'), 'x\n');
    const fast = listChangedPaths(repo);
    const slow = porcelainPaths(repo);
    assert.ok(!fast.includes('ignored.txt'), 'ignore 的文件不该算进来');
    assert.deepEqual(new Set(fast), slow);
  });

  it('路径统一成正斜杠（与审计侧口径一致）', () => {
    mkdirSync(join(repo, 'sub', 'dir'), { recursive: true });
    writeFileSync(join(repo, 'sub', 'dir', 'file.txt'), 'x\n');
    const fast = listChangedPaths(repo);
    assert.ok(fast.includes('sub/dir/file.txt'), `正斜杠口径不对：${JSON.stringify(fast)}`);
  });
});
