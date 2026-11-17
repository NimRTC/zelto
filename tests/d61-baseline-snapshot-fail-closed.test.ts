// D-61：基线快照读不到时**不能**假装干净
//
// 病灶（实测 nimrtc-zelto v3-weaknet-verdict，2026-11-17）：
//
//   监督进程启动        17:46:21.348
//   写集预约已取得      17:47:21.932   ← 中间隔了 **60.584 秒**
//
// 那个 60 秒就是 `snapshotBaselineChanged` 里的
// `git status --porcelain --untracked-files=all` 撞上了 `timeout: 60_000`：
// 刚建出来的 worktree 要把整棵树 stat 一遍（nimrtc 带 googletest /
// msquic 两个大 submodule），冷缓存下跑不完。
//
// 超时 → 抛异常 → 原来的 `catch { return []; }` 把它吞成「**这个
// worktree 一开始是干净的**」。
//
// 后果：那个本来就脏的规格副本（zelto 自己复制进去的副本，
// agent 一个字节都没碰）被判成「agent 越界写入」→ 整轮作废。
//
// 同一片**重跑一次**，那次 git status 1.2 秒就完了 —— 快照正常，
// 结果那一轮什么毛病都没有。
//
// **同一个工程、同一个文件，两次运行结论相反。**
// 这比「读不到」本身严重：判定的输入不可复现。
//
// 修法：
//   1. 读不到就**抛**，别装作干净；
//   2. 快照在取预约**之前**拍 —— 抛错时不留残局（没人释放的预约
//      会让下一片撞写集冲突，整个队列卡住）；
//   3. 超时从 60 秒放宽到 3 分钟 —— 慢的那一次恰恰是**第一次**，
//      而第一次恰恰决定后面所有审计的基线。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

import { snapshotBaselineChanged } from '../src/cli/commands/runtime-guard.js';

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zelto-d61-'));
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

describe('D-61 基线快照：读不到 ≠ 干净', () => {
  it('目录不存在时**抛错**，不返回空数组', () => {
    const missing = join(tmpdir(), 'zelto-d61-does-not-exist-' + Date.now());
    assert.throws(
      () => snapshotBaselineChanged(missing),
      (err: Error) => {
        assert.match(err.message, /基线快照/, `错误信息要说清是基线快照：${err.message}`);
        assert.match(err.message, /不开工/, '错误信息要说清这一轮不开工');
        return true;
      },
      '读不到基线必须抛错 —— 返回空数组等于说「这个 worktree 一开始是干净的」',
    );
  });

  it('报错信息里带 worktree 路径（人要知道去哪儿查）', () => {
    const missing = join(tmpdir(), 'zelto-d61-missing-path-' + Date.now());
    assert.throws(
      () => snapshotBaselineChanged(missing),
      (err: Error) => {
        assert.ok(
          err.message.includes(missing),
          `错误信息要带 worktree 路径，实际：${err.message}`,
        );
        return true;
      },
    );
  });

  it('真的脏了 → 正常返回脏清单（抛错只针对「读不到」）', () => {
    const dir = makeRepo();
    try {
      mkdirSync(join(dir, 'specs', 'slices'), { recursive: true });
      writeFileSync(join(dir, 'specs', 'slices', 's1.md'), '# spec\n', 'utf-8');

      const baseline = snapshotBaselineChanged(dir);
      assert.ok(
        baseline.includes('specs/slices/s1.md'),
        `脏文件必须在基线里，实际：${JSON.stringify(baseline)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('真的干净 → 返回空数组（这次是「确实干净」，不是「读不到」）', () => {
    const dir = makeRepo();
    try {
      assert.deepEqual(snapshotBaselineChanged(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('D-61 源码级锁定：快照在取预约之前拍', () => {
  it('installRuntimeGuard 里 snapshotBaselineChanged 排在 store.acquire 之前', () => {
    const repoRoot = process.cwd();
    const srcPath = join(repoRoot, 'src', 'cli', 'commands', 'runtime-guard.ts');
    const src = readFileSync(srcPath, 'utf-8');

    const fnIdx = src.indexOf('export async function installRuntimeGuard');
    assert.ok(fnIdx >= 0, '找不到 installRuntimeGuard');

    const body = src.slice(fnIdx, src.indexOf('\n}\n', fnIdx));
    const snapshotIdx = body.indexOf('snapshotBaselineChanged(hookRoot)');
    const acquireIdx = body.indexOf('store.acquire(');

    assert.ok(snapshotIdx >= 0, 'installRuntimeGuard 里应调 snapshotBaselineChanged');
    assert.ok(acquireIdx >= 0, 'installRuntimeGuard 里应调 store.acquire');
    assert.ok(
      snapshotIdx < acquireIdx,
      '快照必须在取预约**之前**拍 —— 否则快照抛错会留下一个没人释放的预约，' +
        '下一片撞写集冲突，整个队列卡住',
    );
  });

  it('超时从 60 秒放宽到 3 分钟（慢的那一次恰恰是第一次）', () => {
    const repoRoot = process.cwd();
    const srcPath = join(repoRoot, 'src', 'cli', 'commands', 'runtime-guard.ts');
    const src = readFileSync(srcPath, 'utf-8');

    const fnIdx = src.indexOf('export function snapshotBaselineChanged');
    assert.ok(fnIdx >= 0, '找不到 snapshotBaselineChanged');
    const body = src.slice(fnIdx, src.indexOf('\n}\n', fnIdx));

    assert.match(
      body,
      /timeout:\s*180_000/,
      '超时必须是 180 秒 —— 冷缓存下第一次 git status 能跑过 60 秒（D-61 实测）',
    );
    assert.doesNotMatch(
      body,
      /timeout:\s*60_000/,
      '60 秒太紧 —— 实测刚好在那撞上超时，把基线静默丢成「干净的」',
    );
  });
});
