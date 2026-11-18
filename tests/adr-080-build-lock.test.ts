// ADR-080：构建与测试必须共用一把锁 —— 否则验收测试会撞进「dist/ 空窗期」
//
// 病灶（实测 nimrtc-zelto，2026-11-18）：
//
//   `npm run build` 的第一步是 `rmSync(dist)`（D-1：产物目录必须是当前源码的
//   精确映射）。删掉到建好之间有一个**空窗期**，
//   在这期间读 `dist/cli/index.js` 的进程看到的是「不存在」：
//
//     Error: Cannot find module 'D:\MyOpen\Zelto\dist\cli\index.js'
//       code: 'MODULE_NOT_FOUND'
//
//   验收测试跑的是**真实 CLI 进程**（`dist/cli/index.js`）——
//   它落在空窗期里就全红。
//   实测：全量 `npm test` 与一次 `npm run build` 并发时，6 个用例红，
//   全是这一个错；而它们**单独跑是绿的**。
//   判据没错，是被环境打掉的。
//
// 这个文件钉住四件事：
//   1. 锁是**目录**（mkdir 在 Windows 与 POSIX 上都是原子的）；
//   2. 拿不到锁就**等**，不抢、不报错；
//   3. 陈旧锁（进程被强杀留下的）能**自愈**；
//   4. 异常时也放锁 —— 锁漏了会把后面的构建永久卡住。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 锁的实现是 `.mjs`（构建脚本不进 `src/`，也不进 `tsc` 的编译范围）。
//
// 所以不能 `import` 它 —— 编译后的测试在 `dist-test/tests/` 里，
// 相对路径 `../scripts/…` 会指向 `dist-test/scripts/`（不存在）。
// 这里按**仓库根**解析 —— 从当前文件往上找带 `package.json` 的目录。
const repoRoot = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) throw new Error('找不到仓库根（没有 package.json）');
    dir = up;
  }
})();

const lockModulePath = join(repoRoot, 'scripts', 'build-lock.mjs');

type LockApi = typeof import('../scripts/build-lock.mjs');

// 动态 import —— 路径是运行时算出来的，TS 没法静态解析
const { acquireBuildLock, releaseBuildLock, withBuildLock, LOCK_NAME } =
  (await import(pathToFileURL(lockModulePath).href)) as LockApi;

describe('ADR-080 · 构建锁', () => {
  it('第一次拿锁成功，锁是一个目录', () => {
    const root = mkdtempSync(join(tmpdir(), 'zelto-lock-'));
    try {
      const lock = acquireBuildLock(root);
      assert.ok(existsSync(lock), '锁应该是目录');
      assert.ok(lock.endsWith(LOCK_NAME));
      assert.ok(statSync(lock).isDirectory(), '锁必须是目录（mkdir 才有原子性）');
      releaseBuildLock(lock);
      assert.ok(!existsSync(lock), '放锁后锁目录应该消失');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('withBuildLock 在异常时也放锁（不留死锁）', () => {
    const root = mkdtempSync(join(tmpdir(), 'zelto-lock-'));
    try {
      assert.throws(() =>
        withBuildLock(root, () => {
          throw new Error('boom');
        }),
      );
      // 异常之后必须能再拿到锁 —— 拿不到就说明锁漏了
      const lock = acquireBuildLock(root, 2000);
      releaseBuildLock(lock);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('陈旧锁能自愈（进程被强杀留下的锁不会永久卡住）', () => {
    const root = mkdtempSync(join(tmpdir(), 'zelto-lock-'));
    try {
      // 造一个「陈旧」的锁：把 mtime 拨到一小时前
      const stale = join(root, LOCK_NAME);
      mkdirSync(stale);
      const oldSec = (Date.now() - 60 * 60 * 1000) / 1000;
      utimesSync(stale, oldSec, oldSec);

      // 陈旧锁不该把后来的构建永久挡住
      const lock = acquireBuildLock(root, 5000);
      assert.ok(existsSync(lock));
      releaseBuildLock(lock);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('锁被占着时，后来者等不到就**明确报错**（而不是无限等）', () => {
    const root = mkdtempSync(join(tmpdir(), 'zelto-lock-'));
    try {
      const first = acquireBuildLock(root);
      // 第二个拿锁者会**等**到超时 —— 超时要给出可执行的说明
      assert.throws(
        () => acquireBuildLock(root, 300),
        /构建锁|锁/i,
        '拿不到锁必须说清楚为什么、怎么办',
      );
      releaseBuildLock(first);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('锁目录的 mtime 是判「陈旧」的依据', () => {
    const root = mkdtempSync(join(tmpdir(), 'zelto-lock-'));
    try {
      const lock = acquireBuildLock(root);
      const st = statSync(lock);
      assert.ok(Date.now() - st.mtimeMs < 60_000, '刚拿到的锁不该是陈旧的');
      releaseBuildLock(lock);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
