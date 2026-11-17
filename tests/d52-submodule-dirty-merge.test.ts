// D-52：合并守卫不该把「submodule 只有 -dirty 标记」判成工作区不干净
//
// 病灶（实测于 nimrtc-zelto，2026-11-17）：
//
//   `git status --porcelain` 报 ` M src/third_party/msquic`，
//   但 `git diff` 显示的只有：
//
//     -Subproject commit a5ae3a06ed6e3c054c251892370801db98d85174
//     +Subproject commit a5ae3a06ed6e3c054c251892370801db98d85174-dirty
//
//   **指针一模一样**，只多了 `-dirty` —— 意思是「submodule 内部有未提交的
//   改动」（nimrtc 的 msquic 里嵌着 quictls，CRLF 换行导致的经典假脏）。
//
//   这不是「人改了代码还没提交」—— 主仓的 gitlink 指针没动，
//   合并**不会碰它**，也不会盖掉任何东西。
//
//   但合并守卫只看 `git status --porcelain`，于是判成「工作区不干净」→
//   合并被拦下 → **每一片都合不进去**。
//   实测：v2-input-binder 门禁通过、签字通过，却合不进 version/v2。
//
// 这一组用例守的是判据本身（纯 git 调用，不触网、不调模型 —— C3）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isSubmoduleOnlyDirty } from '../src/core/sched/audit.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * 建一个带 submodule 的仓库。
 *
 * submodule 用本地路径当源（不联网）—— `git submodule add` 支持本地仓库。
 */
function makeRepoWithSubmodule(): { root: string; sub: string } {
  const base = mkdtempSync(join(tmpdir(), 'zelto-sub-'));
  const root = join(base, 'main');
  const sub = join(base, 'sub');
  mkdirSync(root);
  mkdirSync(sub);

  // ── submodule 源仓库 ──────────────────────────────────────────────
  git(['init', '-q', '-b', 'main'], sub);
  writeFileSync(join(sub, 'a.txt'), 'hello\n', 'utf-8');
  git(['add', '.'], sub);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], sub);

  // ── 主仓库 ────────────────────────────────────────────────────────
  git(['init', '-q', '-b', 'main'], root);
  writeFileSync(join(root, 'r.txt'), 'root\n', 'utf-8');
  git(['add', '.'], root);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], root);
  git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/sub'], root);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'add submodule'], root);

  return { root, sub };
}

describe('D-52 submodule 只有 -dirty 标记', () => {
  it('submodule 内部有未提交改动、指针没变 → 不算脏', () => {
    const base = mkdtempSync(join(tmpdir(), 'zelto-sub-'));
    const root = join(base, 'main');
    const sub = join(base, 'sub');
    try {
      mkdirSync(root);
      mkdirSync(sub);
      git(['init', '-q', '-b', 'main'], sub);
      writeFileSync(join(sub, 'a.txt'), 'hello\n', 'utf-8');
      git(['add', '.'], sub);
      git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], sub);

      git(['init', '-q', '-b', 'main'], root);
      writeFileSync(join(root, 'r.txt'), 'root\n', 'utf-8');
      git(['add', '.'], root);
      git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], root);
      git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/sub'], root);
      git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'add submodule'], root);

      // 在 submodule 内部制造一处未提交改动（指针不变，只有 -dirty）
      writeFileSync(join(root, 'vendor', 'sub', 'a.txt'), 'dirty\n', 'utf-8');

      const status = git(['status', '--porcelain'], root);
      assert.match(status, /vendor\/sub/, 'submodule 应当出现在 status 里');

      assert.equal(
        isSubmoduleOnlyDirty(root, 'vendor/sub'),
        true,
        '指针没变、只有 -dirty 标记 → 不算脏',
      );
    } finally {
      rmSync(base, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it('submodule 指针真的变了 → 算脏', () => {
    const { root, sub } = makeRepoWithSubmodule();
    const base = root.replace(/main$/, '');
    try {
      // 在 submodule 源仓库里加一个新提交，然后把 submodule 检出到它上面
      writeFileSync(join(sub, 'b.txt'), 'new\n', 'utf-8');
      git(['add', '.'], sub);
      git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'second'], sub);
      git(['-C', 'vendor/sub', 'fetch', '-q', 'origin'], root);
      git(['-C', 'vendor/sub', 'checkout', '-q', 'FETCH_HEAD'], root);

      assert.equal(
        isSubmoduleOnlyDirty(root, 'vendor/sub'),
        false,
        '指针变了 → 算脏（必须拦住）',
      );
    } finally {
      rmSync(base, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it('普通文件变脏 → 算脏（不是 submodule 就不该豁免）', () => {
    const base = mkdtempSync(join(tmpdir(), 'zelto-sub-'));
    const root = join(base, 'main');
    try {
      mkdirSync(root);
      git(['init', '-q', '-b', 'main'], root);
      writeFileSync(join(root, 'r.txt'), 'root\n', 'utf-8');
      git(['add', '.'], root);
      git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], root);
      writeFileSync(join(root, 'r.txt'), 'changed\n', 'utf-8');

      assert.equal(isSubmoduleOnlyDirty(root, 'r.txt'), false);
    } finally {
      rmSync(base, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it('不存在的路径 → 算脏（判不出来就拦住）', () => {
    const base = mkdtempSync(join(tmpdir(), 'zelto-sub-'));
    const root = join(base, 'main');
    try {
      mkdirSync(root);
      git(['init', '-q', '-b', 'main'], root);
      assert.equal(isSubmoduleOnlyDirty(root, 'no/such/path'), false);
    } finally {
      rmSync(base, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
