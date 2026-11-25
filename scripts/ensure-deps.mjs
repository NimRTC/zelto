#!/usr/bin/env node
// 依赖自检与自愈 —— 并发 `pnpm install` 弄坏 node_modules 时的兜底
//
// ── 病灶（2026-11-25 实测，本机连踩三次）────────────────────────────────
//
//   `npm test` / `npm run build` 突然报：
//
//     error TS2307: Cannot find module '@anthropic-ai/claude-agent-sdk'
//     or its corresponding type declarations.
//
//   而 `node_modules/@anthropic-ai/claude-agent-sdk/` **目录还在** ——
//   它是一个 junction，指向 `.pnpm/` 下的实体目录。
//   真相：那个**实体目录被删了**，junction 变成悬空指针。
//   根因是**并发 `pnpm install`**：
//     pnpm 的安装流程是「删旧目录 → 从 store 重建」，
//     两个进程同时跑时，一个删掉了另一个正要用的目录；
//     而另一个进程还占着文件句柄 → `ERR_PNPM_EBUSY` →
//     它中途放弃，留下**半成品**：junction 重建了，实体目录没重建。
//   后果的形状很恶劣：
//     **编译报错完全不提「依赖坏了」**，只说「找不到模块」——
//     人第一反应是「代码写错了」，而代码没问题，是环境坏了。
//
// ── 为什么不能靠「重跑一次 pnpm install」解决 ───────────────────────────
//
// 能解决，但要**人记得**。而这个坑的隐蔽性正是问题所在：
// 报错信息不指向真正的原因，人得自己想到「是不是依赖坏了」。
// 所以把自愈放在**构建之前**：
//   检出悬空依赖 → 自动 `pnpm install --frozen-lockfile` → 重验。
// 代价是构建前多一次极快的检查（几毫秒），
// 收益是「依赖坏了」这个事故**不再需要人介入**。
//
// ── 关键判据：Windows 上必须用 `statSync` 穿透 junction ────────────────
//
//   实测（Windows / Node 24，pnpm 的 junction 布局）：
//
//     lstatSync(junction).isSymbolicLink() → true
//     lstatSync(junction).isDirectory()    → **false**   ← 陷阱
//     statSync(junction).isDirectory()     → true
//
//   所以判「这是不是一个活着的目录」必须用 `statSync`（它穿透链接）。
//   第一版判据混用了 `lstatSync(...).isDirectory()`，于是**健康的**
//   junction 全被判成坏的，自愈变成「每次都重装一遍」——
//   这正是本条要修的那种「判据说谎」。
//
// ── 为什么只查「悬空 junction」，不查「包版本对不对」────────────────────
//
// 只查**结构上确凿坏了**的：
//   - junction 的目标不存在（悬空）
//   - 目标存在但缺 `package.json`（半成品）
// 不查「版本对不对 lockfile」—— 那是 `pnpm install` 自己的职责，
// 越界检查会把它变成第二套依赖解析器。
//
// C3：纯判定 —— 只读文件、不触网、不调模型
// C6：scripts/ 不属于 core/，但本脚本同样零第三方依赖（只用 node: 内置）

import { existsSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nodeModules = join(root, 'node_modules');

/**
 * 一个包目录是不是「坏了」。
 *
 * 坏的两种形态：
 *   1. **悬空 junction** —— 目标不存在（实体目录被并发 install 删了）
 *   2. **半成品** —— 目标存在，但里面没有 `package.json`
 *
 * 返回 `null` 表示好，返回一句人话表示坏在哪。
 */
function inspectPackage(pkgDir) {
  // 主判据：这个包目录**现在**是不是一个能打开的目录。
  //
  // `statSync` 而不是 `lstatSync` —— 它穿透 junction（见文件头）。
  let isLiveDir = false;
  try {
    isLiveDir = statSync(pkgDir).isDirectory();
  } catch {
    isLiveDir = false; // 不存在，或悬空 junction（目标没了）
  }
  if (isLiveDir && existsSync(join(pkgDir, 'package.json'))) {
    return null; // 好
  }

  // 走到这里 = 坏的。现在**尽量说准是哪一种坏**。
  let target = null;
  try {
    target = readlinkSync(pkgDir);
  } catch {
    target = null; // 不是链接（或链接已整个不存在，读不出来）
  }

  if (target) {
    const resolved = resolve(dirname(pkgDir), target);
    let targetIsDir = false;
    try {
      targetIsDir = statSync(resolved).isDirectory();
    } catch {
      targetIsDir = false;
    }
    if (!existsSync(resolved)) {
      return `链接指向的目录不存在（悬空链接，实体目录被删了）：${target}`;
    }
    if (!targetIsDir) {
      return `链接指向的不是目录：${target}`;
    }
    if (!existsSync(join(resolved, 'package.json'))) {
      return `链接目标里没有 package.json：${target}`;
    }
    // 目标其实是好的，但这个包目录仍然打不开 —— Windows 上的
    // 「目标完好、链接不可用」：重装能修，所以仍算坏。
    return `链接目标完好但链接不可用（目标完好却读不到包）：${target}`;
  }

  if (!existsSync(pkgDir)) {
    return '包目录不存在（既不是实体目录也不是链接）';
  }
  return '目录里没有 package.json';
}

/**
 * 判据的对外出口 —— 供测试直接调用。
 * 为什么导出：`inspectPackage` 是**纯判定**（只读文件、不触网），
 * 而「自动重装」不是。测试要能钉住判据而不去动真仓库的 node_modules。
 */
export function inspectPackageForTest(pkgDir) {
  return inspectPackage(pkgDir);
}

/**
 * 扫出所有坏了的包。
 * 只看**声明过的依赖**（`dependencies` + `devDependencies`）——
 * 不扫整个 `node_modules`（那是 pnpm 的内部结构，扫了也不准）。
 */
function findBrokenPackages() {
  let pkg;
  try {
    pkg = JSON.parse(
      // 读时容错：Windows 上 BOM 会让 JSON.parse 直接抛
      readFileSync(join(root, 'package.json'), 'utf-8').replace(/^\uFEFF/, ''),
    );
  } catch {
    return []; // package.json 都读不出来 —— 交给别的环节报错
  }

  const declared = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const broken = [];
  for (const name of Object.keys(declared).sort()) {
    // 只查**有作用域**的包（@scope/name）——
    // 无作用域的顶层包在 pnpm 下是直接放在 node_modules/ 里的实体目录，
    // 不走 junction，检查它没意义。
    if (!name.startsWith('@')) continue;
    const pkgDir = join(nodeModules, ...name.split('/'));
    const reason = inspectPackage(pkgDir);
    if (reason) broken.push({ name, reason });
  }
  return broken;
}

/**
 * 找到「不经 shell 就能跑的 pnpm 入口」。
 *
 * 为什么不用 `shell: true`：
 *   Node 会发 `DEP0190` 警告（参数不做转义，有注入风险）——
 *   而且这个仓库的依赖名/参数都是固定的，没必要为省事引入 shell 层。
 *   这条告警听起来像「可疑输出」，能不给就不给。
 *   （注：正常路径 —— corepack 的 pnpm.js —— 不会走到 `shell` 兜底，
 *   2026-11-25 带 `--trace-deprecation` 跑完整构建实测未出现 DEP0190；
 *   只有「依赖损坏 + 找不到 corepack」的罕见组合才可能触发。）
 *
 * 为什么不用直接 spawn `pnpm.cmd`：
 *   Windows 上 `spawnSync` 对 `.cmd` 不带 `shell` 会 `EINVAL`。
 *
 * 首选是 **corepack 的 pnpm.js**（`package.json` 里钉了
 * `packageManager: pnpm@9.12.0`，corepack 正是为此准备的）：
 * 它是纯 JS，直接 `node <pnpm.js> <args>` 跑，**不经过 shell**。
 *
 * 找不到 corepack 就退回 `shell: true`（有警告，但能跑）。
 * 兜底必须留着 —— 有一些环境（精简容器、CI 镜像）不装 corepack。
 */
function resolvePnpmCommand() {
  const candidates = [
    // corepack 自带 pnpm shim（Windows / Linux 常见位置）
    join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'pnpm.js'),
    // corepack 的 dist 目录（随 node 安装走）
    join(process.execPath, '..', 'node_modules', 'corepack', 'dist', 'pnpm.js'),
    '/usr/local/lib/node_modules/corepack/dist/pnpm.js',
    '/usr/lib/node_modules/corepack/dist/pnpm.js',
  ];
  for (const p of candidates) {
    if (existsSync(p)) return { cmd: process.execPath, prefix: [p] };
  }

  // 退一步：直接找 pnpm 本体
  if (process.platform !== 'win32') return { cmd: 'pnpm', prefix: [] };
  for (const p of [
    join(dirname(process.execPath), 'pnpm.cmd'),
    join(dirname(process.execPath), 'pnpm.exe'),
  ]) {
    if (existsSync(p)) return { cmd: p, prefix: [], shell: true };
  }
  return { cmd: 'pnpm', prefix: [], shell: true };
}

