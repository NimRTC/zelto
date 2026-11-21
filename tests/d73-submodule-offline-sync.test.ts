// D-73：submodule 同步必须**离线**、**限时**，且失败原因要显形
//
// 实测（nimrtc v1.4，2026-11-20）：
//   Web 驾驶舱点「开跑」→ 报「发起运行超时（30 秒）」——
//   而实际上一个 agent 都没起，切片却卡在了 `running`。
//
// 根因是三件事叠在一起：
//
//   1. `git submodule update --init` 在「本地缺 index 记录的 commit」时
//      会去 **fetch** —— fetch 的目标是 `.gitmodules` 里写的**公网 URL**。
//      判定路径（worktree 准备）居然在联网 → 直接违反 C3。
//   2. 它**挂住**而不是失败：SSH 通向公网但没配 key → 一直等；
//      HTTPS 极慢；全局 `url.<x>.insteadOf` 把 https 改写成 ssh → 变成前者。
//      实测 14 个 submodule 串行同步 **127 秒**，其中两个各挂满 60 秒。
//   3. 失败被 `catch {}` 吞掉 —— 「worktree 里少了 12 个 vendor」完全不显形，
//      等到门禁报「找不到 googletest」时，人看到的是源码缺失，
//      跟「隔离目录没同步 vendor」毫无关系（ADR-044 记的就是这个病灶）。
//
// 修法（core/worktree/manager.ts）：
//   - `--no-fetch`：本地有就用本地的，本地没有就**如实失败**；
//   - 离线环境变量（`GIT_TERMINAL_PROMPT=0` / `GIT_SSH_COMMAND` 带
//     `BatchMode=yes`）：任何触网尝试**立刻失败**而不是挂住；
//   - 硬超时（默认 15 秒）：挂住也只挂到这里；
//   - 失败原因分类留痕：调用方能把它说成人话。
//
// 覆盖点：
//   1. 同步命令带 `--no-fetch`（不联网）
//   2. 同步命令跑在离线环境里（不弹密码、不等 SSH 确认）
//   3. 本地缺 commit 时**快速失败**（不是挂住），且失败被记下来
//   4. 失败原因分类：能区分「本地缺 commit」与「超时」
//   5. 同步成功时不产生失败记录
//   6. 超时上限可配置（测试里改小）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  WorktreeManager,
  describeSubmoduleFailure,
  DEFAULT_SUBMODULE_TIMEOUT_MS,
} from '../src/core/worktree/manager.js';

const gitAt = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'zelto-d73-'));
  gitAt(root, 'init', '-b', 'main');
  gitAt(root, 'config', 'user.email', 'd73@example.com');
  gitAt(root, 'config', 'user.name', 'd73');
  gitAt(root, 'config', 'protocol.file.allow', 'always');
  writeFileSync(join(root, 'README.md'), '# d73\n');
  gitAt(root, 'add', '.');
  gitAt(root, 'commit', '-m', 'init');
  return root;
}

/** 造一个本地 submodule 源仓库（不走网络） */
function makeSubmoduleSource(): string {
  const root = mkdtempSync(join(tmpdir(), 'zelto-d73-sub-'));
  gitAt(root, 'init', '-b', 'main');
  gitAt(root, 'config', 'user.email', 'd73@example.com');
  gitAt(root, 'config', 'user.name', 'd73');
  gitAt(root, 'config', 'protocol.file.allow', 'always');
  writeFileSync(join(root, 'sub.txt'), 'sub\n');
  gitAt(root, 'add', '.');
  gitAt(root, 'commit', '-m', 'sub init');
  return root;
}

/** 把本地目录加成 submodule 并初始化好（本地有全部 objects） */
function addLocalSubmodule(repo: string, subRepo: string, path: string): void {
  gitAt(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subRepo, path);
  gitAt(repo, 'commit', '-q', '-m', 'add submodule');
  gitAt(repo, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '-q');
}

/**
 * 造出「index 记的 commit 在本地不可达」的情形 —— 正是 nimrtc 的病灶。
 *
 * 手法：把 submodule 的 objects 目录挪走。于是 index 里记的那个 sha
 * 在本地 module git 目录里**查不到**，git 本来会去远程取，
 * 而我们用 `--no-fetch` 把它掐断 —— 它应当**如实快速失败**。
 */
/**
 * 挪走的 submodule objects 目录 —— 记下来，清理时一并删掉。
 *
 * 不记的话这些目录会永久留在 tmpdir 里（每个几百 KB），
 * 跑一轮测试就攒一批垃圾。
 */
const stashedObjectsDirs: string[] = [];

function makeSubmoduleCommitUnreachable(repo: string, path: string): void {
  const objectsDir = join(repo, '.git', 'modules', path, 'objects');
  const stashDir = join(tmpdir(), `zelto-d73-objects-${Date.now()}-${stashedObjectsDirs.length}`);
  renameSync(objectsDir, stashDir);
  stashedObjectsDirs.push(stashDir);
}

