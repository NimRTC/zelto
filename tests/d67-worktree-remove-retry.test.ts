// D-67：`git worktree remove` 单次失败即放弃 → Windows 上残留整棵构建树
//
// 实测（nimrtc-zelto v4，2026-11-18）：
//   `zelto merge v4-voice-agent` 报
//     "Worktree removal failed: ... error: failed to delete '...': Invalid argument"
//   而那个目录里躺着一整棵 cmake 构建树（build/tests/Debug/*.exe、msquic.dll）。
//   agent 刚跑完验收时，这些 exe 的文件句柄还开着 —— git 删不掉。
//   几秒后句柄释放，等 20 秒再 `rmdir /s /q` 就干净了。
//
// zelto 之前只试一次，失败就让人手动删。修法：占用类错误退避重试。
//
// 覆盖点：
//   1. 占用类错误 → 自动重试并最终成功（不残留目录）
//   2. 非占用类错误 → 立刻抛出，不浪费人的时间
//   3. 重试耗尽仍失败 → 抛出（不静默吞掉）
//   4. 目录在重试期间被别人删掉 → 视为成功

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { WorktreeManager } from '../src/core/worktree/manager.js';

/** 造一个带初始提交的临时仓库 */
function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'zelto-d67-'));
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'main');
  git('config', 'user.email', 'd67@example.com');
  git('config', 'user.name', 'd67');
  writeFileSync(join(root, 'README.md'), '# d67\n');
  git('add', '.');
  git('commit', '-m', 'init');
  return root;
}

test('D-67：占用类错误触发重试，重试成功后目录被清掉', async () => {
  const repo = makeRepo();
  try {
    const manager = new WorktreeManager(repo);
    manager.removeRetryDelayMs = 0;
    const wt = manager.pathFor('d67-busy');
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, 'a.txt'), 'x');

    const original = manager['git' as keyof WorktreeManager] as unknown as (
      args: string[],
      errorMessage?: string,
      soft?: boolean,
      cwd?: string,
    ) => string;

    let calls = 0;
    // 前两次模拟「文件被占用」，第三次放行
    (manager as unknown as { git: typeof original }).git = (args, errorMessage, soft, cwd) => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        calls++;
        if (calls <= 2) {
          throw new Error('failed to delete: Invalid argument');
        }
        rmSync(wt, { recursive: true, force: true });
        return '';
      }
      return original.call(manager, args, errorMessage, soft, cwd);
    };

    await manager.remove('d67-busy', { force: true });

    assert.equal(calls, 3, '应重试到第 3 次才成功');
    assert.equal(existsSync(wt), false, '重试成功后目录应被删掉');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('D-67：非占用类错误立刻抛出，不做无谓重试', async () => {
  const repo = makeRepo();
  try {
    const manager = new WorktreeManager(repo);
    manager.removeRetryDelayMs = 0;
    const wt = manager.pathFor('d67-hard');
    mkdirSync(wt, { recursive: true });

    let calls = 0;
    (manager as unknown as { git: (args: string[]) => string }).git = (args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        calls++;
        throw new Error('fatal: not a working tree');
      }
      return '';
    };

    await assert.rejects(() => manager.remove('d67-hard', { force: true }), /not a working tree/);
    assert.equal(calls, 1, '非占用类错误只试一次');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('D-67：重试期间目录被别人删掉 → 视为成功', async () => {
  const repo = makeRepo();
  try {
    const manager = new WorktreeManager(repo);
    manager.removeRetryDelayMs = 0;
    const wt = manager.pathFor('d67-vanished');
    mkdirSync(wt, { recursive: true });

    let calls = 0;
    (manager as unknown as { git: (args: string[]) => string }).git = (args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        calls++;
        rmSync(wt, { recursive: true, force: true }); // 模拟「别人删了」
        throw new Error('failed to delete: Invalid argument');
      }
      return '';
    };

    await manager.remove('d67-vanished', { force: true });
    assert.ok(calls >= 1);
    assert.equal(existsSync(wt), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('D-67：重试耗尽仍失败 → 抛出（不静默吞掉）', async () => {
  const repo = makeRepo();
  try {
    const manager = new WorktreeManager(repo);
    manager.removeRetryDelayMs = 0;
    const wt = manager.pathFor('d67-hopeless');
    mkdirSync(wt, { recursive: true });

    let calls = 0;
    (manager as unknown as { git: (args: string[]) => string }).git = (args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        calls++;
        throw new Error('failed to delete: Invalid argument');
      }
      return '';
    };

    await assert.rejects(() => manager.remove('d67-hopeless', { force: true }), /Invalid argument/);
    assert.equal(calls, 5, '应重试满 5 次再报错');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
