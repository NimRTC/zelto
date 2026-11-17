#!/usr/bin/env node
// 后台监督进程入口（`zelto run --detach` 拉起的独立进程）
//
// 这是一个**独立进程**，不是主进程里的一个 Promise —— 见 supervisor.ts
// 头部的 D-50 说明：主进程 `process.exit()` 会把同进程里没 await 的
// Promise 一起带走，于是 agent 变孤儿、任务文件永远停在 running、没人收尾。
//
// 它做三件事：
//   1. **起 agent**（适配器住在这里 → 退出码拿得到）
//   2. 等 agent 退出
//   3. 写收尾（记账 / 审计 / 门禁 / 签字请求 / 切片状态 / 释放预约）
//
// 它**不**跑门禁判定本身 —— 那由 run-finish.ts 共用流水线负责；
// 它**不**替人签字 —— 只发签字请求。
//
// stdout/stderr：detached 进程没人接 stdout，所以它**自己往日志文件写**
// （`--log-file`）。不能用管道 —— 管道的一头在主进程身上，主进程退出后
// 管道就断了，子进程再写就 EPIPE，日志只剩半截。

import { parseSupervisorArgs, runSupervisor } from './supervisor.js';

const parsed = parseSupervisorArgs(process.argv.slice(2));

if (!parsed) {
  console.error('[zelto-supervisor] 参数不完整 —— 退出');
  process.exit(2);
}
const args = parsed;

runSupervisor(args)
  .then((code) => {
    process.exit(code);
  })
  .catch(async (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[zelto-supervisor] 监督进程异常退出：${message}`);
    // 收尾失败也要留痕 —— 现场比「干净地退出」重要（C4）
    try {
      const { events } = await import('./shared.js');
      await events.append(args.sliceId, 'run.aborted', 'zelto', {
        sliceId: args.sliceId,
        reason: `supervisor crashed: ${message}`,
        supervisor: true,
      });
    } catch {
      /* 连事件都写不上就算了 */
    }
    process.exit(1);
  });
