// 回归测试：worktree 里的 worktree（`.git` 是**文件**）跑 run 时，
// submodule 同步必须找得到 module git 目录。
//
// 病灶（实测 nimrtc-v14 v1-ice-recovery，2026-11-23）：
//   `zelto run` 是在**版本工作目录** `.zelto/version-worktrees/<label>/` 里跑的，
//   那里的 `.git` 是**文件**（`gitdir: D:/repo/.git/worktrees/<name>`），
//   不是目录。
//
//   于是 `syncSubmodules()` 里那句
//     join(repoRoot, '.git', 'modules', ...)
//   指向一个**根本不存在**的路径 → 14 个 submodule 全部 skipped
//   → worktree 里 vendor 全空
//   → `alignSubmodulesToMainRepo()` 去问「commit 在不在」时问错了仓库
//     （空目录没有 `.git`，git 向上找到**顶层仓库**）
//   → 回答「没有 ac01707f」→ 抛错「无法创建隔离 worktree」。
//
// 而那个 commit **确实存在**（在 `.git/worktrees/<name>/modules/...` 里）。
// 也就是说：报错是假的，而人看到的是「本地缺 vendor commit」——
// 一条会让人去 fetch、去改主仓 index 的**错误方向**。
//
// 覆盖点：
//   1. 从**版本工作目录**（`.git` 是文件）里建切片 worktree → vendor 必须有内容
//   2. 不得抛「本地 module git 目录里没有 index 记录的 commit」
//   3. worktree 里 submodule 必须被检出到**钉死的**那个 commit
//   4. 主仓（`.git` 是目录）里的老路径不能因此坏掉（回归防护）

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { WorktreeManager } from '../src/core/worktree/manager.js';

function rmWithRetry(dir: string): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

interface Layout {
  base: string;
  /** 主仓（`.git` 是**目录**） */
  root: string;
  /** 版本工作目录（`.git` 是**文件**）—— 复刻 `.zelto/version-worktrees/<label>/` */
  versionDir: string;
  pinned: string;
}

/**
 * 造出「主仓 + submodule + 版本工作目录（.git 是文件）」的布局。
 */
function makeLayout(): Layout {
  const base = mkdtempSync(join(tmpdir(), 'zelto-wt-of-file-'));
  const upstream = join(base, 'upstream');
  const root = join(base, 'main');
  const versionDir = join(base, 'version-worktrees', 'v3');

  // ── upstream ────────────────────────────────────────────────────
  mkdirSync(upstream, { recursive: true });
  git(upstream, 'init', '-b', 'main');
  git(upstream, 'config', 'user.email', 'wt@example.com');
  git(upstream, 'config', 'user.name', 'wt');
  writeFileSync(join(upstream, 'vendor.h'), '// v1\n');
  git(upstream, 'add', '.');
  git(upstream, 'commit', '-m', 'pinned');
  const pinned = git(upstream, 'rev-parse', 'HEAD').trim();

  // ── 主仓 ────────────────────────────────────────────────────────
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'wt@example.com');
  git(root, 'config', 'user.name', 'wt');
  git(root, 'config', 'protocol.file.allow', 'always');
  writeFileSync(join(root, 'README.md'), '# main\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'init');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', upstream, 'vendor');
  git(root, 'commit', '-m', 'add submodule');

  // ── 版本工作目录（.git 是**文件**）────────────────────────────
  //
  // 这正是 `git worktree add` 的布局：主仓的 `.git/worktrees/<name>/` 里
  // 存着那个 worktree 的 git 目录，worktree 自己只留一个 `.git` **文件**。
  mkdirSync(join(base, 'version-worktrees'), { recursive: true });
  git(root, 'worktree', 'add', '-b', 'version/v3', versionDir);

  // 确认前置条件：版本工作目录里 `.git` 确实**不是**目录。
  assert.ok(
    !existsSync(join(versionDir, '.git')) ||
      readFileSync(join(versionDir, '.git'), 'utf-8').trim().startsWith('gitdir:'),
    '测试设置有问题：版本工作目录里的 .git 应该是文件',
  );

  return { base, root, versionDir, pinned };
}

describe('回归 · worktree 里的 worktree（.git 是文件）同步 submodule', () => {
  let base = '';

  afterEach(() => {
    if (base) rmWithRetry(base);
    base = '';
  });

  it('从版本工作目录建切片 worktree → vendor 必须有内容，且不报「缺 commit」', async () => {
    const layout = makeLayout();
    base = layout.base;

    // 关键：repoRoot 是**版本工作目录**（`.git` 是文件），不是主仓。
    const manager = new WorktreeManager(layout.versionDir);

    let caught: unknown = null;
    let info: Awaited<ReturnType<WorktreeManager['create']>> | null = null;
    try {
      info = await manager.create('s1', { initSubmodules: true });
    } catch (err) {
      caught = err;
    }

    assert.equal(
      caught,
      null,
      `不该抛错（那个 commit 确实存在）：${caught instanceof Error ? caught.message : String(caught)}`,
    );
    assert.ok(info);

    assert.ok(
      existsSync(join(info.path, 'vendor', 'vendor.h')),
      'worktree 里的 vendor 必须有内容 —— 同步不能被静默跳过',
    );
  });

  it('worktree 里的 submodule 必须检出到钉死的那个 commit', async () => {
    const layout = makeLayout();
    base = layout.base;

    const manager = new WorktreeManager(layout.versionDir);
    const info = await manager.create('s1', { initSubmodules: true });

    const head = git(join(info.path, 'vendor'), 'rev-parse', 'HEAD').trim();
    assert.equal(
      head,
      layout.pinned,
      'submodule 必须检出到 index 里钉死的 commit（不能是共享 module 目录的 HEAD）',
    );
  });

  it('主仓（.git 是目录）的老路径没因此坏掉', async () => {
    const layout = makeLayout();
    base = layout.base;

    const manager = new WorktreeManager(layout.root);
    const info = await manager.create('s1', { initSubmodules: true });

    assert.ok(
      existsSync(join(info.path, 'vendor', 'vendor.h')),
      '主仓里建 worktree 的老路径必须照常工作',
    );
  });
});
