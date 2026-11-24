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
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withBuildLock } from './build-lock.mjs';
import { buildDist, copyAssets } from './build-dist.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 收集 `tests/acceptance/**` 下用 `.cjs` 写的验收测试。
 *
 * 为什么单独收集：`.cjs` 不在 `tsconfig.test.json` 的 include 里，
 * 所以它们**不在 `dist-test/`** —— 而 `npm test` 的 glob 只扫 `dist-test/`。
 * 结果：这些验收测试**从来没被跑过**。
 *
 * 为什么原地跑（而不是复制到 `dist-test/`）：它们用 `__dirname` 定位
 * `dist/` 与仓库根，搬了位置相对路径就全错。
 */
function collectCjsAcceptanceTests(repoRoot) {
  const results = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.test.cjs')) {
        results.push(full);
      }
    }
  };
  walk(join(repoRoot, 'tests', 'acceptance'));
  return results.sort();
}

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

  // 4.5 跑 `.cjs` 写的验收测试（**原来一个都没跑过**）
  //
  // ── 病灶 ──────────────────────────────────────────────────────────
  //
  //   验收测试分两种写法：
  //     - `.ts` 写的 → `tsc` 编译进 `dist-test/tests/**` → 被上面那条 glob 覆盖
  //     - `.cjs` 写的 → **不在 `dist-test/` 里** → **从来没被跑过**
  //
  //   实测（2026-11-24）：源目录 41 个验收测试，`dist-test` 里只有 29 个。
  //   缺席的 14 个全在 `v1-*` / `v2-*` / `v3-*` 目录里 ——
  //   包含哈希链、audit verify、写保护 e2e、CI pipeline、help 系统。
  //
  //   为什么没被编译：`tsconfig.test.json` 的 include 是 `tests/**/*.ts`，
  //   `.cjs` 不在其中；而 `copyAssets` 只复制前端资源，不复制 `.cjs`。
  //
  //   后果：「CI 绿灯」这件事**没覆盖到这些验收标准**。
  //   14 个里有 4 条是坏的（从没跑过，所以坏了没人知道）——
  //   **绿灯不代表验过，只代表没被验。**
  //
  // ── 为什么原地跑而不是复制进 dist-test ────────────────────────────
  //
  //   这些 `.cjs` 用 `require` + `__dirname` 定位 `dist/` 与仓库根，
  //   **设计就是原地运行**（`__dirname` 变了，相对路径就全错）。
  //   所以正确做法是**在源目录跑它们**，而不是搬到 `dist-test/`。
  //
  // ── 为什么不是「全部搬进 dist-test」─────────────────────────────
  //
  //   `.ts` 写的验收测试**需要**编译（它们 import `src/` 的 TS 模块）。
  //   `.cjs` 写的**不需要**（它们 require `dist/` 的 JS 产物）。
  //   两种写法各有各的定位方式，混在一起搬会破坏其中一种。
  //
  // ── 与 `test:quick` 的关系 ────────────────────────────────────────
  //
  //   `test:quick`（Windows CI 跑的那个）**仍然不跑这 14 个** ——
  //   它要快。Linux CI 跑的是 `pnpm test`（全量），会跑到。
  //   这是刻意的：Windows job 的定位是「快 + 跨平台坑」，
  //   不是「全量验收」。
  const cjsAcceptance = collectCjsAcceptanceTests(root);
  if (cjsAcceptance.length > 0) {
    console.log(
      `[zelto] 跑 ${cjsAcceptance.length} 个 .cjs 验收测试（源目录，原地运行）`,
    );
    execFileSync(process.execPath, ['--test', ...cjsAcceptance], {
      cwd: root,
      stdio: 'inherit',
    });
  }
  });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
