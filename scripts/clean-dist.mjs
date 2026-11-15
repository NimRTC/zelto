#!/usr/bin/env node
// 清理**构建产物目录** `dist/` —— 跨平台。
//
// 为什么构建前要清（D-1）：
//
//   `tsc` **不删旧产物**。从别的分支构建过的 `dist/` 会一直留在磁盘上：
//   源文件被删了 / 改名了，但编译出来的 `.js` 还在。
//
//   实测后果（nimrtc-zelto 实战演练）：`dist/` 里躺着
//   `src/cli/commands/agent-preflight.ts` 的编译产物，而 `main` 分支的
//   `src/` 里根本没有这个文件 —— 它只存在于备份分支。
//   `zelto run` 于是直接崩在 agent 预检：
//
//     ❌ Agent 预检未通过：agent 预检失败：
//        Cannot read properties of undefined (reading 'trim')
//        命令：undefined
//
//   崩的是一个**这个分支上根本不该存在的模块** —— 而且从错误信息里
//   完全看不出「这是旧产物」这回事。查源码找不到问题，因为源码是对的。
//
//   所以构建前必须清 `dist/`：产物目录应该是**当前源码的精确映射**，
//   不是一个跨分支累积的垃圾场。
//
// 只删 `dist/`，不删 `dist-test/` —— 后者是单元测试的产物，
// 与 CLI 二进制无关，清它只会让 `npm test` 多编译一次。

import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

rmSync(join(root, 'dist'), { recursive: true, force: true });
console.log('removed dist/');
