// D-72：`git worktree remove` 硬拒移除含 submodule 的 worktree
//
// 实测（nimrtc-zelto v5，2026-11-18）：
//   `zelto version cleanup v5` 报
//     "移除版本工作目录失败: .zelto\version-worktrees\v5:
//      fatal: working trees containing submodules cannot be moved or removed"
//   人只能自己去敲 `git worktree remove --force`。
//
// 根因：git 硬拒移除含 submodule 的 worktree（子模块的 gitlink 归属与
// worktree 生命周期冲突，git 不愿替你收拾）。
//
// 修法：判定 worktree 是否含 submodule（有 `.gitmodules` 即有登记），
// 含则自动加 `--force`。
//
// 实测确认（git 2.49.0.windows.1）：
//   - 移除含 submodule 的 worktree 不加 `--force` → 硬拒
//   - 先 `git submodule deinit -f --all` 再移除 → **仍然硬拒**（deinit 不解此问题）
//   - 加 `--force` → 成功，且：worktree 目录删掉、git 登记清掉、
//     分支保留、主仓的 submodule 与 .gitmodules 完全不受影响
//
// 覆盖点：
//   1. 含 submodule 的 worktree 能被移除（不再报硬拒）
//   2. 人没给 --force 时也自动加（清理工作目录不该被 submodule 卡住）
//   3. 没有 .gitmodules 的 worktree 不加 --force（不越权）
//   4. 移除后主仓的 submodule 登记与内容不受影响
//   5. 分支保留（追溯锚点由人决定，见 D6-C）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { WorktreeManager } from '../src/core/worktree/manager.js';

const gitAt = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

/** 造一个带初始提交的临时仓库 */
function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'zelto-d72-'));
  gitAt(root, 'init', '-b', 'main');
  gitAt(root, 'config', 'user.email', 'd72@example.com');
  gitAt(root, 'config', 'user.name', 'd72');
  gitAt(root, 'config', 'protocol.file.allow', 'always');
  writeFileSync(join(root, 'README.md'), '# d72\n');
  gitAt(root, 'add', '.');
  gitAt(root, 'commit', '-m', 'init');
  return root;
}

/** 造一个「本地 submodule」：主仓把另一个本地目录加成 submodule（不走网络） */
function makeSubmoduleSource(): string {
  const root = mkdtempSync(join(tmpdir(), 'zelto-d72-sub-'));
  gitAt(root, 'init', '-b', 'main');
  gitAt(root, 'config', 'user.email', 'd72@example.com');
  gitAt(root, 'config', 'user.name', 'd72');
  gitAt(root, 'config', 'protocol.file.allow', 'always');
  writeFileSync(join(root, 'sub.txt'), 'sub\n');
  gitAt(root, 'add', '.');
  gitAt(root, 'commit', '-m', 'sub init');
  return root;
}

function addLocalSubmodule(repo: string, subRepo: string, path: string): void {
  gitAt(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subRepo, path);
  gitAt(repo, 'commit', '-q', '-m', 'add submodule');
  gitAt(repo, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '-q');
}

