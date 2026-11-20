// ZD-021：submodule 指针错位不该拦下与它无关的合并
//
// 病灶（实测于 nimrtc-v14 v1-audio-p2 合并，2026-11-21）：
//
//   `zelto merge v1-audio-p2` 被拦下：
//
//     ⚠️  目标工作区有未提交改动，已跳过自动合并
//          M src/third_party/googletest
//          M src/third_party/libopus/src
//          …（11 项）
//
//   而那 11 条**不是人改的代码**：
//     - index 里记的 gitlink 是 `22244de5`（version/v1 分支上的旧指针）
//     - 工作区里那个 submodule **实际 checkout 的是** `acdb9e26`
//       （主仓工作区当前在的那个 commit）
//
//   也就是说：**主仓工作区里 submodule 被切过 commit**，
//   worktree 建出来时继承了这个状态。`alignSubmodulesToMainRepo`
//   本该把它对齐回 index 记录的指针，但它 `checkout --force` 失败了 ——
//   目标 commit 的对象**不在本地**（`--no-fetch` 不触网，C3 要求）。
//
//   而这次合并**根本不碰 `src/third_party`** ——
//   `git diff version/v1 slice/v1-audio-p2` 里那些路径一个都没出现。
//
//   拦住它 = 「因为仓库里有一处与本次无关的不一致，把这次合并也拦下」。
//   这与 D-29 的 `-dirty` 误报是同一族问题，但**形态不同、判据也不同**：
//   D-29 是「指针没变、只是内部脏」；ZD-021 是「指针本身与 index 不一致」。
//
// 修法（core/sched/audit.ts + cli/commands/merge-executor.ts）：
//   新增 `isSubmodulePointerMismatch` —— 判据：
//     1. 该路径在 index 里是 gitlink（mode 160000）→ 确实是 submodule；
//     2. 工作区里那个 submodule 实际 checkout 的 commit 与 index 记录的不一致。
//
// 方向：**只豁免「指针错位」这一种形态**。
// 「人真的改了 submodule 指向的源码」不在此列 ——
// 那种情况 `git diff` 会报出具体文件，不是指针错位。
//
// 覆盖点：
//   1. 指针错位 → 判成「不是脏」（豁免）
//   2. 指针一致 → 判成「不是错位」（不豁免，仍由 -dirty 通道处理）
//   3. 非 submodule 路径（普通文件）→ 判成「不是错位」（不豁免）
//   4. 读不出来 → 判成「不是错位」（保守，维持拦截）

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { isSubmodulePointerMismatch } from '../src/core/sched/audit.js';

/** 在一个目录里跑 git */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

describe('ZD-021 submodule 指针错位不算「未提交改动」', () => {
  let repo: string;
  let first: string;
  let second: string;

  before(() => {
    const root = mkdtempSync(join(tmpdir(), 'zelto-zd021-'));

    // 上游仓库（当作 submodule 的来源）
    const upstream = join(root, 'upstream');
    mkdirSync(upstream, { recursive: true });
    git(upstream, 'init', '-q');
    writeFileSync(join(upstream, 'a.txt'), 'one\n');
    git(upstream, 'add', 'a.txt');
    git(upstream, 'commit', '-q', '-m', 'first');
    first = git(upstream, 'rev-parse', 'HEAD').trim();

    writeFileSync(join(upstream, 'a.txt'), 'two\n');
    git(upstream, 'commit', '-q', '-am', 'second');
    second = git(upstream, 'rev-parse', 'HEAD').trim();

    // 主仓：把 upstream 作为 submodule 加进去，并记录**第一个** commit
    repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q');
    git(repo, 'config', 'protocol.file.allow', 'always');
    writeFileSync(join(repo, 'README.md'), 'repo\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-q', '-m', 'init');
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', upstream, 'vendor/x');
    git(repo, 'commit', '-q', '-m', 'add submodule');
    // index 里记的是 first（submodule add 记录的默认就是当前 HEAD，所以要显式改）
    git(repo, '-C', 'vendor/x', 'checkout', '-q', first);
    git(repo, 'add', 'vendor/x');
    git(repo, 'commit', '-q', '-m', 'pin to first');

    // 现在把工作区里的 submodule 切到 second —— 指针错位
    git(repo, '-C', 'vendor/x', 'checkout', '-q', second);
  });

  after(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('指针与 index 记录不一致 → 判成「错位」（豁免合并）', () => {
    assert.equal(
      isSubmodulePointerMismatch(repo, 'vendor/x'),
      true,
      '工作区 checkout 的 commit 与 index 记录的不一致，应当判成指针错位',
    );
  });

  it('指针与 index 记录一致 → 不判成错位', () => {
    git(repo, '-C', 'vendor/x', 'checkout', '-q', first);
    assert.equal(
      isSubmodulePointerMismatch(repo, 'vendor/x'),
      false,
      '指针一致时不该判成错位（内部脏由 -dirty 通道管）',
    );
  });

  it('普通文件（不是 submodule）→ 不判成错位', () => {
    assert.equal(
      isSubmodulePointerMismatch(repo, 'README.md'),
      false,
      '普通文件不该被判成 submodule 指针错位 —— 那是真实改动，必须拦',
    );
  });

  it('不存在的路径 → 不判成错位', () => {
    assert.equal(isSubmodulePointerMismatch(repo, 'no/such/path'), false);
  });
});
