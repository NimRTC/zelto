// ADR-035：预算闭环的判定语义
//
// `tests/adr-035-usage.test.ts` 锁的是「适配器怎么上报用量」。
// 这一组锁的是上报之后发生的判定 —— 也就是「预算闸门到底会不会关」：
//
// 1. **上限语义**：`budgetLimitUsd: 0` 是「不限」，不是「一分钱都不许花」
//    （注释与实现不符 = 假的，ADR-035 §3.6）。
// 2. **记账与判定**：花费累加进 `budget.spent`；达到上限后判定为耗尽。
// 3. **没测到 ≠ 零**：适配器不报用量时不判定超支 —— 没有数据不等于超支
//    （拦一个可能没超预算的切片，比放过一个真超支的更糟）。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { EventStream } from '../src/core/events/stream.js';
import { BudgetCollector, UNLIMITED_BUDGET } from '../src/core/budget/collector.js';

const TEST_DIR = join(
  tmpdir(),
  `zelto-adr035-budget-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
);
const ZELTO_DIR = join(TEST_DIR, '.zelto');
const EVENTS_DIR = join(ZELTO_DIR, 'events');

/** 写一份只含 budgetLimitUsd 的 config.yaml。 */
async function writeLimit(limit: string): Promise<void> {
  await mkdir(ZELTO_DIR, { recursive: true });
  await writeFile(
    join(ZELTO_DIR, 'config.yaml'),
    `gate:\n  commands:\n    - { name: test, run: "echo ok" }\nbudgetLimitUsd: ${limit}\n`,
    'utf-8',
  );
}

describe('ADR-035 · 预算上限语义', { concurrency: false }, () => {
  let events: EventStream;
  let budget: BudgetCollector;

  before(async () => {
    await mkdir(EVENTS_DIR, { recursive: true });
    events = new EventStream(EVENTS_DIR);
    budget = new BudgetCollector(events, ZELTO_DIR);
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('budgetLimitUsd: 0 表示不限（不是零预算）', async () => {
    await writeLimit('0');
    const limit = await budget.getLimit('unlimited-slice');
    assert.equal(limit, UNLIMITED_BUDGET);
    assert.ok(!Number.isFinite(limit), '不限不该是一个有限的数');
  });

  it('不限时永远不判定超支 —— 花多少都不拦', async () => {
    await writeLimit('0');
    await events.append('unlimited-slice', 'budget.spent', 'zelto', {
      amount: 999, source: 'agent', adapter: 'claude-agent', sessionId: 's1',
    });

    const exhausted = await budget.isExhausted('unlimited-slice');
    assert.equal(exhausted, false, '没有上限就没有闸门');
  });

  it('budgetLimitUsd > 0 是上限', async () => {
    await writeLimit('5.0');
    assert.equal(await budget.getLimit('limited-slice'), 5.0);
  });

  it('缺失配置回落默认 1.0', async () => {
    const noConfig = new BudgetCollector(events, join(TEST_DIR, 'no-such-dir'));
    assert.equal(await noConfig.getLimit('any'), 1.0);
  });
});

describe('ADR-035 · 记账与判定', { concurrency: false }, () => {
  let events: EventStream;
  let budget: BudgetCollector;

  before(async () => {
    await mkdir(EVENTS_DIR, { recursive: true });
    events = new EventStream(EVENTS_DIR);
    budget = new BudgetCollector(events, ZELTO_DIR);
    await writeLimit('1.0');
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('agent 侧记账累加进总额', async () => {
    await events.append('agent-slice', 'budget.spent', 'zelto', {
      amount: 0.4, source: 'agent', adapter: 'claude-agent', sessionId: 's1',
    });
    await events.append('agent-slice', 'budget.spent', 'zelto', {
      amount: 0.3, source: 'agent', adapter: 'claude-agent', sessionId: 's2',
    });

    const spent = await budget.getSpent('agent-slice');
    assert.ok(Math.abs(spent - 0.7) < 1e-9, `累计应为 0.7，实际 ${spent}`);
  });

  it('llm 侧与 agent 侧的花费算在一起（都是这一片花的钱）', async () => {
    await events.append('mixed-slice', 'budget.spent', 'zelto', {
      amount: 0.2, reason: 'llm:deepseek-chat',
    });
    await events.append('mixed-slice', 'budget.spent', 'zelto', {
      amount: 0.9, source: 'agent', adapter: 'claude-agent', sessionId: 's1',
    });

    const spent = await budget.getSpent('mixed-slice');
    assert.ok(Math.abs(spent - 1.1) < 1e-9, `累计应为 1.1，实际 ${spent}`);
  });

  it('达到上限后判定为耗尽', async () => {
    await events.append('exhaust-slice', 'budget.spent', 'zelto', {
      amount: 0.6, source: 'agent', adapter: 'claude-agent', sessionId: 's1',
    });
    assert.equal(await budget.isExhausted('exhaust-slice'), false);

    await events.append('exhaust-slice', 'budget.spent', 'zelto', {
      amount: 0.4, source: 'agent', adapter: 'claude-agent', sessionId: 's2',
    });
    assert.equal(await budget.isExhausted('exhaust-slice'), true);
  });

  it('零花费是有效数据，不是「没测到」', async () => {
    await events.append('zero-slice', 'budget.spent', 'zelto', {
      amount: 0, source: 'agent', adapter: 'claude-agent', sessionId: 's1',
    });

    const spent = await budget.getSpent('zero-slice');
    assert.equal(spent, 0);
    // 零花费不等于超支
    assert.equal(await budget.isExhausted('zero-slice'), false);
  });

  it('没有记账事件的切片花费为 0，不判定超支', async () => {
    assert.equal(await budget.getSpent('no-usage-slice'), 0);
    assert.equal(await budget.isExhausted('no-usage-slice'), false);
  });
});
