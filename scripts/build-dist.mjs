#!/usr/bin/env node
// 构建 `dist/` 的**实现**（被 `build.mjs` 与 `test.mjs` 共用）。
//
// ── 为什么构建前要清（D-1）─────────────────────────────────────────────
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
// ── 但「先删再建」有空窗期（ADR-080）──────────────────────────────────
//
//   `dist/` 被删掉到新的 `dist/` 建好之间，**有一个空窗期**。
//   在这个空窗期里，任何读 `dist/` 的进程看到的是**不存在**：
//
//     Error: Cannot find module 'D:\MyOpen\Zelto\dist\cli\index.js'
//       code: 'MODULE_NOT_FOUND'
//
//   验收测试（`tests/acceptance/**`）跑的是**真实 CLI 进程**
//   （`dist/cli/index.js`）—— 它落在空窗期里就全红。
//   实测：全量 `npm test` 与一次 `npm run build` 并发时，
//   6 个验收用例红，全是这一个错；而它们**单独跑是绿的**。
//   判据没错，是被环境打掉的。
//
//   本来想用「编译到临时目录 → 一次性 rename 换名」来消除空窗，
//   但实测在 Windows 上**行不通**（`EPERM` —— 目录 rename 要求没有进程
//   持有该目录的句柄，而文件监视器随时可能持有；失败还是偶发的）。
//   那是**环境依赖的判据**，不能拿它当保证。
//
//   改用**互斥锁**：构建与「读 dist/ 的测试」不重叠（见 `build-lock.mjs`）。
//
// 只动 `dist/`，不动 `dist-test/` —— 后者是单元测试的产物，
// 与 CLI 二进制无关，清它只会让 `npm test` 多编译一次。

import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 构建 `dist/`。
 *
 * **不自己拿锁** —— 锁由调用方拿。
 * `test.mjs` 在锁内**直接调**本函数（不是 fork 进程）——
 * 否则会**死锁**（同一把锁，进程内等自己）。
 */
export function buildDist(root) {
  // 1. 清旧产物（D-1：产物目录必须是当前源码的精确映射）
  rmSync(join(root, 'dist'), { recursive: true, force: true });

  // 2. 编译
  process.stdout.write('compiling dist/ …\n');
  try {
    // 直接调 `tsc`（不是 `npx tsc`）——
    // `npx` 在 Windows 上要过 cmd.exe，多一层壳就多一层不确定性
    // （实测：`execFileSync('npx', …, {shell:true})` 有时不产出任何文件，也不报错）。
    const tscBin = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
    execFileSync(process.execPath, [tscBin, '-p', 'tsconfig.json'], {
      cwd: root,
      stdio: 'inherit',
    });
  } catch {
    console.error('compile failed — dist/ is now incomplete (build it again)');
    process.exit(1);
  }

  console.log('built dist/');
}
