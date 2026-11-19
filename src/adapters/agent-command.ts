// agent 命令的可用性检查 —— 「这条命令能不能跑」
//
// 为什么抽出来（ADR-086）：
//
//   判定「agent 命令找不找得到」这件事与 agent 本身无关 ——
//   Claude Code、Cursor、Codex 都要查，都是同一条逻辑：
//   先按 PATH 找，找不到再问 shell 能不能解析（shell 内建命令不在 PATH 上）。
//
//   两处各写一份 → 迟早漂移，而漂移的方向通常是「漏掉 shell 内建」这类
//   边角 —— 那会让一个本该能跑的命令被判成「找不到」。
//
// C2: 只用 Node 内置模块

import { execSync } from 'node:child_process';

/** 描述「agent 命令找不到」，并且**指向正确的那条命令**。 */
export function describeMissingAgent(
  agentCommand: string,
  configuredCommand?: string,
): string {
  const base = `Agent command "${agentCommand}" not found.`;

  // 没有配置里的命令可比（或两者相同）→ 只能让人去装 / 去改配置
  if (!configuredCommand || configuredCommand === agentCommand) {
    return `${base} Install it or update .zelto/config.yaml agent.command.`;
  }

  // 配置里的命令与这次用的不同 → 是命令行这次的覆盖拼错了
  return (
    `${base}\n` +
    `  当前配置里的命令是：${configuredCommand}` +
    `\n  这次用的是命令行传的 --agent（与配置不同）。` +
    `\n  改掉 --agent 的拼写，或去掉 --agent 用配置里的命令。`
  );
}

/**
 * cmd.exe 的内置命令清单。
 *
 * 为什么要单独一份：Windows 上 `where` / `which` 找不到 shell 内建命令，
 * 但它们**能跑**。不区分就会把 `echo` 判成「不存在」。
 */
const WINDOWS_SHELL_BUILTINS = new Set([
  'assoc', 'break', 'call', 'cd', 'chdir', 'cls', 'color', 'copy',
  'date', 'del', 'dir', 'echo', 'endlocal', 'erase', 'exit', 'for',
  'ftype', 'goto', 'if', 'md', 'mkdir', 'mklink', 'move', 'path',
  'pause', 'popd', 'prompt', 'pushd', 'rd', 'rmdir', 'rem', 'ren',
  'rename', 'set', 'setlocal', 'shift', 'start', 'time', 'title',
  'type', 'ver', 'verify', 'vol',
]);

/**
 * 这个平台的 shell 能不能解析出这条命令（哪怕它不在 PATH 上）。
 *
 * Windows：cmd.exe 的内置命令集合是固定的 —— 不在里面就是真的没有。
 * POSIX：`command -v` 能解析内置命令、函数与别名，且不会真的执行。
 */
function isShellResolvable(cmd: string): boolean {
  if (process.platform === 'win32') {
    return WINDOWS_SHELL_BUILTINS.has(cmd.toLowerCase());
  }

  try {
    execSync(`sh -c "command -v ${cmd} >/dev/null 2>&1"`, { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 查一条 agent 命令能不能跑。
 *
 * @returns null 表示「能跑」；否则返回一句人话，说明怎么修。
 */
export async function checkAgentAvailable(
  agentCommand: string,
  configuredCommand?: string,
): Promise<string | null> {
  const cmd = agentCommand.split(' ')[0]; // 取命令本体（去掉参数）
  if (!cmd) {
    return describeMissingAgent(agentCommand, configuredCommand);
  }
  const lookup = process.platform === 'win32' ? 'where' : 'which';

  try {
    execSync(`${lookup} ${cmd}`, { stdio: 'ignore', timeout: 5000 });
    return null;
  } catch {
    // 不在 PATH 上 —— 再问 shell 能不能解析。
    if (isShellResolvable(cmd)) return null;
    return describeMissingAgent(agentCommand, configuredCommand);
  }
}
