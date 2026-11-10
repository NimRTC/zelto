#!/usr/bin/env node
// 清理构建产物 —— 跨平台。
//
// 为什么不用 `rm -rf dist dist-test`：那条在 Windows 的 cmd 里不存在
// （`rm` 不是内部命令），而 `prepublishOnly` 会跑 `pnpm clean` ——
// 于是 npm publish 在 Windows 上直接失败。发布通道必须是跨平台的，
// 所以这里改用 Node 内置的 fs.rmSync（Node ≥ 14.14）。

import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

for (const dir of ['dist', 'dist-test']) {
  rmSync(join(root, dir), { recursive: true, force: true });
  console.log(`removed ${dir}/`);
}
