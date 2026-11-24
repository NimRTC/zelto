// ZD-007 回归测试 —— **运行中**预算拦截
//
// 病灶（nimrtc v1.4，2026-11-20）：
//
//   一轮烧了 $5.86（上限 $1.00），产物其实做完了，但因为超预算
//   **没进门禁**，切片卡在 frozen。
//
//   更糟的是「预算耗尽」这个停机分类**误导人** —— 它看起来像
//   「agent 跑砸了」，实际是「agent 跑成了但超了闸门」。
//   人第一反应是重跑 → 再烧一遍钱。
//
// 根因：`checkBudget` 只在**起跑前**调一次，跑完后由 `settleRunCost`
// 记账时复判 —— **运行期间没有任何地方查预算**。
// 于是 agent 想烧多少烧多少，闸门形同虚设。
//
// 修法：加一个**可中断点** —— 运行期间定期查花费，超了当场叫停。
//
// 这条测试分三层，各测各的：
//  1. 纯逻辑层（`core/budget/runtime-guard.ts`）—— 判定口径
//  2. 接线层（`waitForExitWithWatchdog`）—— 真的会让等待方停下来
//  3. 适配器层（SDK 的 `getLiveUsage`）—— 运行中能不能报出金额
//
// 为什么要分开：第 2 层必须挂一个**假 adapter** 才能验
// （源码 grep 只能证明代码在，不能证明它真的会让等待方停下来）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  RuntimeBudgetGuard,
  isOverBudget,
  budgetInterceptionMessage,
} from '../src/core/budget/runtime-guard.js';
import { waitForExitWithWatchdog } from '../src/cli/commands/core-slice.js';
import type { ExecutorAdapter } from '../src/core/ports/executor.js';

// ─── 1. 纯逻辑层：判定口径 ─────────────────────────────────────────────────

describe('ZD-007 预算判定口径', () => {
  it('没超 → ok', () => {
    const guard = new RuntimeBudgetGuard(1.0, () => ({ costUsd: 0.5 }));
    const verdict = guard.check();
    assert.equal(verdict.status, 'ok');
    if (verdict.status === 'ok') {
      assert.equal(verdict.spentUsd, 0.5);
      assert.equal(verdict.limitUsd, 1.0);
    }
  });

  it('正好等于上限 → exceeded（边界含等号）', () => {
    const guard = new RuntimeBudgetGuard(1.0, () => ({ costUsd: 1.0 }));
    assert.equal(guard.check().status, 'exceeded');
  });

  it('超过上限 → exceeded', () => {
    const guard = new RuntimeBudgetGuard(1.0, () => ({ costUsd: 5.86 }));
    const verdict = guard.check();
    assert.equal(verdict.status, 'exceeded');
    if (verdict.status === 'exceeded') {
      assert.equal(verdict.spentUsd, 5.86);
    }
  });

  it('上限不限（Infinity）→ 永远 ok，且闸门不启用', () => {
    const guard = new RuntimeBudgetGuard(Number.POSITIVE_INFINITY, () => ({ costUsd: 999 }));
    assert.equal(guard.enabled, false);
    assert.equal(guard.check().status, 'ok');
  });

  it('测不到（null）→ unknown，**不判定超支**', () => {
    // 这是最容易写错的一格：把「测不到」当成「没花钱」→
    // 预算闸门就成了假闸门（恰恰是 ZD-007 要修的那个病）。
    const guard = new RuntimeBudgetGuard(1.0, () => null);
    const verdict = guard.check();
    assert.equal(verdict.status, 'unknown');
    if (verdict.status === 'unknown') {
      assert.equal(verdict.spentUsd, null);
    }
  });

  it('读用量抛异常 → unknown，不炸', () => {
    const guard = new RuntimeBudgetGuard(1.0, () => {
      throw new Error('adapter blew up');
    });
    assert.equal(guard.check().status, 'unknown');
  });

  it('数据坏了（负数 / NaN）→ unknown，不拿它判超支', () => {
    const neg = new RuntimeBudgetGuard(1.0, () => ({ costUsd: -1 }));
    assert.equal(neg.check().status, 'unknown');
    const nan = new RuntimeBudgetGuard(1.0, () => ({ costUsd: Number.NaN }));
    assert.equal(nan.check().status, 'unknown');
  });
});

