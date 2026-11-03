#!/usr/bin/env node
// Test runner — filters test files by category and spawns node --test.
//
// Modes:
//   (default)        fast tests only — excludes slow ones (spawn, SDK, e2e)
//   --all            every test except the hanging ones (used by `pnpm test`)
//   --list-slow      print the slow test files and exit
//   --list-hanging   print the hanging test files and exit
//
// `--test-force-exit` is always passed: without credentials the agent adapters
// can leave handles open, and the test process would never terminate.

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

// Spawn node --test with the filtered file list (cross-platform)
const result = spawnSync(process.execPath, ['--test', '--test-force-exit', ...selected], {
  stdio: 'inherit',
  cwd: join(__dirname, '..'),
});

process.exit(result.status ?? 1);