test('D-72：含 submodule 的 worktree 能被移除（不再被 git 硬拒）', async () => {
  const repo = makeRepo();
  const sub = makeSubmoduleSource();
  try {
    addLocalSubmodule(repo, sub, 'vendor/sub');

    const manager = new WorktreeManager(repo);
    manager.removeRetryDelayMs = 0;
    await manager.createVersionWorktree('v72', { branch: 'version/v72' });

    const wt = manager.versionPathFor('v72');
    assert.ok(existsSync(wt), '版本工作目录应已创建');
    assert.ok(
      existsSync(join(wt, '.gitmodules')),
      'worktree 里应有 .gitmodules（submodule 的登记）',
    );

    // 前置事实：git 确实硬拒移除含 submodule 的 worktree（不加 --force）
    let refused = '';
    try {
      gitAt(repo, 'worktree', 'remove', wt);
    } catch (err) {
      refused = String((err as { stderr?: string }).stderr ?? (err as Error).message);
    }
    assert.match(
      refused,
      /submodules cannot be moved or removed/,
      '前置事实：git 硬拒移除含 submodule 的 worktree',
    );

    // 修法：zelto 自己判定并加 --force
    await manager.removeVersionWorktree('v72');

    assert.equal(existsSync(wt), false, '移除后目录应被删掉');
    assert.equal(
      gitAt(repo, 'worktree', 'list').includes('v72'),
      false,
      'git 侧的 worktree 登记也应清掉',
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(sub, { recursive: true, force: true });
  }
});

test('D-72：人没给 --force 时也自动加（不被 submodule 卡住）', async () => {
  const repo = makeRepo();
  const sub = makeSubmoduleSource();
  try {
    addLocalSubmodule(repo, sub, 'vendor/sub');

    const manager = new WorktreeManager(repo);
    manager.removeRetryDelayMs = 0;
    await manager.createVersionWorktree('v72b', { branch: 'version/v72b' });

    const wt = manager.versionPathFor('v72b');

    // 人**没有**传 --force
    await manager.removeVersionWorktree('v72b');

    assert.equal(existsSync(wt), false, '清理工作目录不该因为 submodule 而失败');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(sub, { recursive: true, force: true });
  }
});

test('D-72：没有 .gitmodules 的 worktree 不加 --force（不越权）', async () => {
  const repo = makeRepo();
  try {
    const manager = new WorktreeManager(repo);
    manager.removeRetryDelayMs = 0;
    await manager.createVersionWorktree('v72c', { branch: 'version/v72c' });

    const wt = manager.versionPathFor('v72c');
    assert.equal(
      existsSync(join(wt, '.gitmodules')),
      false,
      '前置事实：无 submodule 的 worktree 不该有 .gitmodules',
    );
    assert.equal(
      manager.needsForceForSubmodules(wt),
      false,
      '无 submodule 时不该判定为需要 --force',
    );

    const calls: string[][] = [];
    const original = manager['git' as keyof WorktreeManager] as unknown as (
      args: string[],
      errorMessage?: string,
      soft?: boolean,
      cwd?: string,
    ) => string;
    (manager as unknown as { git: typeof original }).git = (args, errorMessage, soft, cwd) => {
      calls.push(args);
      return original.call(manager, args, errorMessage, soft, cwd);
    };

    await manager.removeVersionWorktree('v72c');

    const removeCall = calls.find((a) => a[0] === 'worktree' && a[1] === 'remove');
    assert.ok(removeCall, '应调用 worktree remove');
    assert.equal(
      removeCall?.includes('--force'),
      false,
      '无 submodule 时不该擅自加 --force',
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('D-72：移除后主仓的 submodule 登记与内容不受影响', async () => {
  const repo = makeRepo();
  const sub = makeSubmoduleSource();
  try {
    addLocalSubmodule(repo, sub, 'vendor/sub');
    const before = gitAt(
      repo,
      'config',
      '--file',
      '.gitmodules',
      '--get-regexp',
      '^submodule\\..*\\.path$',
    );

    const manager = new WorktreeManager(repo);
    manager.removeRetryDelayMs = 0;
    await manager.createVersionWorktree('v72d', { branch: 'version/v72d' });
    await manager.removeVersionWorktree('v72d');

    const after = gitAt(
      repo,
      'config',
      '--file',
      '.gitmodules',
      '--get-regexp',
      '^submodule\\..*\\.path$',
    );
    assert.equal(after, before, '主仓的 .gitmodules 不应被改动');
    assert.ok(
      existsSync(join(repo, 'vendor', 'sub', 'sub.txt')),
      '主仓里 submodule 的内容应还在',
    );
    assert.equal(
      gitAt(repo, 'status', '--short').trim(),
      '',
      '主仓工作区应保持干净',
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(sub, { recursive: true, force: true });
  }
});

test('D-72：分支保留（追溯锚点由人决定，见 D6-C）', async () => {
  const repo = makeRepo();
  const sub = makeSubmoduleSource();
  try {
    addLocalSubmodule(repo, sub, 'vendor/sub');

    const manager = new WorktreeManager(repo);
    manager.removeRetryDelayMs = 0;
    await manager.createVersionWorktree('v72e', { branch: 'version/v72e' });
    await manager.removeVersionWorktree('v72e');

    assert.ok(
      existsSync(join(repo, '.git', 'refs', 'heads', 'version', 'v72e')) ||
        gitAt(repo, 'rev-parse', '--verify', 'refs/heads/version/v72e').length > 0,
      '版本分支应保留 —— cleanup 只删目录，不删追溯锚点',
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(sub, { recursive: true, force: true });
  }
});