/**
 * 问 npm 的 `run` 命令它还认哪些脚本名 —— 自愈之后要跑的那几个都在这儿。
 * 纯读 `package.json`，不触网。
 */
function readNpmScripts() {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8').replace(/^\uFEFF/, ''));
    return Object.keys(pkg.scripts ?? {});
  } catch {
    return [];
  }
}

/**
 * 跑一次 pnpm 命令，返回退出状态与合并后的输出。
 * 用 `--frozen-lockfile`：lockfile 不该被安装过程改动 ——
 * 依赖坏了是**环境**问题，不该顺手改 lockfile。
 */
function runPnpm(args) {
  const { cmd, prefix, shell } = resolvePnpmCommand();
  const result = spawnSync(cmd, [...prefix, ...args], {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(shell ? { shell: true } : {}),
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

export { readNpmScripts, runPnpm };

/**
 * 入口：检查依赖 → 坏了就自愈 → 返回「可以继续构建了吗」。
 *
 * 返回 `{ ok: true }` 表示依赖是好的（或已修好）。
 * 返回 `{ ok: false, reason }` 表示修不好 —— 调用方应当**中止**，
 * 因为在依赖坏的状态下继续构建，报错会指向错误的地方。
 */
export function ensureDependenciesHealthy() {
  if (!existsSync(nodeModules)) {
    return { ok: true, skipped: true, reason: '没有 node_modules —— 首次安装，不在这里管' };
  }

  const broken = findBrokenPackages();
  if (broken.length === 0) {
    return { ok: true, repaired: [] };
  }

  console.error('[deps] 检测到依赖损坏（通常是并发 `pnpm install` 留下的半成品）：');
  for (const b of broken) {
    console.error(`[deps]   ${b.name}: ${b.reason}`);
  }
  console.error('[deps] 正在自动重装（pnpm install --frozen-lockfile）…');

  const result = runPnpm(['install', '--frozen-lockfile']);
  if (!result.ok) {
    return {
      ok: false,
      reason:
        `自动重装失败（退出码 ${result.status}）。\n` +
        `请手动跑一次 \`pnpm install --frozen-lockfile\`。\n` +
        `原始输出：\n${result.output.slice(-2000)}`,
    };
  }

  // 重装后再验一次 —— 确认真的修好了，而不是「跑完就好了」的错觉
  const stillBroken = findBrokenPackages();
  if (stillBroken.length > 0) {
    return {
      ok: false,
      reason:
        `重装后依赖仍然损坏：${stillBroken.map((b) => `${b.name}（${b.reason}）`).join('；')}\n` +
        `这通常意味着有**另一个进程正在跑 pnpm install** —— 两个 install 互相踩。\n` +
        `请等那个进程结束后再跑一次。`,
    };
  }

  console.error(`[deps] 依赖已修好（${broken.length} 个包重装完成）。`);
  return { ok: true, repaired: broken.map((b) => b.name) };
}

// 直接运行时：跑一次检查并报结果（供人手动排查用）
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const result = ensureDependenciesHealthy();
  if (!result.ok) {
    console.error(`[deps] ${result.reason}`);
    process.exit(1);
  }
  console.error('[deps] 依赖完好。');
}
