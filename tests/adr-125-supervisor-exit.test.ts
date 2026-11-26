// ADR-125 · 监督进程收尾之后不许「卡在退出」
//
// 病灶（实测于 nimrtc-v14 v4-d5-audio-dtx，2026-11-26）：
//
//   监督进程把收尾全做完了（切片退回 frozen、写集预约已释放、
//   日志最后一行是「监督进程退出」），但进程**一直挂在进程表上**——
//   一小时后仍可查到，CPU 空闲、11 个线程。
//
//   根因：shell 适配器的心跳 `setInterval` 没有 `unref`，而收尾流水线里
//   还会 `markProgress` → 重建一次心跳。事件循环永远不空，
//   `runSupervisor().then(process.exit)` 的进程退出路径就永远走不到。
//
// 这一组用例守的是（源码层面的契约，三条都别再退回去）：
//   1. 三个适配器的心跳/空转定时器都必须 `unref` —— 定时器不许拖住进程；
//   2. `supervisor-entry.ts` 在正常收尾后**强制退出**，不依赖事件循环；
//   3. 异常路径同样直接退出 —— 报错也不许挂在进程表上。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function read(rel: string): string {
  return readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf-8');
}

describe('ADR-125 心跳不许拖住进程退出', () => {
  const adapters = [
    'src/adapters/claude-agent/index.ts',
    'src/adapters/claude-agent-sdk/index.ts',
    'src/adapters/cursor-agent/index.ts',
  ];

  for (const rel of adapters) {
    it(`${rel}：心跳 setInterval 后必须紧跟 unref`, () => {
      const src = read(rel);
      // 心跳是每 5 秒一次的 setInterval；它 `clearInterval` 之后、
      // 收进 progressIntervals 之前，必须有一次 unref。
      const heartbeatBlocks = src.match(
        /setInterval\(\(\) => \{[\s\S]*?\}, 5000\);[\s\S]{0,800}?\.set\(sessionId, (?:heartbeat|progressInterval)\);/g,
      );
      assert.ok(heartbeatBlocks && heartbeatBlocks.length > 0, '应能找到心跳块');
      for (const block of heartbeatBlocks) {
        assert.match(block, /\.unref\?\.\(\)/, '心跳定时器必须 unref（ADR-125）');
      }
    });
  }

  it('claude-agent-sdk：空转 setTimeout 也要 unref（与 shell 适配器同口径）', () => {
    const src = read('src/adapters/claude-agent-sdk/index.ts');
    const timeoutBlock = src.match(
      /const timeout = setTimeout\(\(\) => \{[\s\S]*?\}, this\.timeoutMs\);[\s\S]{0,400}?this\.timeouts\.set/,
    );
    assert.ok(timeoutBlock, '应能找到空转定时器');
    assert.match(timeoutBlock[0], /\.unref\?\.\(\)/);
  });
});

describe('ADR-125 收尾完成必须退出', () => {
  const entry = read('src/cli/commands/supervisor-entry.ts');

  it('正常路径走 exitAfterFinish（强制退出 + 诊断窗口）', () => {
    assert.match(entry, /runSupervisor\(args\)[\s\S]*?\.then\([\s\S]*?exitAfterFinish/);
    assert.match(entry, /process\.exit\(code\)/);
    assert.match(entry, /EXIT_GRACE_MS/);
  });

  it('异常路径同样直接退出', () => {
    // `.catch` 末尾必须有 process.exit(1) —— 不许只设 exitCode 就返回，
    // 那等于把「退出」交给可能被句柄拖住的事件循环。
    const catchBlock = entry.match(/\.catch\(async[\s\S]*$/);
    assert.ok(catchBlock, '应能找到 catch 路径');
    assert.match(catchBlock[0], /process\.exit\(1\)/);
  });

  it('退出前的诊断会打印活动句柄（下一次卡住时日志里要有答案）', () => {
    assert.match(entry, /_getActiveHandles/);
  });
});
