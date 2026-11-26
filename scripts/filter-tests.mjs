#!/usr/bin/env node
// Test runner — filters test files by category and spawns node --test.
//
// Modes:
//   (default)        fast tests only — excludes slow ones (spawn, SDK, e2e)
//   --all            every test except the hanging ones (used by `pnpm test`)
//   --list-slow      print the slow test files and exit
//   --list-hanging   print the hanging test files and exit
//
// ── 为什么**不**用 `--test-force-exit`（2026-11-27，ZD-063）────────────
//
// 原来这里恒定传 `--test-force-exit`（理由：没有凭据时 agent 适配器会留下
// 打开的句柄，测试进程永远不退出）。
//
// 但那个理由在 Windows + Node>=23 上**代价更大**：
// `--test-force-exit` 会在测试跑完后立刻 `process.exit()`，
// 而此时 undici 的连接池里可能还有 keep-alive 的 socket 没关。
// Node 调 `uv_async_send` 去通知一个已被 `uv_close` 标记
// `UV_HANDLE_CLOSING` 的句柄 → libuv 直接断言崩溃：
//
//     Assertion failed: !(handle->flags & UV_HANDLE_CLOSING),
//     file src\win\async.c, line 94
//
// 后果是**整个测试文件被判失败**，哪怕里面每个用例都通过了 ——
// 「测试红了，但没有一个断言不通过」。
//
// 这是 Node 自身的 bug，不是我们的：
//   - nodejs/node#56645（Windows + Node 23.x 起必现）
//   - nodejs/node#61999 已修，但**还没进任何已发布版本**
//
// 复现条件（实测，本机 Node 24.16.0）：
//   1 次 fetch → 不崩；**2 次及以上 fetch** → 崩
// 与 server 收没关无关，与 git 子进程无关 —— 就是 undici 的连接池。
//
// 修法：**让事件循环自然排空**，不硬退。
// 兜底用 `--test-timeout`（单个用例超时即失败），
// 这样「某个测试真的挂住」会被明确报成超时，而不是让整个进程吊死。
//
// 为什么 CI（Node 22）不受影响：那个 bug 从 Node 23 才开始有。
// 但我们不按版本分支处理 —— 判据统一：**永远不硬退**。


import { readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SLOW_PATTERNS = [
  'executor-adapter',
  'claude-agent-sdk-adapter',
  'ai-pipeline-cli',
  'agent-execution',
  'auto-flow',
  'hook-executable',
  'spec-md-executor-e2e',
  'abandon-command',
  'clarify-command',
  'config-loading',
  'create-command',
  'event-emission',
  'init-command',
  'patch-content',
  'start-command',
];

/**
 * 测试文件需要从结果里排除的名字。
 *
 * 与 SLOW_PATTERNS 的区别：SLOW_PATTERNS 是「跑得慢」，这里是「跑不完」——
 * 会挂住整个测试进程。SDK 适配器测试会启动真实的 Claude Code 会话，
 * 没有凭据时它会一直重试并占住事件循环。
 */
const HANGING_PATTERNS = [
  'claude-agent-sdk-adapter',
];

const __dirname = dirname(fileURLToPath(import.meta.url));
const testDir = join(__dirname, '..', 'dist-test', 'tests');

/** Recursively collect every *.test.js under the test directory. */
function collectTestFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTestFiles(full));
    } else if (entry.name.endsWith('.test.js')) {
      results.push(full);
    }
  }
  return results;
}

/** The newest mtime (ms) of any file under `dir`, 0 if the directory is empty. */
function newestMtime(dir) {
  let newest = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return newest;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(full));
    } else {
      try {
        newest = Math.max(newest, statSync(full).mtimeMs);
      } catch {
        /* unreadable — ignore */
      }
    }
  }
  return newest;
}

/**
 * 验收测试跑的是 `dist/cli/index.js` 这个真实 CLI 进程，而不是 `dist-test/` 里的产物。
 * 如果 `dist/` 比 `src/` 旧，它们就会对着旧二进制跑，表现为「改了代码却没效果」——
 * 这种失败比直接报错更难查。这里提前提醒，而不是等结果出来再猜。
 */
function warnIfCliBuildIsStale() {
  const root = join(__dirname, '..');
  const cliEntry = join(root, 'dist', 'cli', 'index.js');
  let cliMtime;
  try {
    cliMtime = statSync(cliEntry).mtimeMs;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[zelto] 读不到 dist/cli/index.js（${reason}）—— 验收测试会失败，请先运行 \`npm run build\`。`,
    );
    return;
  }
  if (newestMtime(join(root, 'src')) > cliMtime) {
    console.warn('[zelto] dist/ 比 src/ 旧 —— 验收测试会跑旧二进制，请先运行 `npm run build`。');
  }
}

const allFiles = collectTestFiles(testDir).sort();

const fastFiles = allFiles.filter((f) => !SLOW_PATTERNS.some((p) => f.includes(p)));

const runnableFiles = allFiles.filter((f) => !HANGING_PATTERNS.some((p) => f.includes(p)));

if (process.argv.includes('--list-slow')) {
  for (const f of allFiles.filter((f) => SLOW_PATTERNS.some((p) => f.includes(p)))) {
    console.log(relative(testDir, f));
  }
  process.exit(0);
}

if (process.argv.includes('--list-hanging')) {
  for (const f of allFiles.filter((f) => HANGING_PATTERNS.some((p) => f.includes(p)))) {
    console.log(relative(testDir, f));
  }
  process.exit(0);
}

const useAll = process.argv.includes('--all');
const selected = useAll ? runnableFiles : fastFiles;

if (selected.length === 0) {
  console.error('No test files found.');
  process.exit(1);
}

warnIfCliBuildIsStale();

// ── 单个用例的超时上限（分钟）────────────────────────────────────────
//
// 用途：替代 `--test-force-exit` 兜底「某个测试挂住」。
// 有了它，事件循环排空时若有用例真的吊死，会被明确报成
// 「超时」而不是让整个进程无限期挂着。
//
// 为什么是 10 分钟：最慢的验收测试（真跑 CLI、真建 git 仓库）
// 实测在 60s 量级；10 分钟给它们足够余量，同时不会让「真挂住」
// 要等一小时才被发现。
const TEST_TIMEOUT_MIN = 10;

// Spawn node --test with the filtered file list (cross-platform)
//
// 注意：**不传 `--test-force-exit`** —— 见文件头的说明（ZD-063）。
const result = spawnSync(
  process.execPath,
  ['--test', `--test-timeout=${TEST_TIMEOUT_MIN * 60_000}`, ...selected],
  {
    stdio: 'inherit',
    cwd: join(__dirname, '..'),
  },
);

process.exit(result.status ?? 1);
