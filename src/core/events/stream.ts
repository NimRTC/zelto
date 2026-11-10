// Event stream — append-only, typed events
// See docs/zelto-技术架构.md §5.3

/**
 * 全部事件类型。
 *
 * 为什么是「一个数组 + 一个派生类型」而不是「一个手写的联合类型」：
 * 事件类型是契约（`contracts/schemas/event-envelope.json` 的 enum 是真源），
 * 这份清单要同时被三处使用 ——
 *
 * 1. `EventType` 联合类型（派生自它，编译期给全链路类型检查）；
 * 2. 审计摘要表 `core/audit/trail.ts`（键类型是 `Record<EventType, ...>`，
 *    少写一种事件就**编译不过**，不必等到运行时才发现审计退化成 `Event: X`）；
 * 3. 契约一致性测试（枚举它，与 schema 的 enum 对账）。
 *
 * 以前它是一个手写的联合类型，于是加事件类型的人只改联合类型，
 * schema 与摘要表就悄悄漂移 —— ADR-036 加的 4 个事件类型从未进过 schema enum，
 * 直到这次补齐才发现「代码能发、契约不认」。
 * 改成数组派生之后，漂移在编译期或测试期就会暴露。
 */
export const EVENT_TYPES = [
  'slice.state.changed',
  'slice.baseline_registered',
  'slice.drift_detected',
  'slice.hotfix',
  'project.policy_migrated',
  'spec.drafted',
  'spec.checked',
  'spec.frozen',
  'clarify.question',
  'clarify.answer',
  'run.started',
  'run.resumed',
  'run.stalled',
  'run.finished',
  'run.aborted',
  'policy.decision',
  'policy.anchor_mismatch',
  'policy.violation',
  'reservation.acquired',
  'reservation.released',
  'gate.executed',
  'gate.result',
  'gate.retry',
  'stall.classified',
  'question.raised',
  'question.answered',
  'budget.spent',
  'llm.called',
  'queue.enqueued',
  'queue.dequeued',
  'sign.requested',
  'sign.approved',
  'sign.rejected',
  'sign.revoked',
  'batch.halted',
  'merge.completed',
  'merge.planned',
  'merge.phase_complete',
  'merge.conflict',
  'merge.stale_base',
  'sched.admitted',
  'sched.blocked',
  'worktree.created',
  'worktree.removed',
  'coord.dep_added',
  'coord.phase_ready',
  'coord.phase_complete',
  'coord.cycle_detected',
  'artifact.conflict_detected',
  'version.accepted',
  'version.delivered',
  'draft.created',
  'draft.revised',
  'draft.confirmed',
  'contract.evolution_checked',
  'contract.baseline_updated',
  'version.regression_recorded',
  'version.regression_detected',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface EventEnvelope {
  ts: string;
  runSeq: number;
  slice: string;
  run: string | null;
  type: EventType;
  actor: string;
  payload: Record<string, unknown>;
}

export class EventStream {
  private readonly baseDir: string;
  private seq: number = 0;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    // Restore last sequence number from existing files to survive restarts
    this.restoreSeq().catch(() => { /* non-fatal */ });
  }

  private async restoreSeq(): Promise<void> {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    try {
      const entries = await readdir(this.baseDir, { withFileTypes: true });
      let maxSeq = 0;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const eventFile = join(this.baseDir, entry.name, 'events.jsonl');
        try {
          const content = await readFile(eventFile, 'utf-8');
          const trimmed = content.trimEnd();
          const lastNewline = trimmed.lastIndexOf('\n');
          const lastLine = lastNewline >= 0 ? trimmed.slice(lastNewline + 1) : trimmed;
          if (lastLine) {
            const last = JSON.parse(lastLine);
            if (typeof last.runSeq === 'number' && last.runSeq > maxSeq) {
              maxSeq = last.runSeq;
            }
          }
        } catch {
          // Skip unreadable files
        }
      }
      if (maxSeq > 0) {
        this.seq = maxSeq + 1;
      }
    } catch {
      // Directory may not exist yet
    }
  }

  async append(sliceId: string, type: EventType, actor: string, payload: Record<string, unknown>, runId: string | null = null): Promise<EventEnvelope> {
    const { mkdir, appendFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    this.seq++;
    const event: EventEnvelope = {
      ts: new Date().toISOString(),
      runSeq: this.seq,
      slice: sliceId,
      run: runId,
      type,
      actor,
      payload,
    };

    const dir = join(this.baseDir, sliceId);
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, 'events.jsonl'), JSON.stringify(event) + '\n', 'utf-8');

    return event;
  }

  async read(sliceId: string): Promise<EventEnvelope[]> {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    try {
      const content = await readFile(join(this.baseDir, sliceId, 'events.jsonl'), 'utf-8');
      return content
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as EventEnvelope;
          } catch {
            return null;
          }
        })
        .filter((e): e is EventEnvelope => e !== null);
    } catch {
      return [];
    }
  }
}
