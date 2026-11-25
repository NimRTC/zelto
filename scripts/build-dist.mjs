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
import { cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { ensureDependenciesHealthy } from './ensure-deps.mjs';

/**
 * 构建 `dist/`。
 *
 * **不自己拿锁** —— 锁由调用方拿。
 * `test.mjs` 在锁内**直接调**本函数（不是 fork 进程）——
 * 否则会**死锁**（同一把锁，进程内等自己）。
 */
export function buildDist(root) {
  // 0. 依赖自检与自愈
  //
  // 为什么放在**编译之前**：
  //   依赖坏了的时候，`tsc` 报的是 `Cannot find module '@anthropic-ai/...'`
  //   —— 那句话**完全不提「依赖坏了」**，人第一反应是「代码写错了」。
  //   而代码没问题，是环境坏了（并发 `pnpm install` 留下的半成品）。
  //
  //   详见 `scripts/ensure-deps.mjs` 的文件头。
  //
  // 这里**不自己拿锁**的原因同下：锁由调用方拿。
  const deps = ensureDependenciesHealthy();
  if (!deps.ok) {
    // 抛出去，不要 process.exit() —— 见下面 catch 块的说明。
    throw new Error(`依赖检查未通过：${deps.reason}`);
  }

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
  } catch (err) {
    // **抛出去，不要 `process.exit(1)`**。
    //
    // `process.exit()` **不会跑 `finally`** —— 而调用方 `withBuildLock`
    // 正是靠 `finally` 放锁的。所以在这里 exit 的话，
    // `.build-lock/` 目录会**留在磁盘上**，下一次构建就得等它：
    //
    //   - 锁没超过 10 分钟 → 干等（每 200ms 轮询一次）
    //   - 超过 10 分钟 → 走「陈旧锁自愈」，白等 10 分钟
    //
    // 实测（2026-11-19）：一次编译失败之后，紧接着的 `npm run build`
    // 挂了 2 分半没动 —— 人看到的现象是「构建卡住了」，
    // 而病根是上一次失败留下的锁。
    //
    // 抛异常让 `finally` 正常跑，锁被正常释放；
    // 调用方（`build.mjs` / `test.mjs`）自然以非零码退出。
    console.error('compile failed — dist/ is now incomplete (build it again)');
    throw err;
  }

  // 3. 复制非 TS 静态资源（ADR-093）
  //
  // `tsc` 只处理 `.ts` —— 前端脚本与样式表是纯资源，不会被编译，
  // 也不会被自动复制。漏了这步的后果不是构建失败，而是**运行时**
  // 才炸（`readAsset()` 抛「前端资源缺失」），且只在打开 `zelto web` 时炸。
  // 所以复制必须放在构建里，和编译同一次、同一把锁。
  copyAssets(root, 'dist');

  console.log('built dist/');
}

/**
 * 前端静态资源目录（相对 `src/` / `tests/`）→ 编译后的同位置。
 *
 * 目前只有 `adapters/web/frontend/`。写成表而不是单条，是因为
 * 第二个资源目录出现时不该再改构建结构。
 *
 * **导出**：`tsconfig.test.json` 把 `src/` 和 `tests/` 平铺到 `dist-test/` 下
 * （`rootDir: "."`），所以单元测试跑的是 `dist-test/src/adapters/web/...` ——
 * 那里同样需要这些资源，否则测试里调 `renderAppJs()` 会抛「前端资源缺失」。
 * 资源只属于 `src/`，`tests/` 没有资源目录，所以 `dist-test` 的复制
 * 源永远是 `src/`，只是目标跟着 `outDir` 走。
 */
const ASSET_DIRS = ['adapters/web/frontend'];

/**
 * 把静态资源从 `src/` 复制到某个产物目录下。
 *
 * @param root 仓库根
 * @param outDir 产物目录名（`dist` 或 `dist-test`）
 * @param outPrefix 产物目录内部的前缀 —— `tsc -p tsconfig.json` 的 rootDir 是
 *   `src`，所以资源落在 `dist/<rel>`；而 `tsconfig.test.json` 的 rootDir 是 `.`，
 *   资源要落在 `dist-test/src/<rel>`。这个差异由调用方说清楚，不猜。
 */
export function copyAssets(root, outDir, outPrefix = '') {
  for (const rel of ASSET_DIRS) {
    const from = join(root, 'src', rel);
    const to = join(root, outDir, outPrefix, rel);
    try {
      cpSync(from, to, { recursive: true });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `复制静态资源失败：${from} → ${to}\n` +
          `缺了它，zelto web 启动后会读不到前端脚本。原始错误：${reason}`,
      );
    }
  }
}
