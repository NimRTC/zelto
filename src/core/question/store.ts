// Question queue — file-backed pending-question store
//
// C1: state lives in files only (`.zelto/questions/<id>.json`).
// C2/C6: Node built-ins only; no adapter imports.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { severityForType } from './protocol.js';
import type { ParsedQuestion, QuestionRecord, QuestionStatus } from './types.js';

export interface QuestionStoreOptions {
  /** Directory holding the question files (default `.zelto/questions`) */
  baseDir: string;
}

export class QuestionStore {
  private readonly baseDir: string;

  constructor(options: QuestionStoreOptions) {
    this.baseDir = options.baseDir;
  }

  private path(id: string): string {
    return join(this.baseDir, `${id}.json`);
  }

  /** Build the id for a new question. Deterministic given slice + timestamp. */
  static makeId(sliceId: string, timestamp: number = Date.now()): string {
    return `q-${sliceId}-${timestamp}`;
  }

  async write(record: QuestionRecord): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    await writeFile(this.path(record.id), JSON.stringify(record, null, 2), 'utf-8');
  }

  async read(id: string): Promise<QuestionRecord | null> {
    try {
      const content = await readFile(this.path(id), 'utf-8');
      return JSON.parse(content) as QuestionRecord;
    } catch {
      return null;
    }
  }

  async list(): Promise<QuestionRecord[]> {
    if (!existsSync(this.baseDir)) return [];
    let files: string[];
    try {
      files = await readdir(this.baseDir);
    } catch {
      return [];
    }
    const records: QuestionRecord[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const record = await this.read(file.slice(0, -5));
      if (record) records.push(record);
    }
    return records.sort((a, b) => a.askedAt.localeCompare(b.askedAt));
  }

  async listByStatus(status: QuestionStatus): Promise<QuestionRecord[]> {
    return (await this.list()).filter((r) => r.status === status);
  }

  async listBySlice(sliceId: string): Promise<QuestionRecord[]> {
    return (await this.list()).filter((r) => r.sliceId === sliceId);
  }

  async listPending(sliceId?: string): Promise<QuestionRecord[]> {
    const pending = await this.listByStatus('pending');
    return sliceId ? pending.filter((r) => r.sliceId === sliceId) : pending;
  }

  /**
   * Record a question raised by an agent.
   * Severity is derived from the type by the fixed table — never self-reported.
   */
  async raise(input: {
    sliceId: string;
    parsed: ParsedQuestion;
    zeltoSessionId: string | null;
    agentSessionId: string | null;
    adapterName?: string | null;
    id?: string;
    askedAt?: string;
  }): Promise<QuestionRecord> {
    const askedAt = input.askedAt ?? new Date().toISOString();
    const record: QuestionRecord = {
      id: input.id ?? QuestionStore.makeId(input.sliceId),
      sliceId: input.sliceId,
      type: input.parsed.type,
      severity: severityForType(input.parsed.type),
      question: input.parsed.question,
      options: input.parsed.options,
      status: 'pending',
      askedAt,
      answeredAt: null,
      answer: null,
      zeltoSessionId: input.zeltoSessionId,
      agentSessionId: input.agentSessionId,
      adapterName: input.adapterName ?? null,
    };
    await this.write(record);
    return record;
  }

  /**
   * Mark a question answered. Returns null when the question does not exist
   * or has already been answered.
   */
  async answer(id: string, answer: string, answeredAt?: string): Promise<QuestionRecord | null> {
    const record = await this.read(id);
    if (!record || record.status === 'answered') return null;
    record.status = 'answered';
    record.answer = answer;
    record.answeredAt = answeredAt ?? new Date().toISOString();
    await this.write(record);
    return record;
  }
}
