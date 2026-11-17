// D-66：并行执行路径必须喂进展 —— 否则推进中的 agent 被空转超时砍掉
//
// 病灶（实测 nimrtc-zelto v4-ai-teammate，2026-11-18）：
//
//   `zelto version start v4` 走的是**并行执行路径**（parallel-executor）。
//   第一轮 agent 跑了整整 30 分钟，事件流里 20:41–20:51 每分钟都有新事件
//   （hook 每调一次工具就写一条 —— 它一直在推进），但会话文件写的是：
//
//     [zelto: no progress for 1800000ms — killed]
//
//   倒计时**一次都没被重置过**。
//
// 根因：D-55 把 `markProgress` 接到了两条路径上 ——
//   - 单片路径：`core-slice.ts` 的 `waitForExitWithWatchdog`
//   - 后台监督：`supervisor.ts` 的 `waitForAgentExit`
//
// 但**并行执行路径**（`parallel-executor.ts` 的 `waitForExitOrHalt`）没接。
// 适配器的空转倒计时只认 `markProgress` —— 没人叫它，就一路数到 1800 秒。
//
// 这跟 D-55 补（监督进程的截止时间）、D-56（看门狗路径漏了 progress）
// 是同一个形态：**「每条路径都接上了」不等于「每条路径都接全了」**。
// 单测全绿，因为单测测的是「我测的那条路接上了吗」，而病是「另一条路没接」。
//
// 这里做两件事：
//   1. 运行时断言 —— 事件流变长时，`waitForExitOrHalt` 真的会调 markProgress；
//   2. 源码断言 —— 并行执行器真的为每片建了探针并传了进去。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { waitForExitOrHalt } from '../src/cli/commands/parallel-executor.js';
import { SliceProgressProbe } from '../src/cli/commands/progress-probe.js';
import { HaltStore } from '../src/core/halt/index.js';

describe('D-66：并行执行路径把进展喂给适配器', () => {
  it('事件流变长时调用 markProgress（运行时）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zelto-d66-'));
    const sliceId = 'v4-probe-slice';
    const eventDir = join(root, '.zelto', 'events', sliceId);
    mkdirSync(eventDir, { recursive: true });
    const eventFile = join(eventDir, 'events.jsonl');
    writeFileSync(eventFile, '', 'utf-8');

    const probe = new SliceProgressProbe(root, sliceId);

    const marked: string[] = [];
    const adapter = {
      // 假装 agent 跑 3 秒才退出
      waitForExit: async (_id: string): Promise<number | null> => {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        return 0;
      },
      stop: async (_id: string): Promise<void> => {},
      markProgress: (id: string): void => {
        marked.push(id);
      },
    };

    // 1.5 秒后追加一条事件 —— 模拟 agent 又动了一次
    setTimeout(() => {
      appendFileSync(eventFile, JSON.stringify({ ts: new Date().toISOString(), type: 'policy.decision' }) + '\n', 'utf-8');
    }, 1500);

    const haltStore = new HaltStore(join(root, '.zelto'));
    const result = await waitForExitOrHalt(adapter, 'session-1', haltStore, 'batch', probe);

    assert.equal(result.exitCode, 0, 'agent 正常退出');
    assert.equal(result.halted, false, '不该被拉闸');
    assert.ok(
      marked.includes('session-1'),
      '事件流变长了就必须叫 markProgress —— 否则适配器的空转倒计时会一路数到 timeoutMs',
    );
  });

  it('事件流不变时不叫 markProgress（不制造假进展）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zelto-d66b-'));
    const sliceId = 'v4-quiet-slice';
    const eventDir = join(root, '.zelto', 'events', sliceId);
    mkdirSync(eventDir, { recursive: true });
    writeFileSync(join(eventDir, 'events.jsonl'), 'x\n', 'utf-8');

    const probe = new SliceProgressProbe(root, sliceId);

    let markCalls = 0;
    const adapter = {
      waitForExit: async (_id: string): Promise<number | null> => {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        return 0;
      },
      stop: async (_id: string): Promise<void> => {},
      markProgress: (): void => {
        markCalls += 1;
      },
    };

    const haltStore = new HaltStore(join(root, '.zelto'));
    await waitForExitOrHalt(adapter, 'session-2', haltStore, 'batch', probe);

    assert.equal(markCalls, 0, '事件流没变就不该报进展 —— 假进展会让空转超时形同虚设');
  });

  it('并行执行器为每片建探针并传进 waitForExitOrHalt（源码）', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'cli', 'commands', 'parallel-executor.ts'),
      'utf-8',
    );

    assert.match(
      source,
      /import\s*\{[^}]*SliceProgressProbe[^}]*\}\s*from\s*'\.\/progress-probe\.js'/,
      '并行执行器必须引入进展探针',
    );

    assert.match(
      source,
      /new\s+SliceProgressProbe\(/,
      '并行执行器必须真的建探针 —— 光 import 没用',
    );

    // 探针必须**传**进等待函数（而不是建了不用）
    const call = source.match(
      /waitForExitOrHalt\(\s*adapters\[i\][\s\S]{0,400}?\)/,
    );
    assert.ok(call, '应当能找到 waitForExitOrHalt 的调用点');
    assert.match(
      call[0],
      /progressProbes\.get\(/,
      '探针必须传进 waitForExitOrHalt —— 建了不传等于没建',
    );
  });

  it('waitForExitOrHalt 的 adapter 类型接受可选的 markProgress', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'cli', 'commands', 'parallel-executor.ts'),
      'utf-8',
    );
    assert.match(
      source,
      /markProgress\?\(\s*id\s*:\s*string\s*\)\s*:\s*void/,
      'markProgress 是可选能力 —— 没实现的适配器不受影响',
    );
  });
});