/**
 * 测试脚手架：一个带 submodule 的仓库 + 一个真实 worktree。
 *
 * 清理必须走 `git worktree remove` —— 直接 rm 目录在 Windows 上会 EPERM
 * （git 侧的登记还在，文件被占着）。
 *
 * @param initSubmodules `false` = 建 worktree 时**不**同步 submodule。
 *   为什么需要这个开关：同步要单独驱动才能观测到失败；
 *   而 `create()` 内部那一次同步会先把 submodule 准备好，
 *   后面的同步就永远成功了（测不到「本地缺 commit」这条路径）。
 */
async function makeScaffold(
  sliceId: string,
  options: { initSubmodules?: boolean } = {},
): Promise<{
  repo: string;
  sub: string;
  manager: WorktreeManager;
  worktreePath: string;
  cleanup: () => Promise<void>;
}> {
  const repo = makeRepo();
  const sub = makeSubmoduleSource();
  addLocalSubmodule(repo, sub, 'vendor/sub');

  const manager = new WorktreeManager(repo);
  const info = await manager.create(sliceId, {
    initSubmodules: options.initSubmodules ?? false,
  });

  return {
    repo,
    sub,
    manager,
    worktreePath: info.path,
    cleanup: async () => {
      try {
        await manager.remove(sliceId, { force: true });
      } catch {
        // 清理失败不该让测试失败 —— 断言已经跑完了。
      }
      // 直接 rm 目录在 Windows 上仍可能 EPERM（git 侧的 submodule
      // objects 目录被挪走过，git 清理时会重新打开它；句柄没放干净
      // 时 rm 拿不到独占访问）。所以：重试 + 失败就放过 ——
      // 临时目录留着只是占点磁盘，不该让测试变红。
      for (const dir of [...stashedObjectsDirs.splice(0), repo, sub]) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
            break;
          } catch {
            // 重试；三次还不行就放过（不让清理失败掩盖真正的断言结果）
          }
        }
      }
    },
  };
}

test('D-73：submodule 同步命令带 --no-fetch（不联网）', async () => {
  const s = await makeScaffold('d73a');
  try {
    const calls: string[][] = [];
    const original = s.manager['gitOffline' as keyof WorktreeManager] as unknown as (
      args: string[],
      cwd: string,
      timeoutMs: number,
    ) => string;
    (s.manager as unknown as { gitOffline: typeof original }).gitOffline = (args, cwd, timeout) => {
      calls.push(args);
      return original.call(s.manager, args, cwd, timeout);
    };

    s.manager.syncSubmodules(s.worktreePath);

    const updateCall = calls.find((a) => a.includes('submodule'));
    assert.ok(updateCall, '应调用 submodule 子命令');
    assert.ok(
      updateCall?.includes('--no-fetch'),
      'submodule 同步必须带 --no-fetch —— 否则本地缺 commit 时会去联网',
    );
  } finally {
    await s.cleanup();
  }
});

test('D-73：同步命令跑在离线环境里（不弹密码、不等 SSH 确认）', async () => {
  const s = await makeScaffold('d73b');
  try {
    // 离线环境下的 git 调用本身要能正常跑通
    // （说明那些环境变量没把 git 弄坏）。
    const out = (s.manager as unknown as {
      gitOffline: (args: string[], cwd: string, timeoutMs: number) => string;
    }).gitOffline(['rev-parse', '--is-inside-work-tree'], s.repo, 5000);
    assert.equal(out.trim(), 'true', '离线环境下的 git 调用应能正常跑通');

    // 触网路径必须**立刻失败**而不是挂住。
    const started = Date.now();
    s.manager.syncSubmodules(s.worktreePath);
    assert.ok(
      Date.now() - started < 10_000,
      '同步不应挂住 —— 本地有的 commit 应该秒级完成',
    );
  } finally {
    await s.cleanup();
  }
});

test('D-73：本地缺 commit 时快速失败（不是挂住），且失败被记下来', async () => {
  const s = await makeScaffold('d73c');
  try {
    makeSubmoduleCommitUnreachable(s.repo, 'vendor/sub');

    s.manager.submoduleTimeoutMsOverride = 5_000;

    const started = Date.now();
    s.manager.syncSubmodules(s.worktreePath);
    const elapsed = Date.now() - started;

    assert.ok(
      elapsed < 5_000,
      '同步应在超时上限内结束（实测 ' + elapsed + 'ms）—— 不能挂住',
    );
    assert.ok(
      s.manager.submoduleFailures.length > 0,
      '同步失败必须被记下来 —— 否则「vendor 没同步上」完全不显形',
    );
    assert.equal(
      s.manager.submoduleFailures[0]?.path,
      'vendor/sub',
      '失败记录要指出是哪个 submodule',
    );
    assert.match(
      s.manager.submoduleFailures[0]?.reason ?? '',
      /本地 module git 目录里没有/,
      '失败原因要能被识别成「本地缺 commit」（而不是让人以为源码丢了）',
    );
  } finally {
    await s.cleanup();
  }
});

