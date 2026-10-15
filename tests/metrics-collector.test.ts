import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { MetricsCollector } from '../src/core/metrics/collector.js';
import { EventStream } from '../src/core/events/stream.js';

const TEST_DIR = join(tmpdir(), `zelto-metrics-test-${Date.now()}`);
const EVENTS_DIR = join(TEST_DIR, 'events');

describe('MetricsCollector', () => {
  let events: EventStream;
  let collector: MetricsCollector;

  before(async () => {
    await mkdir(EVENTS_DIR, { recursive: true });
    events = new EventStream(EVENTS_DIR);
    collector = new MetricsCollector(events);

    // Seed some events
    await events.append('slice-001', 'gate.executed', 'zelto', { commandCount: 2 });
    await events.append('slice-001', 'gate.result', 'zelto', { passed: true });
    await events.append('slice-001', 'gate.executed', 'zelto', { commandCount: 2 });
    await events.append('slice-001', 'gate.retry', 'zelto', { attempt: 1 });
    await events.append('slice-001', 'gate.result', 'zelto', { passed: true });
    await events.append('slice-001', 'stall.classified', 'zelto', { class: 'environment_failure' });
    await events.append('slice-001', 'stall.classified', 'zelto', { class: 'budget_exhausted' });
    await events.append('slice-001', 'sign.requested', 'zelto', {});
    await events.append('slice-001', 'sign.approved', 'human', {});
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('counts events by type', async () => {
    const count = await collector.countEvents('slice-001', ['gate.executed']);
    assert.equal(count, 2);
  });

  it('calculates rework rate', async () => {
    const rate = await collector.reworkRate('slice-001');
    assert.ok(rate);
    assert.equal(rate.name, 'rework_rate');
    assert.equal(rate.unit, 'ratio');
    assert.ok(rate.value > 0);
  });

  it('calculates cycle time', async () => {
    const cycle = await collector.cycleTime('slice-001');
    assert.ok(cycle);
    assert.equal(cycle.name, 'cycle_time');
    assert.equal(cycle.unit, 'seconds');
  });

  it('counts stalls by class', async () => {
    const stalls = await collector.stallCounts('slice-001');
    assert.equal(stalls.name, 'stall_counts');
    assert.equal(stalls.dimensions?.environment_failure, '1');
    assert.equal(stalls.dimensions?.budget_exhausted, '1');
  });

  it('generates full report', async () => {
    const report = await collector.generateReport(['slice-001']);
    assert.ok(report.metrics.length >= 3);
    assert.equal(report.sliceCount, 1);
    assert.equal(report.eventCount, 9);
  });
});
