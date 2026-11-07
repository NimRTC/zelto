// ADR-035：适配器花费 → 预算闭环
//
// 这组用例锁住三件事：
//
// 1. **用量解析的边界**。`costUsd === 0` 是有效数据（真的没花钱），
//    与 null（没测到）语义不同；负数不是「零」，是数据坏了 → null。
// 2. **适配器不上报 = 预算不生效，而不是「花了零」**。
//    `getUsage` 对未知 session 返回 null 且不抛异常。
// 3. **Claude Code CLI 的 json 输出模式**。`getOutput` 优先返回 JSON 的
//    `result` 字段（问答回路依赖这段文本）；解析不出 JSON 时退回原始
//    stdout 文本 —— 输出不丢。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { extractClaudeJson, parseClaudeUsage } from '../src/adapters/usage-parse.js';
import { ClaudeAgentAdapter } from '../src/adapters/claude-agent/index.js';
import { ClaudeAgentSdkAdapter } from '../src/adapters/claude-agent-sdk/index.js';

const TEST_DIR = join(tmpdir(), `zelto-adr035-test-${Date.now()}`);

// ─── 用量解析 ────────────────────────────────────────────────────────────────

describe('ADR-035 · 用量解析', () => {
  it('从 JSON 对象里读出花费与 token', () => {
    const usage = parseClaudeUsage({
      total_cost_usd: 0.1234,
      usage: { input_tokens: 8123, output_tokens: 1456 },
      modelUsage: { 'claude-sonnet-4-20250514': { inputTokens: 8123, outputTokens: 1456 } },
    });
    assert.ok(usage);
    assert.equal(usage.costUsd, 0.1234);
    assert.equal(usage.inputTokens, 8123);
    assert.equal(usage.outputTokens, 1456);
    assert.equal(usage.model, 'claude-sonnet-4-20250514');
  });

  it('camelCase 的 token 字段也认（两处上报形状不一致）', () => {
    const usage = parseClaudeUsage({
      total_cost_usd: 1,
      usage: { inputTokens: 10, outputTokens: 20 },
    });
    assert.ok(usage);
    assert.equal(usage.inputTokens, 10);
    assert.equal(usage.outputTokens, 20);
  });

  it('花费为零是有效数据，不是「没测到」', () => {
    const usage = parseClaudeUsage({ total_cost_usd: 0 });
    assert.ok(usage, 'costUsd === 0 必须与 null 区分开');
    assert.equal(usage.costUsd, 0);
  });

  it('没有 total_cost_usd → null（没测到）', () => {
    assert.equal(parseClaudeUsage({ usage: { input_tokens: 10 } }), null);
  });

  it('花费为负 → null（数据坏了，不是零）', () => {
    assert.equal(parseClaudeUsage({ total_cost_usd: -1 }), null);
  });

  it('花费不是有限数 → null', () => {
    assert.equal(parseClaudeUsage({ total_cost_usd: Number.NaN }), null);
    assert.equal(parseClaudeUsage({ total_cost_usd: Number.POSITIVE_INFINITY }), null);
  });

  it('多个模型时不报模型 id（宁可留空，不报错的那一个）', () => {
    const usage = parseClaudeUsage({
      total_cost_usd: 0.5,
      modelUsage: { 'model-a': {}, 'model-b': {} },
    });
    assert.ok(usage);
    assert.equal(usage.model, undefined);
  });
});

describe('ADR-035 · JSON 提取', () => {
  it('直接解析标准 JSON', () => {
    const obj = extractClaudeJson('{"total_cost_usd":1,"result":"hi"}');
    assert.ok(obj);
    assert.equal(obj.result, 'hi');
  });

  it('stdout 里混进噪声时退回宽松切法', () => {
    const obj = extractClaudeJson('warning: something\n{"total_cost_usd":2}\n');
    assert.ok(obj);
    assert.equal(obj.total_cost_usd, 2);
  });

  it('不是 JSON → null（调用方据此退回原始文本）', () => {
    assert.equal(extractClaudeJson('hello world'), null);
    assert.equal(extractClaudeJson(''), null);
  });
});

// ─── 适配器：未知 session 返回 null ─────────────────────────────────────────

describe('ADR-035 · 适配器 getUsage', () => {
  it('SDK 适配器对未知 session 返回 null，不抛异常', () => {
    const adapter = new ClaudeAgentSdkAdapter();
    assert.equal(adapter.getUsage('nonexistent-session'), null);
  });

  it('CLI 适配器对未知 session 返回 null，不抛异常', () => {
    const adapter = new ClaudeAgentAdapter();
    assert.equal(adapter.getUsage('nonexistent-session'), null);
  });
});

