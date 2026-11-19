#!/usr/bin/env node
// 构建 `dist/` —— 命令行入口。
//
// 实现见 `build-dist.mjs`；为什么要这么做见那里的注释（D-1 / ADR-080）。
//
// 这里只做两件事：
//   1. 拿**构建锁**（与 `npm test` 共用同一把 —— 见 `build-lock.mjs`）；
//   2. 调 `buildDist()`。

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withBuildLock } from './build-lock.mjs';
import { buildDist } from './build-dist.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// 失败要以**非零码**退出，但**不能**在这里 `process.exit()` ——
// 那会跳过 `withBuildLock` 的 `finally`，把锁留在磁盘上
// （细节见 `build-dist.mjs` 里 `buildDist` 的 catch 块）。
try {
  withBuildLock(root, () => buildDist(root));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
