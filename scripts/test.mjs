#!/usr/bin/env node
// 跑测试 —— 在**构建锁**内。
//
// ── 为什么测试也要拿锁（ADR-080）──────────────────────────────────────
//
//   验收测试（`tests/acceptance/**`）跑的是**真实 CLI 进程**
//   （`dist/cli/index.js`）。而 `npm run build` 会**先删 `dist/` 再重建**。
//
//   删掉到建好之间的空窗期里，验收测试看到的是「不存在」：
//
//     Error: Cannot find module 'D:\MyOpen\Zelto\dist\cli\index.js'
//       code: 'MODULE_NOT_FOUND'
//
//   实测（2026-11-18）：全量 `npm test` 与一次 `npm run build` 并发时，
//   6 个验收用例红，全是这一个错；而它们**单独跑是绿的**。
//   判据没错，是被环境打掉的。
//
//   修法：构建与测试**共用一把锁** —— 它们不重叠。
//   锁的语义见 `build-lock.mjs`。
//
// ── 顺便：`npm test` 自己构建 `dist/` ─────────────────────────────────
//
//   验收测试测的是 `dist/cli/index.js`。如果 `npm test` **不构建**它，
//   那么「绿灯」依赖一个**它自己不产出的东西**：
//
//     1. 改了 `src/cli/commands/version-ship.ts`；
//     2. 忘了 `npm run build`；
//     3. `npm test` → `dist/` 里还是**上一次的旧代码**；
//     4. 验收测试跑旧二进制 → **绿**；
//     5. 你以为改动是对的。
//
//   **验收测试测的不是你改的代码，而你还是绿的** ——
//   这比红更坏：红会告诉你「有问题」，绿告诉你「没问题」。
//
//   AGENTS.md 早就写着「测试前必须先构建」，但那只是**文档里的叮嘱**，
//   工具**不强制**它。本脚本把那句话变成**工具行为**。
//
// 单元测试跑的是 `dist-test/`（本仓库自己的产物），不依赖 `dist/` ——
// 但它们与验收测试跑在同一个 `node --test` 进程里，
// 所以整个测试跑在锁内最简单。

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withBuildLock } from './build-lock.mjs';
import { buildDist, copyAssets } from './build-dist.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// 与 `build.mjs` 同理：**不要在这里 `process.exit()`** ——
// 那会跳过 `withBuildLock` 的 `finally`，把锁留在磁盘上。
// 抛出去让锁被正常释放，退出码自然非零。
try {
  withBuildLock(root, () => {
  // 1. 编码检查（先于一切）
  execFileSync(process.execPath, [join(root, 'scripts', 'check-encoding.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });

  // 2. 构建 `dist/` —— 验收测试要跑它
  //
  // 注意：**直接调**，不 fork —— fork 会去拿同一把锁 → **死锁**。
  buildDist(root);

  // 3. 编译单元测试产物
  const tscBin = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  execFileSync(process.execPath, [tscBin, '-p', 'tsconfig.test.json'], {
    cwd: root,
    stdio: 'inherit',
  });

  // 3.5 复制静态资源到 dist-test（ADR-093）
  //
  // 单元测试跑的是 `dist-test/src/...`，而 `tsc` 不复制非 TS 文件。
  // `tsconfig.test.json` 的 rootDir 是 `.`，所以资源要落在 `dist-test/src/` 下。
  copyAssets(root, 'dist-test', 'src');

  // 4. 跑测试
  execFileSync(
    process.execPath,
    ['--test', 'dist-test/tests/**/*.test.js'],
    { cwd: root, stdio: 'inherit' },
  );
  });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
