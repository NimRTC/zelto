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

  it('sums llm.called cost events', async () => {
    await events.append('llm-slice', 'llm.called', 'agent', {
      model: 'claude-sonnet-4',
      tokens: 500,
      cost: 0.15,
    });
    await events.append('llm-slice', 'llm.called', 'agent', {
      model: 'claude-haiku-4',
      tokens: 200,
      cost: 0.03,
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

  it('combines llm.called and budget.spent', async () => {
    await events.append('combined-slice', 'llm.called', 'agent', { cost: 0.10 });
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

  it('handles cost in string format', async () => {
    await events.append('string-cost-slice', 'llm.called', 'agent', {
      cost: '0.42',
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

  it('ignores llm.called without cost field', async () => {
    await events.append('no-cost-slice', 'llm.called', 'agent', {
      model: 'claude-sonnet-4',
      tokens: 100,
    });

    const spent = await budget.getSpent('no-cost-slice');
    assert.equal(spent, 0);
  });
});