describe('ZD-007 isOverBudget（纯判据）', () => {
  it('不限 → 永不超支', () => {
    assert.equal(isOverBudget(100, Number.POSITIVE_INFINITY), false);
  });

  it('测不到 → 不判超支', () => {
    assert.equal(isOverBudget(null, 1.0), false);
  });

  it('等于上限 → 超支', () => {
    assert.equal(isOverBudget(1.0, 1.0), true);
  });

  it('低于上限 → 不超支', () => {
    assert.equal(isOverBudget(0.99, 1.0), false);
  });
});

describe('ZD-007 拦截措辞', () => {
  it('说清是「闸门拦下的」而不是「跑砸了」', () => {
    // 病灶的另一半：措辞不对，人就会重跑 → 再烧一遍钱。
    const msg = budgetInterceptionMessage({
      sliceId: 'v1-n5-turn-server',
      spentUsd: 5.86,
      limitUsd: 1.0,
    });
    assert.ok(msg.includes('5.8600'), '应报出实际花费');
    assert.ok(msg.includes('1.0000'), '应报出上限');
    assert.ok(msg.includes('不是'), '应明说这不是「agent 跑砸了」');
    assert.ok(msg.includes('别直接重跑'), '应提醒别直接重跑');
  });
});

// ─── 2. 接线层：真的会停下来 ───────────────────────────────────────────────

/**
 * 一个**假**适配器：永远不会自己退出，只能被 stop() 叫停。
 *
 * 为什么需要它：要验「运行中预算闸门真的会让等待方停下来」，
 * 就得有一个「正在跑、且不自己结束」的会话。
 * 真实适配器做不到这一点（要么秒退，要么要花钱）。
 *
 * **必须持有一个真实的句柄**（`setInterval`）：
 * `waitForExitWithWatchdog` 里的看门狗定时器是 `unref()` 过的 ——
 * 它的存在只是为了让「进程能退出」，不是让事件循环活着。
 * 于是**事件循环的存活完全取决于有没有别的句柄**。
 *
 * 真实适配器里那个句柄是 agent 的**子进程**（`child_process.spawn`）；
 * 假适配器没有子进程，如果不自己造一个句柄，事件循环会在 agent
 * 「还活着」期间就空掉 —— Node 报
 * `Promise resolution is still pending but the event loop has already resolved`。
 *
 * 这个坑只在 **Linux + Node 22** 上暴露：Windows 上测试文件里其它
 * 未 await 的定时器恰好撑住了循环，于是本地全绿、CI 全红。
 * （同样的坑已在 `tests/d74-halt-single-slice-path.test.ts` 踩过并修好。）
 */
class HangingAdapter implements ExecutorAdapter {
  readonly name = 'hanging-test-adapter';
  readonly metadata = { version: '0.0.0', description: 'test', capabilities: {} } as never;

  stopped = false;
  /** 当前累计花费（可被测试改） */
  liveCostUsd = 0;
  private resolvers = new Map<string, (code: number | null) => void>();
  /**
   * 代替子进程的「存活句柄」—— 见上面的说明。
   * agent 退出（stop() 被调用）之后清掉它，多留一个定时器无害
   * （但留着会让测试进程退不出去，所以这里清）。
   */
  private keepAlive = setInterval(() => {}, 1000);

  async start(): Promise<{ sessionId: string }> {
    return { sessionId: 'sess-1' };
  }

  async resume(): Promise<{ sessionId: string }> {
    return { sessionId: 'sess-1' };
  }

  async query(): Promise<void> {
    // 不用
  }

  getOutput(): string {
    return '';
  }

  getAgentSessionId(): string | null {
    return null;
  }

  getUsage(): null {
    return null;
  }

