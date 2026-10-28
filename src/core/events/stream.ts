// Event stream — append-only, typed events
// See docs/zelto-技术架构.md §5.3

export type EventType =
  | 'slice.state.changed'
  | 'slice.drift_detected'
  | 'spec.drafted'
  | 'spec.checked'
  | 'spec.frozen'
  | 'clarify.question'
  | 'clarify.answer'
  | 'run.started'
  | 'run.resumed'
  | 'run.stalled'
  | 'run.finished'
  | 'run.aborted'
  | 'policy.decision'
  | 'policy.anchor_mismatch'
  | 'gate.executed'
  | 'gate.result'
  | 'gate.retry'
  | 'stall.classified'
  | 'budget.spent'
  | 'llm.called'
  | 'queue.enqueued'
  | 'queue.dequeued'
  | 'sign.requested'
  | 'sign.approved'
  | 'sign.rejected'
  | 'merge.completed'
  | 'sched.admitted'
  | 'sched.blocked'
  | 'merge.stale_base';

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
