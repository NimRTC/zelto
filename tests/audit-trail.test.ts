import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AuditTrail } from '../src/core/audit/trail.js';
import { EventStream, EVENT_TYPES, type EventType } from '../src/core/events/stream.js';

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
  //
  // 清单从 `EVENT_TYPES` 取，不手写：手写的那份曾经漏掉了 5 种事件
  // （ADR-036 加的 4 种 + 基线登记 1 种），于是「每种事件都有摘要」
  // 这条不变式在测试里也是假的。现在它由三层保证 ——
  // 运行时数组（可枚举）、`Record<EventType, ...>`（少一种编译不过）、
  // 以及 `tests/event-contract-parity.test.ts` 的三方对账。
  it('every event type has a dedicated summary', async () => {
    const eventTypes: EventType[] = [...EVENT_TYPES];

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
        // 基线登记 / 契约演进 / 版本回归这几类事件用到的字段
        module: 'src/core',
        fileCount: 3,
        writes: ['src/core/**'],
        contracts: ['a.json'],
        breaking: 0,
        tests: 1,
        regressed: 0,
        degraded: 0,
        missing: 0,
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