  /** ZD-007：报运行中的累计花费 */
  getLiveUsage(): { costUsd: number } | null {
    return { costUsd: this.liveCostUsd };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.keepAlive);
    const r = this.resolvers.get('sess-1');
    if (r) r(null);
  }

  async events(): Promise<AsyncIterable<never>> {
    return {
      async *[Symbol.asyncIterator]() {
        // 空流
      },
    };
  }

  waitForExit(sessionId: string): Promise<number | null> {
    return new Promise<number | null>((resolve) => {
      this.resolvers.set(sessionId, resolve);
    });
  }
}

describe('ZD-007 接线层：运行中超预算会叫停 agent', () => {
  it('超预算 → resolve 带 budgetExceeded，并 stop 掉 agent', async () => {
    const adapter = new HangingAdapter();
    adapter.liveCostUsd = 5.86; // 一上来就超了

    const guard = new RuntimeBudgetGuard(1.0, () => {
      const usage = adapter.getLiveUsage();
      return usage ? { costUsd: usage.costUsd } : null;
    });

    const waited = await waitForExitWithWatchdog({
      sliceId: 'test-slice',
      sessionId: 'sess-1',
      adapter,
      runStartedAt: new Date().toISOString(),
      maxRetries: 0,
      budgetGuard: guard,
    });

    assert.equal(waited.budgetExceeded, true, '应标记为预算拦截');
    assert.equal(waited.exitCode, null, '不是「agent 跑完了」');
    assert.equal(waited.halted, undefined, '不是人拉闸');
    assert.equal(waited.watchdogReaped, false, '不是看门狗收走');
    assert.equal(adapter.stopped, true, 'agent 应被叫停');
    assert.equal(waited.spentUsd, 5.86);
    assert.equal(waited.limitUsd, 1.0);
  });

  it('不超预算 → 不叫停（继续等 agent 自己结束）', async () => {
    const adapter = new HangingAdapter();
    adapter.liveCostUsd = 0.1;

    const guard = new RuntimeBudgetGuard(1.0, () => ({ costUsd: adapter.liveCostUsd }));

    // 让 agent 在预算检查之后自己退出，验证「没被拦」
    const waiter = waitForExitWithWatchdog({
      sliceId: 'test-slice',
      sessionId: 'sess-1',
      adapter,
      runStartedAt: new Date().toISOString(),
      maxRetries: 0,
      budgetGuard: guard,
    });

    setTimeout(() => {
      adapter.liveCostUsd = 0.2;
      void adapter.stop();
    }, 50);

    const waited = await waiter;
    assert.equal(waited.budgetExceeded, undefined, '不该判成预算拦截');
    assert.equal(waited.exitCode, null);
  });

  it('不传 budgetGuard → 保持旧行为（不拦）', async () => {
    const adapter = new HangingAdapter();
    adapter.liveCostUsd = 999;

    const waiter = waitForExitWithWatchdog({
      sliceId: 'test-slice',
      sessionId: 'sess-1',
      adapter,
      runStartedAt: new Date().toISOString(),
      maxRetries: 0,
    });

    setTimeout(() => void adapter.stop(), 50);

    const waited = await waiter;
    assert.equal(waited.budgetExceeded, undefined, '没传闸门就不该有预算拦截');
  });

  it('并行路径也听预算闸门（waitForExitOrHalt）', async () => {
    const { waitForExitOrHalt } = await import('../src/cli/commands/parallel-executor.js');
    const { HaltStore } = await import('../src/core/halt/index.js');
    const { mkdtempSync: mk } = await import('node:fs');
    const { tmpdir: tmp } = await import('node:os');

    const adapter = new HangingAdapter();
    adapter.liveCostUsd = 5.86;

    const guard = new RuntimeBudgetGuard(1.0, () => ({ costUsd: adapter.liveCostUsd }));

    // 拉闸通道指向临时目录 —— 别去动项目根下的暂停请求
    const haltStore = new HaltStore(mk(join(tmp(), 'zelto-zd007-halts-')));

    const result = await waitForExitOrHalt(
      adapter,
      'sess-1',
      haltStore,
      'scope-all',
      undefined,
      guard,
    );

    assert.equal(result.budgetExceeded, true, '并行路径也应拦下');
    assert.equal(result.halted, false, '不是人拉闸');
    assert.equal(result.spentUsd, 5.86);
    assert.equal(result.limitUsd, 1.0);
    assert.equal(adapter.stopped, true, 'agent 应被叫停');
  });
});

