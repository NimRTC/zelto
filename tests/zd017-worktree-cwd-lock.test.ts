// ZD-017：Windows 上「目录删不掉」的真因是别的进程把它设成了当前工作目录
//
// 实测（nimrtc-v14 v1-n5-turn-server，2026-11-20）：
//   worktree 目录**一个文件都没有**（只有 `.` 和 `..`），
//   但 `rd /s /q` 与 `[System.IO.Directory]::Delete` 都报
//     「另一个程序正在使用此文件夹，无法访问。」
//
//   `Restart Manager` API 报告 NO_LOCKERS（它只管**文件句柄**），
//   `Get-CimInstance Win32_Process` 也看不到 cwd。
//   最后靠读进程 PEB（NTLL→PEB→RTL_USER_PROCESS_PARAMETERS.CurrentDirectory）
//   才扫出真凶：`wslhost`（PID 21272）的 cwd 恰好停在那儿。
//
// 病灶：zelto 对「删不掉」只有一个笼统的报错，把两种**补救方式完全不同**
// 的占用混为一谈：
//   (a) 文件句柄被占（MSBuild 拿着 pdb）→ 等几秒就释放，rmdir 能删
//   (b) cwd 锁（目录是空的）            → 必须先杀掉蹲在里面的进程
//
// 修法：按**目录是否为空**区分这两类，给出人能照做的正确排查步骤。
// zelto 不自动去读 PEB 定位持有者 —— 那是特权操作，且超出 core/ 的
// 「纯判定」边界（C3）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { WorktreeManager, WorktreeError } from '../src/core/worktree/manager.js';

/** 造一个带初始提交的临时仓库 */
function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'zelto-zd017-'));
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'main');
  git('config', 'user.email', 'zd017@example.com');
  git('config', 'user.name', 'zd017');
  writeFileSync(join(root, 'README.md'), '# zd017\n');
  git('add', '.');
  git('commit', '-m', 'init');
  return root;
}

/**
 * 把 manager 摆成 ZD-016/ZD-017 的真实现场：
 *
 *   git 先摘了登记、再删目录 → 目录删不掉（文件句柄被占 / cwd 锁）
 *
 * 表现出来的序列是：
 *   1. `git worktree remove` 报占用类错误（Invalid argument）
 *   2. 事后查 `git worktree list` → **查不到**这个目录（登记已被摘）
 *   3. 直接删目录也失败 → 目录残留
 *
 * @param empty 目录是否为空（空 = cwd 锁的特征）
 */
function stageUndeletable(manager: WorktreeManager, empty: boolean): void {
  const wt = manager.pathFor('zd017-case');
  mkdirSync(wt, { recursive: true });
  if (!empty) writeFileSync(join(wt, 'artifact.bin'), 'x');

  const original = (manager as unknown as { git: (args: string[], errorMessage?: string, soft?: boolean, cwd?: string) => string })
    .git;
  // 移除开始后，git 侧就「不认」这个目录了（= 已摘登记）
  let deregistered = false;
  (manager as unknown as { git: (args: string[], errorMessage?: string, soft?: boolean, cwd?: string) => string }).git = (
    args: string[],
    errorMessage?: string,
    soft?: boolean,
    cwd?: string,
  ) => {
    if (args[0] === 'worktree' && args[1] === 'list') {
      // 已摘登记 → list 里查不到；未摘 → 报出这个路径（= 事前登记着）
      if (deregistered) return '';
      const real = original.call(manager, args, errorMessage, soft, cwd);
      return `${real}worktree ${wt}\nHEAD 0000000000000000000000000000000000000000\n`;
    }
    if (args[0] === 'worktree' && args[1] === 'remove') {
      deregistered = true;
      throw new WorktreeError(
        errorMessage ?? 'remove failed',
        'git worktree remove',
        "error: failed to delete '...': Invalid argument",
      );
    }
    return original.call(manager, args, errorMessage, soft, cwd);
  };

  // 直接删目录也失败 —— 模拟 Windows 的 cwd 锁（rmSync 删不掉）
  (manager as unknown as { deleteDirectoryDirectly: (t: string) => boolean }).deleteDirectoryDirectly =
    () => false;
}