test('D-73：失败原因分类 —— 区分「本地缺 commit」与「超时」', () => {
  const missingCommit = describeSubmoduleFailure({
    stderr: Buffer.from(
      "fatal: unable to read tree (ac01707f552c611fbd135cc723b2682b3e7f80f2)\n" +
        "fatal: Unable to checkout 'ac01707f' in submodule path 'src/third_party/wolfssl/src'\n",
    ),
    message: 'Command failed',
  });
  assert.match(missingCommit, /本地 module git 目录里没有/, '应识别出「本地缺 commit」');
  assert.match(missingCommit, /submodule update --init/, '应给出可执行的修法');

  const timeout = describeSubmoduleFailure({
    message: 'Command failed: spawnSync git ETIMEDOUT',
  });
  assert.match(timeout, /超时/, '应识别出超时');
  assert.match(timeout, /网络|SSH/, '超时应指向网络/SSH 配置');

  const other = describeSubmoduleFailure({
    stderr: Buffer.from('fatal: something else entirely\n'),
    message: 'Command failed',
  });
  assert.match(other, /something else entirely/, '认不出来的原因要贴原文，不装懂');
});

test('D-73：Linux 的 git 措辞也要识别成「本地缺 commit」（跨平台同一故障条件）', () => {
  // 同一个故障条件，git 在两个平台上的措辞不同：
  //   Windows：`unable to read tree (<sha>)`
  //   Linux：  `repository '<...>/.git/modules/vendor/sub' does not exist`
  //
  // 只认一种措辞 = 换个平台就退化成「贴原文」，人拿不到那条可执行的修法。
  const linuxWording = describeSubmoduleFailure({
    stderr: Buffer.from(
      "fatal: repository '/tmp/zelto-d73/.git/modules/vendor/sub' does not exist\n" +
        "fatal: clone of '/tmp/zelto-d73/.git/modules/vendor/sub' into submodule path " +
        "'/tmp/zelto-d73/.zelto/worktrees/d73c/vendor/sub' failed\n",
    ),
    message: 'Command failed',
  });
  assert.match(
    linuxWording,
    /本地 module git 目录里没有/,
    'Linux 措辞也应识别出「本地缺 commit」',
  );
  assert.match(linuxWording, /submodule update --init/, '应给出可执行的修法');
});

test('D-73：「远程仓库不可达」不能被误判成「本地缺 commit」（修法不同）', () => {
  // 远程不可达与本地缺 commit 的修法完全不同：
  //   - 本地缺 commit → 跑 `git submodule update --init` 补到本地
  //   - 远程不可达   → 查网络 / SSH / 凭据
  // 混起来会把人引去跑一条没用的命令。
  const remoteUnreachable = describeSubmoduleFailure({
    stderr: Buffer.from('fatal: Could not read from remote repository.\n'),
    message: 'Command failed',
  });
  assert.doesNotMatch(
    remoteUnreachable,
    /本地 module git 目录里没有/,
    '远程不可达不该被误判成「本地缺 commit」',
  );
  assert.match(remoteUnreachable, /凭据|权限/, '应指向凭据/权限');
});

test('D-73：同步成功时不产生失败记录（不误报）', async () => {
  const s = await makeScaffold('d73d');
  try {
    s.manager.submoduleFailures = [
      { path: 'stale/from-last-round', reason: '上一轮的失败不该残留' },
    ];

    s.manager.syncSubmodules(s.worktreePath);

    assert.deepEqual(
      s.manager.submoduleFailures,
      [],
      '同步成功（或每次同步前）应清空上一轮的失败记录',
    );
  } finally {
    await s.cleanup();
  }
});

test('D-73：超时上限有默认值且可配置', async () => {
  assert.equal(
    DEFAULT_SUBMODULE_TIMEOUT_MS,
    15_000,
    '默认超时 15 秒 —— 远小于 Web 的开跑预算，但足够本地同步',
  );

  const s = await makeScaffold('d73e');
  try {
    s.manager.submoduleTimeoutMsOverride = 1_234;

    const calls: number[] = [];
    const original = s.manager['gitOffline' as keyof WorktreeManager] as unknown as (
      args: string[],
      cwd: string,
      timeoutMs: number,
    ) => string;
    (s.manager as unknown as { gitOffline: typeof original }).gitOffline = (args, cwd, timeout) => {
      calls.push(timeout);
      return original.call(s.manager, args, cwd, timeout);
    };

    s.manager.syncSubmodules(s.worktreePath);

    assert.ok(
      calls.length > 0 && calls.every((t) => t === 1_234),
      '同步应使用配置的超时上限',
    );
  } finally {
    await s.cleanup();
  }
});
