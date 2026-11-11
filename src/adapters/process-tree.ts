// 进程树终止 —— 把「杀掉 agent」这件事做对（ADR-055）
//
// 背景：zelto 在 Windows 上用 `shell: true` 起 agent，拿到的是 `cmd.exe`
// 的 pid。`child.kill('SIGTERM')` 只杀 `cmd.exe`，**不会**杀它启动的
// `npx` / `node` / `claude` 那条真正的进程链。
//
// 后果不是「超时没生效」，而是更糟的两件事：
//   1. agent 变成孤儿继续跑，还在改文件、还在烧 token；
//   2. zelto 认为「这次失败了」，于是自动重试 —— 在孤儿正在写的
//      工作区上再起一个 agent。两个 agent 抢同一批文件。
//
// 实测（2026-11-11，nimrtc-zelto 的 v1-remb-parse-and-trust）：
// zelto 在 30 分钟超时点判失败并重跑，而第一个 agent 又活了 10 分钟、
// 交出了一份全部通过的报告 —— 报告被丢弃，切片被白跑了一遍。
//
// 所以这里提供的不是「kill」，而是「**杀干净**」：
//   - Windows：用 `taskkill /pid <pid> /T /F` 杀整棵树；
//   - POSIX：把子进程放进独立的进程组（`detached: true`），
//     然后 `kill(-pgid)` 杀整组。
//
// 只在 Windows 上用 `taskkill`、POSIX 上靠 `detached` + 负 pgid，
// 是因为两者对「一组进程」的表达方式不同：Windows 有任务树（job
// object / taskkill /T），POSIX 有进程组（kill 负 pid）。

import { execFile } from 'node:child_process';
import { platform } from 'node:os';

/**
 * 终止一个子进程及其所有后代进程。
 *
 * @param pid — 子进程 pid
 * @param options.force — true 时用 /F 强杀（Windows）；默认先温和终止
 * @returns Promise<void> — 永远 resolve：终止失败不该把调用方带崩，
 *   调用方的真实意图是「别让它继续跑」，失败时能做的只有记一笔。
 */
export function killProcessTree(
  pid: number | undefined,
  options: { force?: boolean } = {},
): Promise<void> {
  if (!pid || pid <= 0) return Promise.resolve();

  if (platform() === 'win32') {
    return new Promise<void>((resolve) => {
      const args = ['/pid', String(pid), '/T'];
      if (options.force) args.push('/F');
      execFile('taskkill', args, { windowsHide: true }, () => resolve());
    });
  }

  // POSIX：子进程是以独立进程组起的（见 spawn 处的 detached: true），
  // 所以 kill(-pid) 杀的是整组，包括 npx / node 这些后代。
  return new Promise<void>((resolve) => {
    try {
      process.kill(-pid, options.force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      // 进程组可能已经不存在了 —— 那正是我们想要的状态。
      try {
        process.kill(pid, options.force ? 'SIGKILL' : 'SIGTERM');
      } catch {
        /* 真的没了 */
      }
    }
    resolve();
  });
}

/**
 * POSIX 上的「优雅终止 → 宽限 → 强杀」两段式。
 *
 * Windows 的 `taskkill /T`（不带 /F）已经会终止整棵树，所以 Windows
 * 走单段；POSIX 上先 SIGTERM 让 agent 有机会收尾（写完最后一行输出），
 * 超时再 SIGKILL。
 */
export function killProcessTreeGracefully(
  pid: number | undefined,
  graceMs = 3000,
): void {
  if (!pid || pid <= 0) return;

  if (platform() === 'win32') {
    void killProcessTree(pid, { force: false });
    setTimeout(() => {
      void killProcessTree(pid, { force: true });
    }, graceMs);
    return;
  }

  void killProcessTree(pid, { force: false });
  setTimeout(() => {
    void killProcessTree(pid, { force: true });
  }, graceMs);
}