// ─── 3. 适配器层：运行中能不能报出金额 ───────────────────────────────────

describe('ZD-007 适配器层：运行中用量', () => {
  it('shell 适配器（默认 json 模式）getLiveUsage 返回 null → 拦不了（fail-safe）', async () => {
    // 默认 `--output-format json` 在最后才吐整段 JSON，中途拿不到金额 ——
    // 所以 shell 适配器**默认**报不出运行中用量。
    // 「测不到」≠「没花钱」，于是**不判定超支**，让它继续跑。
    const { ClaudeAgentAdapter } = await import('../src/adapters/claude-agent/index.js');
    const adapter = new ClaudeAgentAdapter({ agentCommand: 'echo' });
    assert.equal(typeof adapter.getLiveUsage, 'function');
    assert.equal(adapter.getLiveUsage('any'), null, 'json 模式中途测不到 → null');
  });

  it('shell 适配器（streamJson 模式）能从 NDJSON 累加 token，有单价才报得出金额', async () => {
    // ZD-007 阶段2：`agent.streamJson: true` 时用 `--output-format stream-json`，
    // stdout 是逐行 JSON，agent 运行中就会吐出 `assistant` 消息（带 usage）。
    // 适配器把 token 累加起来、按单价折成金额 → 运行中拦截生效。
    const { ClaudeAgentAdapter } = await import('../src/adapters/claude-agent/index.js');
    const adapter = new ClaudeAgentAdapter({
      agentCommand: 'echo',
      streamJson: true,
      pricePerKToken: { input: 0.003, output: 0.015 },
    });

    // 直接驱动内部 NDJSON 消费（模拟 stdout 分块到达）——
    // 不真的起进程，纯验证累加与折算逻辑。
    type Internals = { consumeNdjson(sessionId: string, chunk: string): void };
    const internals = adapter as unknown as Internals;

    assert.equal(adapter.getLiveUsage('s1'), null, '还没收到消息 → 测不到');

    // 两条 assistant 消息，第二条故意跨 chunk 切开（验证跨块拼行）。
    const line1 = JSON.stringify({
      type: 'assistant',
      message: { usage: { input_tokens: 1000, output_tokens: 500 } },
      model: 'deepseek-chat',
    }) + '\n';
    const line2 = JSON.stringify({
      type: 'assistant',
      message: { usage: { input_tokens: 2000, output_tokens: 1000 } },
    }) + '\n';
    internals.consumeNdjson('s1', line1 + line2.slice(0, 10));
    internals.consumeNdjson('s1', line2.slice(10));

    const usage = adapter.getLiveUsage('s1');
    assert.ok(usage, '应报得出金额');
    assert.equal(usage?.inputTokens, 3000);
    assert.equal(usage?.outputTokens, 1500);
    // 3000/1000*0.003 + 1500/1000*0.015 = 0.009 + 0.0225 = 0.0315
    assert.ok(Math.abs((usage?.costUsd ?? 0) - 0.0315) < 1e-9, String(usage?.costUsd));
    assert.equal(usage?.model, 'deepseek-chat');
  });

  it('shell 适配器（streamJson）有最终 result 时用精确 total_cost_usd', async () => {
    const { ClaudeAgentAdapter } = await import('../src/adapters/claude-agent/index.js');
    const adapter = new ClaudeAgentAdapter({
      agentCommand: 'echo',
      streamJson: true,
      pricePerKToken: { input: 0.003, output: 0.015 },
    });
    type Internals = { consumeNdjson(sessionId: string, chunk: string): void };
    const internals = adapter as unknown as Internals;

    internals.consumeNdjson('s2', JSON.stringify({
      type: 'assistant',
      message: { usage: { input_tokens: 1000, output_tokens: 500 } },
    }) + '\n');
    // result 消息自带精确金额
    internals.consumeNdjson('s2', JSON.stringify({
      type: 'result',
      total_cost_usd: 0.123,
      usage: { input_tokens: 9999, output_tokens: 9999 },
    }) + '\n');

    const usage = adapter.getLiveUsage('s2');
    assert.ok(usage);
    assert.equal(usage?.costUsd, 0.123, '有精确金额时优先用它');
  });

  it('shell 适配器（streamJson）没有单价 → 报不出金额（不猜）', async () => {
    const { ClaudeAgentAdapter } = await import('../src/adapters/claude-agent/index.js');
    const adapter = new ClaudeAgentAdapter({ agentCommand: 'echo', streamJson: true });
    type Internals = { consumeNdjson(sessionId: string, chunk: string): void };
    const internals = adapter as unknown as Internals;
    internals.consumeNdjson('s3', JSON.stringify({
      type: 'assistant',
      message: { usage: { input_tokens: 1000, output_tokens: 500 } },
    }) + '\n');
    assert.equal(adapter.getLiveUsage('s3'), null, '没有单价 → null');
  });

  it('SDK 适配器有 getLiveUsage —— 有单价才报得出金额', async () => {
    const { ClaudeAgentSdkAdapter } = await import('../src/adapters/claude-agent-sdk/index.js');
    const adapter = new ClaudeAgentSdkAdapter({
      pricePerKToken: { input: 0.003, output: 0.015 },
    });
    assert.equal(typeof adapter.getLiveUsage, 'function');

    // 没有任何会话 → 没有用量 → null（「测不到」）
    assert.equal(adapter.getLiveUsage('nope'), null);
  });
});

