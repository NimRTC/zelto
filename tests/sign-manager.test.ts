import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SignManager, type SignRequest } from '../src/core/gate/sign.js';
import { EventStream, type EventEnvelope } from '../src/core/events/stream.js';

const TEST_DIR = join(tmpdir(), `zelto-sign-test-${Date.now()}`);
const EVENTS_DIR = join(TEST_DIR, 'events');

describe('SignManager', () => {
  let events: EventStream;
  let manager: SignManager;

  before(async () => {
    await mkdir(EVENTS_DIR, { recursive: true });
    events = new EventStream(EVENTS_DIR);
    manager = new SignManager(TEST_DIR, events);
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('creates a sign request', async () => {
    const req = await manager.request('slice-001', 'zelto');
    assert.equal(req.sliceId, 'slice-001');
    assert.equal(req.status, 'pending');
    assert.equal(req.requestedBy, 'zelto');
    assert.ok(req.id.startsWith('sign-'));
  });

  it('lists pending requests', async () => {
    const pending = await manager.list('pending');
    assert.ok(pending.length >= 1);
    assert.ok(pending.some((r: SignRequest) => r.sliceId === 'slice-001'));
  });

  it('approves a sign request', async () => {
    const req = await manager.request('slice-002', 'agent');
    const approved = await manager.approve(req.id, 'human', 'Looks good');
    assert.equal(approved.status, 'approved');
    assert.equal(approved.decidedBy, 'human');
    assert.equal(approved.comment, 'Looks good');
  });

  it('rejects a sign request', async () => {
    const req = await manager.request('slice-003', 'agent');
    const rejected = await manager.reject(req.id, 'human', 'Needs more tests');
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.decidedBy, 'human');
    assert.equal(rejected.comment, 'Needs more tests');
  });

  it('rejects approval of already-decided request', async () => {
    const req = await manager.request('slice-004', 'agent');
    await manager.approve(req.id, 'human');
    await assert.rejects(
      () => manager.approve(req.id, 'human'),
      /already approved/,
    );
  });

  it('filters list by status', async () => {
    const pending = await manager.list('pending');
    const approved = await manager.list('approved');
    const rejected = await manager.list('rejected');

    assert.ok(pending.every((r: SignRequest) => r.status === 'pending'));
    assert.ok(approved.every((r: SignRequest) => r.status === 'approved'));
    assert.ok(rejected.every((r: SignRequest) => r.status === 'rejected'));
  });

  it('emits sign events', async () => {
    const req = await manager.request('slice-005', 'agent');
    await manager.approve(req.id, 'human');

    const evts = await events.read('slice-005');
    const types = evts.map((e: EventEnvelope) => e.type);
    assert.ok(types.includes('sign.requested'));
    assert.ok(types.includes('sign.approved'));
  });
});
