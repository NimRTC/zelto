// Sign manager — sign request lifecycle
// See docs/zelto-技术架构.md §7.1

import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { EventStream, EventType } from '../events/stream.js';
import type { SliceStore } from '../slice/store.js';

export interface SignRequest {
  id: string;
  sliceId: string;
  requestedAt: string;
  requestedBy: string;
  status: 'pending' | 'approved' | 'rejected';
  decidedAt: string | null;
  decidedBy: string | null;
  comment: string | null;
}

export class SignManager {
  private readonly locksDir: string;
  private readonly events: EventStream;
  private readonly store: SliceStore;

  constructor(baseDir: string, events: EventStream, store: SliceStore) {
    this.locksDir = join(baseDir, 'locks');
    this.events = events;
    this.store = store;
  }

  private path(id: string): string {
    return join(this.locksDir, `${id}.json`);
  }

  async request(sliceId: string, requestedBy: string = 'zelto'): Promise<SignRequest> {
    await mkdir(this.locksDir, { recursive: true });

    const id = `sign-${sliceId}-${Date.now()}`;
    const req: SignRequest = {
      id,
      sliceId,
      requestedAt: new Date().toISOString(),
      requestedBy,
      status: 'pending',
      decidedAt: null,
      decidedBy: null,
      comment: null,
    };

    await writeFile(this.path(id), JSON.stringify(req, null, 2), 'utf-8');

    await this.appendEvent(sliceId, 'sign.requested', requestedBy, {
      signId: id,
      sliceId,
    });

    return req;
  }

  async approve(id: string, decidedBy: string = 'human', comment: string | null = null): Promise<SignRequest> {
    const req = await this.get(id);
    if (req.status !== 'pending') {
      throw new Error(`Sign request ${id} is already ${req.status}`);
    }

    req.status = 'approved';
    req.decidedAt = new Date().toISOString();
    req.decidedBy = decidedBy;
    req.comment = comment;

    await writeFile(this.path(id), JSON.stringify(req, null, 2), 'utf-8');

    await this.appendEvent(req.sliceId, 'sign.approved', decidedBy, {
      signId: id,
      sliceId: req.sliceId,
      comment,
    });

    // Transition slice state
    try {
      const slice = await this.store.read(req.sliceId);
      const prevState = slice.state;
      await this.store.transit(req.sliceId, 'SIGN_APPROVE');
      await this.appendEvent(req.sliceId, 'slice.state.changed', decidedBy, {
        sliceId: req.sliceId,
        from: prevState,
        to: 'completed',
        event: 'SIGN_APPROVE',
      });
    } catch {
      // Non-fatal: slice may already be in completed state
    }

    return req;
  }

  async reject(id: string, decidedBy: string = 'human', comment: string | null = null): Promise<SignRequest> {
    const req = await this.get(id);
    if (req.status !== 'pending') {
      throw new Error(`Sign request ${id} is already ${req.status}`);
    }

    req.status = 'rejected';
    req.decidedAt = new Date().toISOString();
    req.decidedBy = decidedBy;
    req.comment = comment;

    await writeFile(this.path(id), JSON.stringify(req, null, 2), 'utf-8');

    await this.appendEvent(req.sliceId, 'sign.rejected', decidedBy, {
      signId: id,
      sliceId: req.sliceId,
      comment,
    });

    // Transition slice state to abandoned
    try {
      const slice = await this.store.read(req.sliceId);
      const prevState = slice.state;
      await this.store.transit(req.sliceId, 'SIGN_REJECT');
      await this.appendEvent(req.sliceId, 'slice.state.changed', decidedBy, {
        sliceId: req.sliceId,
        from: prevState,
        to: 'abandoned',
        event: 'SIGN_REJECT',
      });
    } catch {
      // Non-fatal: slice may not be in completed state
    }

    return req;
  }

  async get(id: string): Promise<SignRequest> {
    const content = await readFile(this.path(id), 'utf-8');
    return JSON.parse(content) as SignRequest;
  }

  async list(status?: SignRequest['status']): Promise<SignRequest[]> {
    try {
      const files = await readdir(this.locksDir);
      const requests: SignRequest[] = [];

      for (const file of files) {
        if (!file.endsWith('.json') || !file.startsWith('sign-')) continue;
        try {
          const content = await readFile(join(this.locksDir, file), 'utf-8');
          const req = JSON.parse(content) as SignRequest;
          if (!status || req.status === status) {
            requests.push(req);
          }
        } catch {
          // Skip malformed files
        }
      }

      return requests.sort(
        (a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime(),
      );
    } catch {
      return [];
    }
  }

  async delete(id: string): Promise<void> {
    const p = this.path(id);
    if (existsSync(p)) {
      await unlink(p);
    }
  }

  private async appendEvent(
    sliceId: string,
    type: EventType,
    actor: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.events.append(sliceId, type, actor, payload);
    } catch {
      // Event stream failure is non-fatal for sign operations
    }
  }
}
