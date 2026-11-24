// 跨平台的「ctest 替身」fixture —— 给 ADR-096 / ADR-097 / ZD-027 三组端到端用例共用。
//
// ── 为什么需要它（2026-11-24，Linux CI 红了才暴露出来）────────────────────
//
// 那三组端到端用例都用**真实项目的命令形态**跑门禁：
//
//   cmd /c "<dir>/ctest.cmd --test-dir build --output-on-failure -C Debug"
//
// `cmd` 是 Windows 的命令解释器 —— **Linux 上压根不存在**。
// 于是「第一轮全量失败 → 第二轮被收窄」这条断言在 Linux 上永远走不到断言那一步：
// 命令本身就跑不起来，`runner` 认不出是 ctest（判 `unknown`），
// 收窄逻辑根本没触发 —— 用例以 `expected 'ctest', actual 'unknown'` 失败。
//
// 而 Windows job 跑的是 `test:quick`（覆盖同一批 `dist-test/tests/**`），**它是绿的**。
// 于是出现了一个很隐蔽的局面：**Windows 全绿、Linux 全红**，
// 而 CI 的「主判据」恰恰是 Linux 那条。
//
// ── 修法 ────────────────────────────────────────────────────────────────
//
// **按平台复刻该平台的真实命令形态**，而不是强行让 Linux 跑 Windows 的形态：
//
//   - Windows：`cmd /c "<dir>\ctest.cmd <args>"`（保持原样，不动既有语义）
//   - POSIX  ：`<dir>/ctest.sh <args>`（`ctest.sh` 是可执行的 shell 脚本）
//
// 两种形态里，「ctest 词元」的位置都**能被 `isCtestCommand` 认出来**
// （收窄逻辑认的是词元 + 可执行扩展名，`exe/cmd/bat/com/sh` 都在白名单里），
// 所以收窄逻辑在两个平台上走的是**同一条路径** —— 这才是我们要验的东西。
//
// 关键：**不把断言降级成「跳过 Windows 专属检查」**。
// 跨平台化的是 fixture，断言的**强度保持不变** ——
// 只是「收窄参数插在哪」这件事，在两个平台上按各自的形态分别断言。

import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Windows 上 `cmd /c` 形态；POSIX 上直接执行 shell 脚本。 */
export interface CtestFixture {
  /** fixture 所在目录 */
  dir: string;
  /** ctest 替身可执行文件的绝对路径 */
  toolPath: string;
  /** 门禁配置里该填的命令（已按平台适配） */
  command: string;
  /** 这条命令是不是 `cmd /c "..."` 形态（Windows） */
  windowsWrapped: boolean;
  /**
   * 断言「收窄参数插在了正确的位置」。
   *
   * 两个平台的「正确位置」含义不同，但**判据的严格程度相同**：
   * - Windows：必须在 `cmd /c "..."` 的**引号内**（否则 cmd 会把它当成新命令）；
   * - POSIX  ：必须在 ctest 词元**之后**（插在前面会落到工具路径之前，命令就跑不成）。
   *
   * 共同底线：原始参数（`--test-dir build` 等）必须**原样保留**。
   */
  assertNarrowedInPlace(rewritten: string): void;
}

/**
 * 造一个 ctest 替身。
 *
 * @param dir       fixture 目录（调用方负责建好）
 * @param workerName worker 脚本文件名（内容由调用方自己写）
 * @param args      跟在工具后面的参数（原样拼进命令）
 */
export function createCtestFixture(
  dir: string,
  workerName: string,
  args: string,
): CtestFixture {
  const isWindows = process.platform === 'win32';
  const workerPath = join(dir, workerName);

  // 工具文件名必须**含 `ctest`** —— 收窄逻辑认的是词元本身，
  // 而 `isPathToCtestTool` 按**扩展名**判「这是工具还是别人的脚本」。
  // 所以 `ctest.sh` / `ctest.cmd` 认得出，`ctest-worker.cjs` 认不出。
  const toolPath = join(dir, isWindows ? 'ctest.cmd' : 'ctest.sh');

  if (isWindows) {
    // `.cmd` 是 Windows 上真实的可执行形态（`npm` 就是）。
    // 换行必须是 CRLF —— cmd 对 LF-only 的批处理会解析异常。
    writeFileSync(toolPath, ['@echo off', `node "${workerPath}" %*`, ''].join('\r\n'), 'utf-8');
  } else {
    writeFileSync(toolPath, ['#!/bin/sh', `exec node "${workerPath}" "$@"`, ''].join('\n'), 'utf-8');
    // POSIX 上没有「.sh 就自动可执行」这回事 —— 必须显式给执行位。
    chmodSync(toolPath, 0o755);
  }

  // 命令形态：Windows 用 `cmd /c "..."`（复刻 nimrtc-v14 的真实形态），
  // POSIX 直接执行工具路径。
  const command = isWindows
    ? `cmd /c "${toolPath} ${args}"`
    : `"${toolPath}" ${args}`;

  return {
    dir,
    toolPath,
    command,
    windowsWrapped: isWindows,
    assertNarrowedInPlace(rewritten: string): void {
      const argIdx = rewritten.indexOf('--tests-from-file');
      if (argIdx < 0) {
        throw new Error(`收窄参数没插进去：${rewritten}`);
      }

      if (isWindows) {
        // 引号必须**包住**收窄参数：`cmd /c "..."` 的引号配对由 cmd 自己定，
        // 参数落到引号外就会被当成新命令（ADR-096 实测：exit 255）。
        const openQuote = rewritten.indexOf('"');
        const closeQuote = rewritten.lastIndexOf('"');
        if (!(openQuote >= 0 && argIdx > openQuote && argIdx < closeQuote)) {
          throw new Error(
            `收窄参数必须落在 cmd /c 的引号内，实际：${rewritten}`,
          );
        }
      } else {
        // POSIX：必须插在 ctest 词元**之后** —— 插在前面命令就跑不成。
        const toolIdx = rewritten.indexOf(toolPath);
        if (!(toolIdx >= 0 && argIdx > toolIdx)) {
          throw new Error(
            `收窄参数必须落在 ctest 词元之后，实际：${rewritten}`,
          );
        }
      }

      // 共同底线：原始参数必须原样保留 —— 收窄是**加**过滤，不是**换**命令。
      for (const a of args.split(' ')) {
        if (!a) continue;
        if (!rewritten.includes(a)) {
          throw new Error(`收窄后丢了原始参数 ${a}，实际：${rewritten}`);
        }
      }
    },
  };
}