test('ZD-017：目录为空且删不掉 → 报「cwd 锁」并给出 PEB 排查步骤', async () => {
  const repo = makeRepo();
  try {
    const manager = new WorktreeManager(repo);
    manager.removeRetryDelayMs = 0;
    stageUndeletable(manager, true);

    await assert.rejects(
      () => manager.remove('zd017-case', { force: true }),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        // 必须点名「当前工作目录」这一类锁，而不是笼统说「删不掉」
        assert.match(msg, /current working directory/i, '应识别为 cwd 锁');
        // 必须给出可照做的排查步骤
        assert.match(msg, /handle\.exe/, '应给出 handle.exe 排查步骤');
        assert.match(msg, /PEB/, '应给出读 PEB 定位 cwd 的办法');
        assert.match(msg, /rmdir \/s \/q/, '应给出最终的删除命令');
        return true;
      },
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('ZD-017：目录非空且删不掉 → 报「文件句柄被占」，不误报 cwd 锁', async () => {
  const repo = makeRepo();
  try {
    const manager = new WorktreeManager(repo);
    manager.removeRetryDelayMs = 0;
    stageUndeletable(manager, false);

    await assert.rejects(
      () => manager.remove('zd017-case', { force: true }),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.match(msg, /file handles/i, '应识别为文件句柄占用');
        assert.doesNotMatch(msg, /current working directory/i, '不该误报成 cwd 锁');
        assert.match(msg, /rmdir \/s \/q/, '仍应给出删除命令');
        return true;
      },
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('ZD-017：占用类失败 + 登记已摘 + 目录能删 → 兜底删目录，不报错', async () => {
  const repo = makeRepo();
  try {
    const manager = new WorktreeManager(repo);
    manager.removeRetryDelayMs = 0;
    const wt = manager.pathFor('zd017-ok');
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, 'artifact.bin'), 'x');

    const original = (manager as unknown as { git: (args: string[], errorMessage?: string, soft?: boolean, cwd?: string) => string })
      .git;
    let deregistered = false;
    (manager as unknown as { git: (args: string[], errorMessage?: string, soft?: boolean, cwd?: string) => string }).git = (
      args: string[],
      errorMessage?: string,
      soft?: boolean,
      cwd?: string,
    ) => {
      if (args[0] === 'worktree' && args[1] === 'list') {
        if (deregistered) return '';
        const real = original.call(manager, args, errorMessage, soft, cwd);
        return `${real}worktree ${wt}\nHEAD 0000000000000000000000000000000000000000\n`;
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        deregistered = true;
        throw new WorktreeError(
          'remove failed',
          'git worktree remove',
          "error: failed to delete '...': Invalid argument",
        );
      }
      return original.call(manager, args, errorMessage, soft, cwd);
    };

    await manager.remove('zd017-ok', { force: true });
    assert.equal(existsSync(wt), false, '兜底路径应把目录删掉');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('ZD-017：非占用类失败仍立刻抛出，不被兜底吞掉（D-67 契约）', async () => {
  const repo = makeRepo();
  try {
    const manager = new WorktreeManager(repo);
    manager.removeRetryDelayMs = 0;
    const wt = manager.pathFor('zd017-git-error');
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, 'artifact.bin'), 'x');

    const original = (manager as unknown as { git: (args: string[], errorMessage?: string, soft?: boolean, cwd?: string) => string })
      .git;
    let calls = 0;
    (manager as unknown as { git: (args: string[], errorMessage?: string, soft?: boolean, cwd?: string) => string }).git = (
      args: string[],
      errorMessage?: string,
      soft?: boolean,
      cwd?: string,
    ) => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        calls++;
        throw new WorktreeError('remove failed', 'git worktree remove', 'fatal: not a working tree');
      }
      return original.call(manager, args, errorMessage, soft, cwd);
    };

    await assert.rejects(
      () => manager.remove('zd017-git-error', { force: true }),
      (err: unknown) => {
        // git 真正说的话必须在错误里可见（message 或 stderr 都算）
        const msg =
          err instanceof Error
            ? `${err.message} ${(err as { stderr?: string }).stderr ?? ''}`
            : String(err);
        assert.match(msg, /not a working tree/, 'git 的真错误必须原样可见');
        return true;
      },
      'git 的真错误必须原样抛出',
    );
    assert.equal(calls, 1, '非占用类错误只试一次');
    assert.equal(existsSync(wt), true, '不该在非占用类失败时删目录');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
