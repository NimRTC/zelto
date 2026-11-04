import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SignManager, type SignRequest } from '../src/core/gate/sign.js';
import { EventStream, type EventEnvelope } from '../src/core/events/stream.js';
import { SliceStore } from '../src/core/slice/store.js';

const TEST_DIR = join(tmpdir(), `zelto-sign-test-${Date.now()}`);
const EVENTS_DIR = join(TEST_DIR, 'events');
const SLICES_DIR = join(TEST_DIR, 'slices');
const LOCKS_DIR = join(TEST_DIR, 'locks');

describe('SignManager', () => {
  let events: EventStream;
  let store: SliceStore;
  let manager: SignManager;

  before(async () => {
    await mkdir(EVENTS_DIR, { recursive: true });
    await mkdir(SLICES_DIR, { recursive: true });
    await mkdir(LOCKS_DIR, { recursive: true });
    events = new EventStream(EVENTS_DIR);
    store = new SliceStore(SLICES_DIR);
    manager = new SignManager(TEST_DIR, events, store);
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

  it('revokes an approved sign request', async () => {
    const req = await manager.request('slice-006', 'agent');
    await manager.approve(req.id, 'human', 'Approved too early');
    const revoked = await manager.revoke(req.id, 'human', 'Signed the wrong slice');

    assert.equal(revoked.status, 'revoked');
    assert.equal(revoked.decidedBy, 'human');
    assert.equal(revoked.comment, 'Signed the wrong slice');
  });

  it('refuses to revoke a request that is not approved', async () => {
    const req = await manager.request('slice-007', 'agent');
    await assert.rejects(
      () => manager.revoke(req.id, 'human'),
      /only "approved" can be revoked/,
    );

    await manager.approve(req.id, 'human');
    await manager.revoke(req.id, 'human');
    await assert.rejects(
      () => manager.revoke(req.id, 'human'),
      /only "approved" can be revoked/,
    );
  });

  it('keeps the slice completed when a sign is revoked', async () => {
    const slice = store.create('sign-revoke-test', 'Sign Revoke Test');
    slice.state = 'frozen';
    slice.spec.frozenHash = 'sha256:test';
    slice.spec.frozenAt = new Date().toISOString();
    await store.write(slice);

    await store.transit('sign-revoke-test', 'GATE_PASS');

    const req = await manager.request('sign-revoke-test', 'agent');
    await manager.approve(req.id, 'human');
    await manager.revoke(req.id, 'human', 'Misread the diff');

    const updated = await store.read('sign-revoke-test');
    assert.equal(updated.state, 'completed');
  });

  it('emits sign.revoked and drops the request from the approved list', async () => {
    const req = await manager.request('slice-008', 'agent');
    await manager.approve(req.id, 'human');
    await manager.revoke(req.id, 'human', 'Sign revoked');

    const evts = await events.read('slice-008');
    const types = evts.map((e: EventEnvelope) => e.type);
    assert.ok(types.includes('sign.revoked'));

    const approved = await manager.list('approved');
    assert.ok(!approved.some((r: SignRequest) => r.id === req.id));

    const revoked = await manager.list('revoked');
    assert.ok(revoked.some((r: SignRequest) => r.id === req.id));
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

  it('transitions slice to completed on approve', async () => {
    // Create a slice and set it up for sign
    const slice = store.create('sign-approve-test', 'Sign Approve Test');
    slice.state = 'frozen';
    slice.spec.frozenHash = 'sha256:test';
    slice.spec.frozenAt = new Date().toISOString();
    await store.write(slice);

    // Transition through gate to completed
    await store.transit('sign-approve-test', 'GATE_PASS');

    // Now approve
    const req = await manager.request('sign-approve-test', 'agent');
    await manager.approve(req.id, 'human');

    const updated = await store.read('sign-approve-test');
    assert.equal(updated.state, 'completed');
  });

  it('transitions slice to abandoned on reject', async () => {
    const slice = store.create('sign-reject-test', 'Sign Reject Test');
    slice.state = 'frozen';
    slice.spec.frozenHash = 'sha256:test';
    slice.spec.frozenAt = new Date().toISOString();
    await store.write(slice);

    // Transition through gate to completed
    await store.transit('sign-reject-test', 'GATE_PASS');

    // Now reject
    const req = await manager.request('sign-reject-test', 'agent');
    await manager.reject(req.id, 'human', 'Needs rework');

    const updated = await store.read('sign-reject-test');
    assert.equal(updated.state, 'abandoned');
  });

  it('does not fail when approving already-completed slice', async () => {
    const slice = store.create('sign-already-completed', 'Already Completed');
    slice.state = 'frozen';
    slice.spec.frozenHash = 'sha256:test';
    slice.spec.frozenAt = new Date().toISOString();
    await store.write(slice);

    // Gate pass to completed
    await store.transit('sign-already-completed', 'GATE_PASS');

    // Approve — should not throw even though slice is already completed
    const req = await manager.request('sign-already-completed', 'agent');
    await assert.doesNotReject(async () => {
      await manager.approve(req.id, 'human');
    });
  });
});
