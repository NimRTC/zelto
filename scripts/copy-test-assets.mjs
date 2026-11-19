#!/usr/bin/env node
// 把前端静态资源复制进 `dist-test/`（ADR-093）。
//
// `tsconfig.test.json` 会把 `src/` 编译到 `dist-test/src/`，
// 但 `tsc` **不处理非 TS 文件** —— 前端脚本与样式表会缺席，
// 于是任何调用 `renderAppJs()` 的单元测试都会抛「前端资源缺失」。
//
// `scripts/test.mjs`（全量测试）已经在锁内直接调 `copyAssets()`。
// 这个入口是给 `npm run test:unit` 用的 —— 它只跑 `tsc`，不经 `test.mjs`。
//
// 为什么不让 `readAsset()` 回退到仓库根的 `src/`：
// 那样「资源有没有被正确打包」就永远不会被测到 ——
// 本地能跑、发布出去才炸，而炸的现场在用户机器上。

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { copyAssets } from './build-dist.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

try {
  // tsconfig.test.json 的 rootDir 是 `.`，所以资源落在 dist-test/src/ 下
  copyAssets(root, 'dist-test', 'src');
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
