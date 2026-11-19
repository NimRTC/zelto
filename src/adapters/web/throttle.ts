// Web 端拉起 agent 运行（ADR-086）
//
// `run` 不走 core —— 它必须用 executor adapter，而 `core/` 不许 import
// `adapters/`（C2）。所以 Web 端**不重实现** run，而是：
//
// **拉起 CLI 进程**（`zelto run <id> --detach`）。
//
// 为什么这是对的：
//   1. **判定不分叉**（C3 的核心关切）—— Web 端跑的就是那个 CLI 二进制，
//      同一份准入判定、同一份写集预检、同一份 hotfix 确认、同一份事件。
//   2. **孤儿问题已解** —— `--detach` 的监督进程机制（D-50/D-53）原样复用。
//      HTTP 请求不挂着 agent 会话（这正是 ADR-084 §1.1 要的）。
//   3. **不需要动 C2** —— 进程边界天然隔开 `adapters/` 与 `core/`。
//   4. **CLI 侧零改动** —— `run` 的实现一个字不动。
//
// C1: 状态只在文件里 —— 任务文件、会话文件、事件流。
// C9: 写集预约运行时强制 —— 由 CLI 进程执行，运行时守卫原样复用。

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 拉起 run 的结果。 */
export interface RunLaunchResult {
  ok: boolean;
  /** 失败原因（ok=false） */
  reason?: string;
  /** 监督进程的任务 id */
  taskId?: string;
  /** 监督进程 pid */
  supervisorPid?: number;
  /** CLI 的原始输出 */
  output?: string;
}

/**
 * 定位 zelto CLI 入口。
 *
 * 优先用**当前进程的 argv[1]** —— 驾驶舱自己就是 `dist/cli/index.js` 起的，
 * 它的同级目录里就有 CLI。找不到就退到 `dist/cli/index.js` 的约定位置。
 *
 * 找不到时**明确报错**，绝不降级成「假装跑起来了」——
 * 驾驶舱说「已在后台跑」而实际一个 agent 都没起，是最坏的假象（D-53）。
 */
export function locateCliEntry(repoRoot: string): string | null {
  // 1. 当前进程就是 CLI 时 —— 同目录就是 CLI 入口
  const self = process.argv[1];
  if (self) {
    const candidate = resolve(self);
    if (existsSync(candidate) && candidate.endsWith(`${'index'}.js`)) {
      // 它自己就是入口，直接用它
      return candidate;
    }
    const sibling = join(dirname(candidate), 'index.js');
    if (existsSync(sibling)) return sibling;
  }

  // 2. 从 core/config/blocks.js 往上找 dist/ —— 编译产物布局是 dist/cli/index.js
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // adapters/web/ → dist/adapters/web/ → dist/
    const distRoot = resolve(here, '..', '..');
    const candidate = join(distRoot, 'cli', 'index.js');
    if (existsSync(candidate)) return candidate;
  } catch {
    // import.meta.url 拿不到 —— 继续试下一个
  }

  // 3. repoRoot 下的 dist/cli/index.js（开发态从源码跑时）
  const fromRepo = join(repoRoot, 'dist', 'cli', 'index.js');
  if (existsSync(fromRepo)) return fromRepo;

  return null;
}

/**
 * 拉起一次后台运行（`zelto run <id> --detach`）。
 *
 * **fire-and-forget**：本函数在 CLI 进程**起来之后**就返回，
 * 不等 agent 跑完。agent 跑在独立的监督进程里（`--detach`）。
 *
 * @param hotfix 是否 hotfix 模式（跳过门禁②）
 * @param confirmHotfix hotfix 的显式确认（ADR-015：hotfix 必须显式确认）
 */
export async function launchRun(
  repoRoot: string,
  sliceId: string,
  options: { hotfix?: boolean; confirmHotfix?: boolean } = {},
): Promise<RunLaunchResult> {
  const hotfix = options.hotfix === true;
  const confirmHotfix = options.confirmHotfix === true;

  // ADR-015 §3.1：hotfix 跳过门禁② —— 等于放弃「签字前必须过门禁」。
  // 所以必须显式确认。Web 端要求**两个独立字段**（hotfix + confirmHotfix），
  // 比 CLI 的 `--hotfix --yes` 更严：那两个词是同一条命令行上的两个词，
  // 而 Web 的两个勾选框可能被误点。
  if (hotfix && !confirmHotfix) {
    return {
      ok: false,
      reason:
        'hotfix 会跳过门禁②（验收测试），等于放弃「签字前必须过门禁」这条约束，' +
        '所以必须显式确认。请同时提交 hotfix 与 confirmHotfix。',
    };
  }

  const cli = locateCliEntry(repoRoot);
  if (!cli) {
    return {
      ok: false,
      reason:
        '找不到 zelto CLI 入口 —— 无法从驾驶舱发起运行。' +
        '请在终端里执行：zelto run <slice-id>',
    };
  }

  const argv = [cli, 'run', sliceId, '--detach', '--json'];
  if (hotfix) argv.push('--hotfix', '--yes');

  return new Promise<RunLaunchResult>((resolvePromise) => {
    let settled = false;
    const child = spawn(process.execPath, argv, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      // 不 detached —— CLI 进程本身要活着把「已拉起监督进程」这话说出来。
      // 监督进程才是那个真正脱离的进程（CLI 的 --detach 会自己 detach 它）。
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString();
    });

    // 超时上限 —— CLI 的 run 只做「准入与准备」，正常几秒内就返回。
    // 超过 30 秒还没回来说明卡住了（多半是写集预约拿不到，
    // 或者 worktree 创建失败）—— 那时必须告诉人，而不是一直挂着。
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        // 已经退了 —— 无所谓
      }
      resolvePromise({
        ok: false,
        reason: '发起运行超时（30 秒）—— 请在终端里执行 zelto run 查看详情',
        output: (stdout + stderr).trim(),
      });
    }, 30_000);

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = (stdout + stderr).trim();
      if (code !== 0) {
        resolvePromise({
          ok: false,
          reason: output || `zelto run 退出码 ${code}`,
          output,
        });
        return;
      }
      resolvePromise({ ok: true, ...parseLaunchOutput(stdout), output });
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ ok: false, reason: `无法启动 zelto CLI：${err.message}` });
    });
  });
}

/**
 * 从 CLI 输出里解析 taskId 与 supervisorPid。
 *
 * CLI 的 detach 分支打印的是人话（不是 JSON）——
 * `zelto run <id> — ✅ Detached (task: task-xxx)`。
 * 所以这里用正则捞。**捞不到就只返回 ok** ——
 * 「起来了但没拿到 id」不该被当成「没起来」。
 */
function parseLaunchOutput(stdout: string): { taskId?: string; supervisorPid?: number } {
  const out: { taskId?: string; supervisorPid?: number } = {};
  const taskMatch = /\(task:\s*([^)]+)\)/.exec(stdout);
  if (taskMatch?.[1]) out.taskId = taskMatch[1].trim();
  const pidMatch = /pid\s+(\d+)/.exec(stdout);
  if (pidMatch?.[1]) out.supervisorPid = Number.parseInt(pidMatch[1], 10);
  return out;
}