// ─── SDK 适配器：从 result 消息记下用量 ────────────────────────────────────

describe('ADR-035 · SDK 适配器记用量', () => {
  /**
   * 消费消息流是适配器的内部方法（SDK 的 query() 需要真实 SDK 环境，
   * 测试里造不出来），所以用结构化断言调用它，喂一条假的消息流。
   */
  type SdkInternals = {
    consumeGenerator(
      sessionId: string,
      spec: { sliceId: string; prompt: string; model?: string },
      gen: AsyncGenerator<unknown, void>,
      retryCount: number,
    ): Promise<void>;
  };

  /** 造一个只会 yield 指定消息的假消息流。 */
  async function* fakeMessages(messages: unknown[]): AsyncGenerator<unknown, void> {
    for (const msg of messages) yield msg;
  }

  it('从 result 消息记下花费与 token', async () => {
    const adapter = new ClaudeAgentSdkAdapter();
    const internals = adapter as unknown as SdkInternals;

    await internals.consumeGenerator(
      'claude-agent-sdk-adr035-result',
      { sliceId: 'adr035', prompt: 'bundle' },
      fakeMessages([
        {
          type: 'result',
          total_cost_usd: 0.42,
          usage: { input_tokens: 1200, output_tokens: 340 },
        },
      ]),
      0,
    );

    const usage = adapter.getUsage('claude-agent-sdk-adr035-result');
    assert.ok(usage, '收到 result 消息就该记下用量');
    assert.equal(usage.costUsd, 0.42);
    assert.equal(usage.inputTokens, 1200);
    assert.equal(usage.outputTokens, 340);
  });

  it('没有 result 消息时用量为 null（没测到，不是零）', async () => {
    const adapter = new ClaudeAgentSdkAdapter();
    const internals = adapter as unknown as SdkInternals;

    await internals.consumeGenerator(
      'claude-agent-sdk-adr035-noresult',
      { sliceId: 'adr035', prompt: 'bundle' },
      fakeMessages([{ type: 'text', text: 'hello' }]),
      0,
    );

    assert.equal(adapter.getUsage('claude-agent-sdk-adr035-noresult'), null);
  });
});

// ─── CLI 适配器：json 输出模式的 getOutput / getUsage ──────────────────────

describe('ADR-035 · CLI 适配器的 json 输出', () => {
  before(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  /** 造一个只会打印指定 stdout 的假 agent。 */
  function fakeAgent(stdout: string): ClaudeAgentAdapter {
    const escaped = stdout.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return new ClaudeAgentAdapter({
      agentCommand: `node -e "process.stdout.write('${escaped}')"`,
      cwd: TEST_DIR,
    });
  }

  it('getOutput 优先返回 JSON 的 result 字段', async () => {
    const payload = JSON.stringify({
      result: 'the final answer',
      total_cost_usd: 0.25,
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    const adapter = fakeAgent(payload);
    const { sessionId } = await adapter.start({ sliceId: 'adr035-json', prompt: 'bundle' });
    await adapter.waitForExit(sessionId);

    assert.equal(adapter.getOutput(sessionId), 'the final answer');
  });

  it('getUsage 从 JSON 里读出花费与 token', async () => {
    const payload = JSON.stringify({
      result: 'done',
      total_cost_usd: 0.5,
      usage: { input_tokens: 200, output_tokens: 50 },
    });
    const adapter = fakeAgent(payload);
    const { sessionId } = await adapter.start({ sliceId: 'adr035-usage', prompt: 'bundle' });
    await adapter.waitForExit(sessionId);

    const usage = adapter.getUsage(sessionId);
    assert.ok(usage);
    assert.equal(usage.costUsd, 0.5);
    assert.equal(usage.inputTokens, 200);
    assert.equal(usage.outputTokens, 50);
  });

  it('stdout 不是 JSON 时退回原始文本，输出不丢', async () => {
    const adapter = fakeAgent('plain text answer');
    const { sessionId } = await adapter.start({ sliceId: 'adr035-plain', prompt: 'bundle' });
    await adapter.waitForExit(sessionId);

    assert.equal(adapter.getOutput(sessionId), 'plain text answer');
    assert.equal(adapter.getUsage(sessionId), null, '没有花费数据 → null，不是 0');
  });
});
