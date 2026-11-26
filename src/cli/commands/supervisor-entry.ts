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

/**
 * 收尾完成之后留给 I/O 冲刷的窗口（ADR-125）。
 *
 * 收尾里能落盘的东西都是**同步**写的（`appendFileSync` / `writeFileSync`），
 * 到这一步已经全部落盘；这段等待只为极少数走流的一侧留余量。
 * 它不是「等子进程」—— 子进程早被 `waitForAgentExit` 等过了。
 */
const EXIT_GRACE_MS = 3000;

/**
 * 「收尾已经做完、必须退出」（ADR-125 的里程碑）。
 *
 * 病灶（实测 nimrtc-v14 v4-d5-audio-dtx，2026-11-26 17:26 那一轮）：
 *   收尾全部做完（切片退回 frozen、预约释放、任务文件收尾、日志写了
 *   「监督进程退出」），进程**却一直挂在进程表上**（一小时后仍可查到，
 *   11 个线程、CPU 空闲）。原因：`runSupervisor().then(process.exit)`
 *   之后还有东西让事件循环不空 —— 适配器心跳（`setInterval`）在收尾
 *   流水线里被 `markProgress` 重建过一次，而它没有 `unref`。
 *
 * 两件事一起做：
 *   1. 自愈：适配器心跳已全部 `unref`（根因），正常路径能自然退出；
 *   2. 契约：**不管事件循环清不清空，收尾完成就必须退**。
 *      监督进程的职责是「等 agent + 收尾」，不含「陪着一个句柄待机」。
 *
 * 窗口内若事件循环仍不空，往 stderr 打一行诊断（活动句柄）——
 * 下次再有人看到「进程不退出」，日志里直接就有答案，不用再附调试器。
 */
function exitAfterFinish(code: number): void {
  process.exitCode = code;
  setTimeout(() => {
    try {
      const handles = (
        process as unknown as { _getActiveHandles?: () => unknown[] }
      )._getActiveHandles?.();
      if (handles && handles.length > 0) {
        console.error(
          `[zelto-supervisor] 收尾已完成，但仍有 ${handles.length} 个活动句柄（ADR-125）：` +
            handles.map((h) => describeHandle(h)).join(', '),
        );
      }
    } catch {
      /* 诊断失败不影响退出 */
    }
    process.exit(code);
  }, EXIT_GRACE_MS);
  // 这个定时器**不能** unref：它就是兜底本身。事件循环空着时若被跳过，
  // 「无论如何都退」就不成立了（自然退出会接手，但诊断就打不出来）。
}

function describeHandle(h: unknown): string {
  const obj = h as { constructor?: { name?: string }; localPort?: number };
  const name = obj?.constructor?.name ?? typeof h;
  return obj?.localPort !== undefined ? `${name}(port ${obj.localPort})` : name;
}

runSupervisor(args)
  .then((code) => {
    exitAfterFinish(code);
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
    // 与正常路径同一条契约：报错也要退，不能挂在进程表上（ADR-125）。
    process.exit(1);
  });
