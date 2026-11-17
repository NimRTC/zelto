// D-65：写集审计读不到 git 时必须**fail closed**，不能报「没有越界」
//
// 病灶（D-63 的回归，2026-11-18）：
//
//   D-63 把基线快照从 `git status --porcelain --untracked-files=all`
//   换成 `listChangedPaths`（diff + diff --cached + ls-files）——
//   前者在冷 worktree 上要 224 秒，后者快 17 倍。这条修法本身是对的。
//
//   但 `listChangedPaths` 初版把三条命令的异常**全 catch 掉**了：
//
//     try { add(git(['diff', '--name-only'], repoRoot)); } catch { /* 少一路 */ }
//
//   而「不是 git 仓库」这种场景下**三条命令全部失败**：
//
//     git diff --name-only         → exit 129（warning: Not a git repository）
//     git diff --cached --name-only → exit 129
//     git ls-files --others ...    → exit 128（fatal: not a git repository）
//
//   三路全失败 → 返回**空数组** → 空数组在审计那边是「这个 worktree
//   什么都没改」→ `auditWorktreeWrites` 报 `violations: []`、`error: null`
//   → **审计通过了**。
//
//   这与 C9 直接冲突：写集审计的意义是「越界就拦下」。
//   而「git 读不出来」时它反而说「一切正常」——
//   越界写入会在审计里**消失**，而且消失得毫无痕迹。
//
//   实测：在非仓库目录里 `auditWorktreeWrites(dir, ['src/**'])`，
//   `result.error` 是 null、`result.violations` 是空。
//   （同批的 audit.test.ts 用例「reports an error instead of throwing
//   when git is unavailable」直接挂了。）
//
// 这一组用例守的是：
//   1. 非仓库目录里审计 → 报 `error`，不是「没有越界」；
//   2. `listChangedPaths` 在读不到时**抛错**，不吞；
//   3. 抛错时仍要带路径信息，人要知道去哪儿查；
//   4. 正常的仓库里照常工作（别把修法做成什么都读不出来）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { auditWorktreeWrites, listChangedPaths } from '../src/core/sched/audit.js';
import { snapshotBaselineChanged } from '../src/cli/commands/runtime-guard.js';

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zelto-d65-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  git('init', '-q');
  git('config', 'user.email', 'test@zelto.local');
  git('config', 'user.name', 'zelto test');
  return dir;
}

describe('D-65：审计读不到 git 时 fail closed', () => {
  it('非仓库目录里审计 → 报 error，不报「没有越界」', () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'zelto-d65-notrepo-'));
    try {
      const result = auditWorktreeWrites(notARepo, ['src/**']);

      assert.ok(
        result.error,
        `读不到 git 必须报 error —— 否则等于说「这个 worktree 没有任何越界写入」（C9）`,
      );
      assert.match(result.error, /git status 失败|git|失败/i);
      assert.deepEqual(result.violations, []);
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it('listChangedPaths 在非仓库目录里抛错，不返回空数组', () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'zelto-d65-notrepo-'));
    try {
      assert.throws(
        () => listChangedPaths(notARepo),
        '读不到 git 必须抛错 —— 空数组会被当成「什么都没改」',
      );
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it('基线快照在非仓库目录里抛错并说清「这一轮不开工」', () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'zelto-d65-notrepo-'));
    try {
      assert.throws(
        () => snapshotBaselineChanged(notARepo),
        (err: Error) => {
          assert.match(err.message, /基线快照/, `错误信息要说清是基线快照：${err.message}`);
          assert.match(err.message, /不开工/, '错误信息要说清这一轮不开工');
          assert.ok(
            err.message.includes(notARepo),
            `错误信息要带 worktree 路径，实际：${err.message}`,
          );
          return true;
        },
      );
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });
});

describe('D-65：正常仓库里照常工作', () => {
  it('未跟踪的新文件能被列出来', () => {
    const dir = makeRepo();
    try {
      writeFileSync(join(dir, 'new.ts'), 'export const n = 1;\n', 'utf-8');
      const changed = listChangedPaths(dir);
      assert.ok(
        changed.includes('new.ts'),
        `未跟踪文件必须列出来，实际：${JSON.stringify(changed)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('已修改的文件能被列出来', () => {
    const dir = makeRepo();
    try {
      writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n', 'utf-8');
      execFileSync('git', ['add', '-A'], { cwd: dir });
      execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
      writeFileSync(join(dir, 'a.ts'), 'export const a = 2;\n', 'utf-8');

      const changed = listChangedPaths(dir);
      assert.ok(
        changed.includes('a.ts'),
        `已修改文件必须列出来，实际：${JSON.stringify(changed)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('干净仓库 → 空数组（这次是真的「什么都没改」）', () => {
    const dir = makeRepo();
    try {
      assert.deepEqual(listChangedPaths(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('正常仓库里审计能判出越界', () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'ok.ts'), 'export const o = 1;\n', 'utf-8');
      writeFileSync(join(dir, 'stray.ts'), 'export const s = 1;\n', 'utf-8');

      const result = auditWorktreeWrites(dir, ['src/**']);
      assert.equal(result.error, null);
      assert.deepEqual(result.violations, ['stray.ts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
