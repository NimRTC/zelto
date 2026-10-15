import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AuditTrail } from '../src/core/audit/trail.js';
import { EventStream } from '../src/core/events/stream.js';

const TEST_DIR = join(tmpdir(), `zelto-audit-test-${Date.now()}`);
const EVENTS_DIR = join(TEST_DIR, 'events');

describe('AuditTrail', () => {
  let events: EventStream;
  let audit: AuditTrail;

  before(async () => {
    await mkdir(EVENTS_DIR, { recursive: true });
    events = new EventStream(EVENTS_DIR);
    audit = new AuditTrail(events);

    // Seed events
    await events.append('slice-001', 'slice.state.changed', 'zelto', { from: 'draft', to: 'clarifying' });
    await events.append('slice-001', 'clarify.question', 'zelto', { text: 'Which requirements?' });
    await events.append('slice-001', 'clarify.answer', 'human', { answer: 'Feature spec' });
    await events.append('slice-001', 'slice.state.changed', 'zelto', { from: 'clarifying', to: 'draft' });
    await events.append('slice-001', 'spec.frozen', 'zelto', {});
    await events.append('slice-001', 'run.started', 'zelto', {});
    await events.append('slice-001', 'gate.executed', 'zelto', { commandCount: 2 });
    await events.append('slice-001', 'gate.result', 'zelto', { passed: true, totalDurationMs: 5000 });
    await events.append('slice-001', 'sign.requested', 'zelto', { requestedBy: 'zelto' });
    await events.append('slice-001', 'sign.approved', 'human', {});
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('generates audit entries for a slice', async () => {
    const report = await audit.forSlice('slice-001');
    assert.equal(report.sliceId, 'slice-001');
    assert.equal(report.totalEvents, 10);
    assert.equal(report.entries.length, 10);
  });

  it('summarizes each event type', async () => {
    const report = await audit.forSlice('slice-001');
    const summaries = report.entries.map((e) => e.summary);

    assert.ok(summaries.some((s) => s.includes('State changed')));
    assert.ok(summaries.some((s) => s.includes('Question asked')));
    assert.ok(summaries.some((s) => s.includes('Question answered')));
    assert.ok(summaries.some((s) => s.includes('Spec frozen')));
    assert.ok(summaries.some((s) => s.includes('Run started')));
    assert.ok(summaries.some((s) => s.includes('Gate result')));
    assert.ok(summaries.some((s) => s.includes('Sign requested')));
    assert.ok(summaries.some((s) => s.includes('Sign approved')));
  });

  it('generates human-readable text report', async () => {
    const text = await audit.toText('slice-001');
    assert.ok(text.includes('Audit Trail: slice-001'));
    assert.ok(text.includes('State changed'));
    assert.ok(text.includes('Gate result'));
  });

  it('finds latest event of a type', async () => {
    const latest = await audit.latestEvent('slice-001', 'sign.approved');
    assert.ok(latest);
    assert.equal(latest.type, 'sign.approved');
  });

  it('returns null for missing event type', async () => {
    const latest = await audit.latestEvent('slice-001', 'nonexistent');
    assert.equal(latest, null);
  });
});
