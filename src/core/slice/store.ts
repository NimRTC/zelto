// Slice persistence — read/write .zelto/slices/<id>.json

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { type SliceState, transitionSlice, type SliceEvent } from './state.js';
import type { StallInfo } from '../stall/types.js';

export interface SliceSpec {
  path: string;
  frozenHash: string | null;
  frozenAt: string | null;
}

export interface SliceAcceptance {
  dir: string;
  frozenHash: string | null;
  oracleSrc: 'external' | 'human' | 'model-transcribed' | null;
}

export interface SliceDrift {
  detected: boolean;
  reason: string | null;
  at: string | null;
}

export interface SliceTrace {
  requirements: string[];
  contracts: string[];
  tests: string[];
}

export interface SliceData {
  id: string;
  title: string;
  state: SliceState;
  spec: SliceSpec;
  acceptance: SliceAcceptance;
  baseCommit: string | null;
  drift: SliceDrift;
  trace: SliceTrace;
  traceWaiver: string | null;
  writes: string[];
  runs: string[];
  stall: StallInfo;
  createdAt: string;
  updatedAt: string;
}

export type SliceEventRecord = {
  event: SliceEvent;
  from: SliceState;
  to: SliceState;
  at: string;
  by: string;
};

export class SliceStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private path(id: string): string {
    return join(this.baseDir, `${id}.json`);
  }

  async read(id: string): Promise<SliceData> {
    const content = await readFile(this.path(id), 'utf-8');
    return JSON.parse(content) as SliceData;
  }

  async write(slice: SliceData): Promise<void> {
    const p = this.path(slice.id);
    await mkdir(dirname(p), { recursive: true });
    slice.updatedAt = new Date().toISOString();
    await writeFile(p, JSON.stringify(slice, null, 2), 'utf-8');
  }

  async exists(id: string): Promise<boolean> {
    return existsSync(this.path(id));
  }

  async list(): Promise<string[]> {
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(this.baseDir).catch(() => []);
    return files.filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
  }

  async transit(id: string, event: SliceEvent, by: string = 'system'): Promise<SliceData> {
    const slice = await this.read(id);
    const from = slice.state;
    const to = transitionSlice(from, event);
    slice.state = to;
    slice.updatedAt = new Date().toISOString();
    await this.write(slice);
    return slice;
  }

  create(
    id: string,
    title: string,
    opts?: Partial<Omit<SliceData, 'id' | 'title' | 'state' | 'createdAt' | 'updatedAt'>>,
  ): SliceData {
    const now = new Date().toISOString();
    return {
      id,
      title,
      state: 'draft',
      spec: { path: `specs/slices/${id}.md`, frozenHash: null, frozenAt: null },
      acceptance: { dir: `tests/acceptance/${id}/`, frozenHash: null, oracleSrc: null },
      baseCommit: opts?.baseCommit ?? null,
      drift: { detected: false, reason: null, at: null },
      trace: opts?.trace ?? { requirements: [], contracts: [], tests: [] },
      traceWaiver: opts?.traceWaiver ?? null,
      writes: opts?.writes ?? [],
      runs: opts?.runs ?? [],
      stall: opts?.stall ?? { class: null, autoResolved: 0, gateRetries: 0 },
      createdAt: now,
      updatedAt: now,
    };
  }
}
