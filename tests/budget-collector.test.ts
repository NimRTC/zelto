import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { EventStream } from '../src/core/events/stream.js';
import { BudgetCollector } from '../src/core/budget/collector.js';

const TEST_DIR = join(
  tmpdir(),
  `zelto-budget-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
);
const EVENTS_DIR = join(TEST_DIR, 'events');

describe('BudgetCollector', { concurrency: false }, () => {
  let events: EventStream;
  let budget: BudgetCollector;

  before(async () => {
    await mkdir(EVENTS_DIR, { recursive: true });
    events = new EventStream(EVENTS_DIR);
    budget = new BudgetCollector(events);
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('returns 0 for a slice with no events', async () => {
    const spent = await budget.getSpent('no-events-slice');
    assert.equal(spent, 0);
  });

  it('sums budget.spent events with amount field', async () => {
    await events.append('llm-slice', 'budget.spent', 'system', {
      amount: 0.15,
    });
    await events.append('llm-slice', 'budget.spent', 'system', {
      amount: 0.03,
    });

    const spent = await budget.getSpent('llm-slice');
    assert.equal(spent, 0.18);
  });

  it('sums budget.spent events', async () => {
    await events.append('budget-slice', 'budget.spent', 'system', {
      amount: 0.50,
    });
    await events.append('budget-slice', 'budget.spent', 'system', {
      amount: 0.25,
    });

    const spent = await budget.getSpent('budget-slice');
    assert.equal(spent, 0.75);
  });

  it('combines multiple budget.spent events', async () => {
    await events.append('combined-slice', 'budget.spent', 'system', { amount: 0.10 });
    await events.append('combined-slice', 'budget.spent', 'system', { amount: 0.20 });

    const spent = await budget.getSpent('combined-slice');
    assert.equal(Math.round(spent * 100), 30);
  });

  it('returns default limit when no config exists', async () => {
    // No .zelto/config.yaml in TEST_DIR, so should return default
    const limit = await budget.getLimit('any-slice');
    assert.equal(limit, 1.0);
  });

  it('reads limit from config.yaml', async () => {
    const configDir = join(TEST_DIR, '.zelto');
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, 'config.yaml'),
      'gate:\n  commands:\n    - { name: test, run: "echo ok" }\nbudgetLimitUsd: 5.0\n',
      'utf-8',
    );

    // Pass the .zelto dir so it finds the config
    const budgetWithDir = new BudgetCollector(events, join(TEST_DIR, '.zelto'));
    const limit = await budgetWithDir.getLimit('test-slice');
    assert.equal(limit, 5.0);
  });

  it('isExhausted returns true when spent >= limit', async () => {
    // With limit 5.0 and spent 0.30 so far, should not be exhausted
    const notExhausted = await budget.isExhausted('combined-slice');
    assert.equal(notExhausted, false);

    // Add enough to exceed limit
    await events.append('combined-slice', 'budget.spent', 'system', { amount: 5.0 });

    const exhausted = await budget.isExhausted('combined-slice');
    assert.equal(exhausted, true);
  });

  it('handles amount in string format', async () => {
    await events.append('string-cost-slice', 'budget.spent', 'system', {
      amount: '0.42',
    });

    const spent = await budget.getSpent('string-cost-slice');
    assert.equal(spent, 0.42);
  });

  it('ignores non-budget events', async () => {
    await events.append('other-slice', 'run.started', 'agent', {});
    await events.append('other-slice', 'spec.drafted', 'cli', {});
    await events.append('other-slice', 'sign.approved', 'human', {});

    const spent = await budget.getSpent('other-slice');
    assert.equal(spent, 0);
  });

  it('ignores non-budget events without amount', async () => {
    await events.append('no-cost-slice', 'llm.called', 'agent', {
      model: 'claude-sonnet-4',
      tokens: 100,
    });

    const spent = await budget.getSpent('no-cost-slice');
    assert.equal(spent, 0);
  });
});

// ─── 三态：未记账 / 未测到 / 测到了 ─────────────────────────────────────────
//
// ADR-035 §3.5 的同一原则：「测到 0」与「没测到」严格分开。
// 回填（scripts/backfill-cost.mjs）会给那些 agent 没报出用量的切片
// 补一条 `measured: false` 的标记 —— 它们**不是**「压根没核查」，
// 也不该显示成「$0.0000（真的没花钱）」。

describe('BudgetCollector · 成本的三态', { concurrency: false }, () => {
  let events: EventStream;
  let budget: BudgetCollector;

  before(async () => {
    await mkdir(EVENTS_DIR, { recursive: true });
    events = new EventStream(EVENTS_DIR);
    budget = new BudgetCollector(events);
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('一条成本事件都没有 → unmeasured（压根没核查）', async () => {
    const d = await budget.getSpentDetail('tri-never-checked');
    assert.equal(d.measurement, 'unmeasured');
    assert.equal(d.measured, false);
    assert.equal(d.spent, 0);
  });

  it('有 budget.spent（measured 未标 false）→ measured', async () => {
    await events.append('tri-normal', 'budget.spent', 'zelto', { amount: 0.25 });
    const d = await budget.getSpentDetail('tri-normal');
    assert.equal(d.measurement, 'measured');
    assert.equal(d.measured, true);
    assert.equal(d.spent, 0.25);
  });

  it('测到 0 也是 measured（真的没花钱 ≠ 没测到）', async () => {
    await events.append('tri-zero-cost', 'budget.spent', 'zelto', { amount: 0 });
    const d = await budget.getSpentDetail('tri-zero-cost');
    assert.equal(d.measurement, 'measured', '0 是有效数据，不能退回未测到');
    assert.equal(d.measured, true);
    assert.equal(d.spent, 0);
  });

  it('measured: false 的标记 → unavailable（核查过但拿不到金额）', async () => {
    await events.append('tri-unavailable', 'budget.spent', 'zelto', {
      amount: 0,
      measured: false,
      reason: 'agent 未报出用量',
    });
    const d = await budget.getSpentDetail('tri-unavailable');
    assert.equal(d.measurement, 'unavailable');
    assert.equal(d.measured, false, '拿不到金额不算「测到了」');
    assert.equal(d.spent, 0, '金额 0 不该被算进总额');
  });

  it('unavailable 标记不覆盖真实金额（两者可以共存）', async () => {
    await events.append('tri-mixed', 'budget.spent', 'zelto', { amount: 1.5 });
    await events.append('tri-mixed', 'budget.spent', 'zelto', {
      amount: 0,
      measured: false,
    });
    const d = await budget.getSpentDetail('tri-mixed');
    assert.equal(d.measurement, 'measured');
    assert.equal(d.spent, 1.5, '真实金额不能被标记事件抹掉');
  });

  it('llm.called 也是证据 → measured', async () => {
    await events.append('tri-llm', 'llm.called', 'zelto', { model: 'm', tokens: 10 });
    const d = await budget.getSpentDetail('tri-llm');
    assert.equal(d.measurement, 'measured');
    assert.equal(d.measured, true);
  });
});