// ─── 4. 配置层：三处读上限必须同一口径 ───────────────────────────────────

describe('ZD-007 预算上限：三处读法必须一致', () => {
  // 上限有**三个**读者：
  //   ① `BudgetCollector.getLimit` —— 直接读 config.yaml（起跑前那道闸门）
  //   ② `core/config/loader.ts` 的 `budgetLimitUsd` —— CLI 侧（事前约束 + 运行中闸门）
  //   ③ `readBudgetLimit` —— 复用 ①（单片路径与并行路径的运行中闸门）
  //
  // 两份实现漂移的后果：人看到一个**自相矛盾**的账 ——
  // 「起跑前按 $1 拦、运行中按 $100 拦」，或者反过来。
  // 这是必须验的一条。

  const mkTmp = () => {
    const root = mkdtempSync(join(tmpdir(), 'zelto-zd007-cfg-'));
    return root;
  };

  it('配置解析出的 budgetLimitUsd 与 collector 读到的一致', async () => {
    const { parseConfigYaml } = await import('../src/core/config/loader.js');
    const { BudgetCollector } = await import('../src/core/budget/collector.js');
    const { EventStream } = await import('../src/core/events/stream.js');

    for (const raw of ['budgetLimitUsd: 2.5', 'budgetLimitUsd: 0', 'budgetLimitUsd: 1.0']) {
      const root = mkTmp();
      try {
        // ① collector 直接读 config.yaml
        const zeltoDir = join(root, '.zelto');
        mkdirSync(zeltoDir, { recursive: true });
        writeFileSync(join(zeltoDir, 'config.yaml'), `${raw}\n`, 'utf-8');
        const collector = new BudgetCollector(new EventStream(join(zeltoDir, 'events')), zeltoDir);
        const collectorLimit = await collector.getLimit('');

        // ② 配置解析
        const parsed = parseConfigYaml(`${raw}\n`);
        assert.ok(parsed, `应能解析 ${raw}`);

        // ③ 对齐口径：collector 的 0 = Infinity，解析器的 0 = 0（不限的标记）
        const parsedLimit = parsed.budgetLimitUsd === 0
          ? Number.POSITIVE_INFINITY
          : parsed.budgetLimitUsd;

        assert.equal(
          parsedLimit,
          collectorLimit,
          `配置解析与 collector 对 ${raw} 的读法必须一致（两份实现漂移会让人看到自相矛盾的账）`,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('没配 budgetLimitUsd → 两边都退回默认 1.0', async () => {
    const { parseConfigYaml } = await import('../src/core/config/loader.js');
    const { BudgetCollector } = await import('../src/core/budget/collector.js');
    const { EventStream } = await import('../src/core/events/stream.js');

    const root = mkTmp();
    try {
      const zeltoDir = join(root, '.zelto');
      mkdirSync(zeltoDir, { recursive: true });
      // 要有 gate 段 —— 否则 `parseConfigYaml` 返回 null（整份配置是空的）
      const yaml = 'gate:\n  commands:\n    - name: test\n      run: echo\n';
      writeFileSync(join(zeltoDir, 'config.yaml'), yaml, 'utf-8');

      const collector = new BudgetCollector(new EventStream(join(zeltoDir, 'events')), zeltoDir);
      assert.equal(await collector.getLimit(''), 1.0);

      const parsed = parseConfigYaml(yaml);
      assert.ok(parsed);
      // 没配 → 字段是 undefined（调用方按默认 1.0 处理）
      assert.equal(parsed.budgetLimitUsd, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── 5. 单价解析：拿别的模型的价去折算就是错的判据 ────────────────────────

describe('ZD-007 单价解析（resolvePricePerKToken）', () => {
  it('模型名精确匹配', async () => {
    const { resolvePricePerKToken } = await import('../src/cli/commands/shared.js');
    const pricing = {
      'deepseek-chat': { inputPer1k: 0.00027, outputPer1k: 0.0011 },
      'deepseek-reasoner': { inputPer1k: 0.00055, outputPer1k: 0.00219 },
    };
    assert.deepEqual(resolvePricePerKToken('deepseek-chat', pricing), {
      input: 0.00027,
      output: 0.0011,
    });
  });

  it('模型名带前缀 → 后缀匹配', async () => {
    const { resolvePricePerKToken } = await import('../src/cli/commands/shared.js');
    const pricing = { 'deepseek-chat': { inputPer1k: 1, outputPer1k: 2 } };
    assert.deepEqual(resolvePricePerKToken('deepseek/deepseek-chat', pricing), {
      input: 1,
      output: 2,
    });
  });

  it('多档且模型对不上 → null（不猜）', async () => {
    const { resolvePricePerKToken } = await import('../src/cli/commands/shared.js');
    const pricing = {
      a: { inputPer1k: 1, outputPer1k: 1 },
      b: { inputPer1k: 2, outputPer1k: 2 },
    };
    // 拿别的模型的价去折算 → 闸门会**提前**或**延后**开火 —— 两种都是错的判据。
    assert.equal(resolvePricePerKToken('c', pricing), null);
  });

  it('恰好一档 → 用它（没得选错）', async () => {
    const { resolvePricePerKToken } = await import('../src/cli/commands/shared.js');
    const pricing = { only: { inputPer1k: 3, outputPer1k: 4 } };
    assert.deepEqual(resolvePricePerKToken('whatever', pricing), { input: 3, output: 4 });
  });

  it('没有 pricing → null', async () => {
    const { resolvePricePerKToken } = await import('../src/cli/commands/shared.js');
    assert.equal(resolvePricePerKToken('m', undefined), null);
    assert.equal(resolvePricePerKToken('m', {}), null);
  });
});

// ─── 5. 配置层：agent.streamJson（ZD-007 阶段2）─────────────────────────────

describe('ZD-007 阶段2：agent.streamJson 配置解析', () => {
  it('streamJson: true 被解析出来；缺省为关', async () => {
    const { parseConfigYaml } = await import('../src/core/config/loader.js');

    const withStream = parseConfigYaml(
      [
        'gate:',
        '  commands:',
        '    - name: test',
        '      run: npm test',
        'agent:',
        '  command: npx claude-code',
        '  streamJson: true',
        '',
      ].join('\n'),
    );
    assert.ok(withStream);
    assert.equal(withStream?.agent.streamJson, true);

    const withoutStream = parseConfigYaml(
      [
        'gate:',
        '  commands:',
        '    - name: test',
        '      run: npm test',
        'agent:',
        '  command: npx claude-code',
        '',
      ].join('\n'),
    );
    assert.ok(withoutStream);
    assert.equal(withoutStream?.agent.streamJson, undefined, '缺省不出现 = 关');
  });
});
