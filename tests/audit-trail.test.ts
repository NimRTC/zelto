import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AuditTrail } from '../src/core/audit/trail.js';
import { EventStream, type EventType } from '../src/core/events/stream.js';

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

  // 每种事件类型都要有专属摘要 —— 否则审计报告会退化成
  // 泛泛的「Event: <type>」，可读性下降、事后追责困难。
  // 这个不变式随事件类型增减自动生效（EventType 是联合类型，编译期会检查）。
  it('every event type has a dedicated summary', async () => {
    const eventTypes: EventType[] = [
      'slice.state.changed', 'slice.drift_detected', 'slice.hotfix',
      'spec.drafted', 'spec.checked', 'spec.frozen',
      'clarify.question', 'clarify.answer',
      'run.started', 'run.resumed', 'run.stalled', 'run.finished', 'run.aborted',
      'policy.decision', 'policy.anchor_mismatch', 'policy.violation',
      'reservation.acquired', 'reservation.released',
      'gate.executed', 'gate.result', 'gate.retry',
      'stall.classified',
      'question.raised', 'question.answered',
      'budget.spent', 'llm.called',
      'queue.enqueued', 'queue.dequeued',
      'sign.requested', 'sign.approved', 'sign.rejected', 'sign.revoked',
      'batch.halted',
      'merge.completed', 'merge.planned', 'merge.phase_complete', 'merge.conflict', 'merge.stale_base',
      'sched.admitted', 'sched.blocked',
      'worktree.created', 'worktree.removed',
      'coord.dep_added', 'coord.phase_ready', 'coord.phase_complete', 'coord.cycle_detected',
      'artifact.conflict_detected',
      'version.accepted', 'version.delivered',
      'draft.created', 'draft.revised', 'draft.confirmed',
    ];

    // 逐个写入并检查摘要不是泛用的兜底文本
    for (const type of eventTypes) {
      const sliceId = `cover-${type}`;
      await events.append(sliceId, type, 'zelto', {
        kind: 'requirement',
        id: 'req-1',
        title: '样例',
        from: 'draft',
        to: 'confirmed',
        decision: 'allow',
        path: 'src/a.ts',
        requestedBy: 'zelto',
        revokedBy: 'human',
        reason: '样例',
        feedback: '样例反馈',
        version: 'v1',
        phase: 1,
        stage: 'running',
        strategy: 'sequential',
        files: ['a.ts'],
        slices: ['s1'],
        versions: ['v1'],
        cycle: ['a', 'b'],
        blockedBy: ['s0'],
        commandCount: 1,
        passed: true,
        totalDurationMs: 1,
        count: 1,
        class: 'environment',
        summary: '样例',
        text: '样例',
        answer: '样例',
        type: 'question',
        question: '样例',
        model: 'm',
        tokens: 1,
        amount: 1,
        operation: 'write',
        elapsed: 1,
        note: '样例',
        reason_text: '样例',
        attempt: 1,
        command: 'npm test',
        sliceId: 's1',
        dependsOn: ['s0'],
        phase_ids: [1],
        sliceIds: ['s1'],
        pathEscape: false,
        tampered: [],
        violations: [],
        error: '',
      });

      const report = await audit.forSlice(sliceId);
      const entry = report.entries[0];
      assert.ok(entry, `${type} 应该有审计条目`);
      assert.notEqual(
        entry.summary,
        `Event: ${type}`,
        `事件类型 "${type}" 缺少专属摘要，退化成了兜底文本`,
      );
    }
  });
});
