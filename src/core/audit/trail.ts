// Audit trail — generates human-readable audit from event streams
// C4: every action writes append-only events — audit reads them

import type { EventStream, EventEnvelope } from '../events/stream.js';

export interface AuditEntry {
  seq: number;
  timestamp: string;
  sliceId: string;
  eventType: string;
  actor: string;
  summary: string;
  details: Record<string, unknown>;
}

export interface AuditReport {
  generatedAt: string;
  sliceId: string;
  entries: AuditEntry[];
  totalEvents: number;
}

const EVENT_SUMMARIES: Record<string, (e: EventEnvelope) => string> = {
  'slice.state.changed': (e) =>
    `State changed: ${String(e.payload?.from ?? '?')} → ${String(e.payload?.to ?? '?')}`,
  'slice.drift_detected': (e) =>
    `Drift detected: ${String(e.payload?.reason ?? 'unknown reason')}`,
  'spec.drafted': () => 'Spec drafted',
  'spec.checked': () => 'Spec checked',
  'spec.frozen': () => 'Spec frozen',
  'clarify.question': (e) =>
    `Question asked: ${String(e.payload?.text ?? '')}`,
  'clarify.answer': (e) =>
    `Question answered: ${String(e.payload?.answer ?? '')}`,
  'run.started': () => 'Run started',
  'run.resumed': () => 'Run resumed',
  'run.stalled': (e) =>
    `Run stalled: ${String(e.payload?.class ?? '')} - ${String(e.payload?.summary ?? '')}`,
  'run.finished': () => 'Run finished',
  'run.aborted': () => 'Run aborted',
  'policy.decision': (e) =>
    `Policy decision: ${String(e.payload?.decision ?? '')} for ${String(e.payload?.path ?? '')}`,
  'policy.anchor_mismatch': () => 'Policy anchor mismatch detected',
  'gate.executed': (e) =>
    `Gate executed: ${String(e.payload?.commandCount ?? '?')} commands`,
  'gate.result': (e) =>
    `Gate result: ${String(e.payload?.passed ? 'PASSED' : 'FAILED')} (${String(e.payload?.totalDurationMs ?? '?')}ms)`,
  'gate.retry': (e) =>
    `Gate retry #${String(e.payload?.attempt ?? '?')} for ${String(e.payload?.command ?? '')}`,
  'stall.classified': (e) =>
    `Stall classified: ${String(e.payload?.class ?? '')}`,
  'budget.spent': (e) =>
    `Budget spent: $${String(e.payload?.amount ?? '0')}`,
  'llm.called': (e) =>
    `LLM called: ${String(e.payload?.model ?? '')} (${String(e.payload?.tokens ?? '?')} tokens)`,
  'queue.enqueued': () => 'Slice enqueued',
  'queue.dequeued': () => 'Slice dequeued',
  'sign.requested': (e) =>
    `Sign requested by ${String(e.payload?.requestedBy ?? '')}`,
  'sign.approved': () => 'Sign approved',
  'sign.rejected': () => 'Sign rejected',
  'merge.completed': () => 'Merge completed',
  'sched.admitted': () => 'Scheduled: admitted',
  'sched.blocked': (e) =>
    `Scheduled: blocked by ${String(Array.isArray(e.payload?.blockedBy) ? (e.payload.blockedBy as string[]).join(', ') : '?')}`,
  'merge.stale_base': () => 'Merge blocked: stale base',
};

export class AuditTrail {
  private readonly events: EventStream;

  constructor(events: EventStream) {
    this.events = events;
  }

  /**
   * Generate audit trail for a single slice.
   */
  async forSlice(sliceId: string): Promise<AuditReport> {
    const raw = await this.events.read(sliceId);
    const entries: AuditEntry[] = [];

    for (const evt of raw) {
      const summarizer = EVENT_SUMMARIES[evt.type];
      const summary = summarizer ? summarizer(evt) : `Event: ${evt.type}`;

      entries.push({
        seq: evt.runSeq,
        timestamp: evt.ts,
        sliceId: evt.slice,
        eventType: evt.type,
        actor: evt.actor,
        summary,
        details: evt.payload,
      });
    }

    return {
      generatedAt: new Date().toISOString(),
      sliceId,
      entries,
      totalEvents: raw.length,
    };
  }

  /**
   * Generate a human-readable text report.
   */
  async toText(sliceId: string): Promise<string> {
    const report = await this.forSlice(sliceId);
    const lines: string[] = [];

    lines.push(`Audit Trail: ${report.sliceId}`);
    lines.push(`Generated: ${report.generatedAt}`);
    lines.push(`Total events: ${report.totalEvents}`);
    lines.push('');

    for (const entry of report.entries) {
      const time = entry.timestamp.slice(11, 19); // HH:MM:SS
      lines.push(`  ${time}  [${entry.eventType.padEnd(22)}] ${entry.summary}`);
    }

    return lines.join('\n');
  }

  /**
   * Get the latest event of a given type for a slice.
   */
  async latestEvent(sliceId: string, eventType: string): Promise<EventEnvelope | null> {
    const raw = await this.events.read(sliceId);
    const matched = raw.filter((e) => e.type === eventType);
    return matched.length > 0 ? matched[matched.length - 1] : null;
  }
}
