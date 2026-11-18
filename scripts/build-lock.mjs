#!/usr/bin/env node
// 构建/测试的**互斥锁** —— 让「写 dist/」与「读 dist/」不重叠。
//
// ── 为什么需要它（ADR-080）──────────────────────────────────────────
//
//   `npm run build` 会**先删 `dist/` 再重建**（D-1：产物目录必须是当前源码的
//   精确映射）。删掉到建好之间有一个**空窗期**。
//
//   在这个空窗期里，任何读 `dist/` 的进程看到的是「不存在」：
//
//     Error: Cannot find module 'D:\MyOpen\Zelto\dist\cli\index.js'
//       code: 'MODULE_NOT_FOUND'
//
//   验收测试（`tests/acceptance/**`）跑的是**真实 CLI 进程**
//   （`dist/cli/index.js`）—— 它落在空窗期里就全红。
//   实测（2026-11-18）：全量 `npm test` 与一次 `npm run build` 并发时，
//   6 个验收用例红，全是这一个错；而它们**单独跑是绿的**。
//   判据没错，是被环境打掉的。
//
// ── 为什么不用「目录原子替换」（rename）──────────────────────────────
//
//   本来想用「编译到 .dist-new/ → 一次性 rename 换名」来消除空窗。
//   实测在 Windows 上**行不通**：
//
//     Error: EPERM: operation not permitted, rename 'D:\MyOpen\Zelto\dist'
//
//   目录 rename 在 Windows 上要求没有进程持有该目录（或其子目录）的句柄 ——
//   文件监视器（编辑器 / Cursor 的索引器）随时可能持有。
//   失败还是**偶发**的：换个时刻跑就成功了。
//
//   那是**环境依赖的判据** —— 不能拿它当保证。
//   所以换一条路：**用锁把「写」与「读」彻底分开**。
//
// ── 本模块的语义 ─────────────────────────────────────────────────────
//
//   锁是**目录**（`mkdir` 在 Windows 与 POSIX 上都是原子的：
//   已存在时抛 EEXIST）。
//   拿不到锁就**等** —— 而不是抢、也不是报错。
//
//   **陈旧锁要能自愈**：进程被强杀时锁目录会留下。
//   超过 10 分钟的锁视为陈旧，直接接管。
//   （超时阈值要**大于一次完整构建**的时间 —— 实测构建约 15 秒。）

import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const LOCK_NAME = '.build-lock';

/** 等待（同步）—— 用 Atomics.wait，不占事件循环 */
function sleepSync(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

/**
 * 拿构建锁。拿不到就等。
 *
 * @param root 仓库根目录
 * @param timeoutMs 等不到锁就放弃的上限
 * @returns 锁目录路径（release 时传回去）
 */
export function acquireBuildLock(root, timeoutMs = 15 * 60 * 1000) {
  const lockDir = join(root, LOCK_NAME);
  const staleMs = 10 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      mkdirSync(lockDir);
      return lockDir;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }

    // 陈旧锁自愈
    try {
      const age = Date.now() - statSync(lockDir).mtimeMs;
      if (age > staleMs) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
    } catch {
      continue; // 锁刚被别人释放 —— 再试一次
    }

    if (Date.now() > deadline) {
      throw new Error(
        `构建锁等不到（>${Math.round(timeoutMs / 1000)}s）。` +
          `若确认没有构建在跑，删掉 ${lockDir} 再试。`,
      );
    }
    sleepSync(200);
  }
}

/** 放锁 */
export function releaseBuildLock(lockDir) {
  rmSync(lockDir, { recursive: true, force: true });
}

/**
 * 在锁内跑一段逻辑。
 *
 * 为什么要它：**读 `dist/` 的人**（验收测试）与**写 `dist/` 的人**（构建）
 * 必须不重叠 —— 否则读到的是「删了一半的目录」。
 */
export function withBuildLock(root, fn, timeoutMs) {
  const lock = acquireBuildLock(root, timeoutMs);
  try {
    return fn();
  } finally {
    releaseBuildLock(lock);
  }
}

export { LOCK_NAME };
