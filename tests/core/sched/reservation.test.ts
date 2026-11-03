// Tests for the write-set reservation store (C9 runtime credential)

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ReservationStore,
  isProcessAlive,
  reapStaleReservations,
} from '../../../src/core/sched/reservation.js';

describe('ReservationStore', () => {
  let dir: string;
  let store: ReservationStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zelto-res-'));
    store = new ReservationStore(join(dir, 'locks'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the reservation to a file named after the slice', async () => {
    const reservation = await store.acquire('slice-a', {
      writes: ['src/core/**'],
      worktree: '/repo/.zelto/worktrees/slice-a',
      projectRoot: '/repo',
    });

    assert.equal(reservation.sliceId, 'slice-a');
    assert.deepEqual(reservation.writes, ['src/core/**']);
    assert.equal(reservation.worktree, '/repo/.zelto/worktrees/slice-a');
    assert.equal(reservation.projectRoot, '/repo');
    assert.equal(reservation.releasedAt, null);
    assert.equal(reservation.pid, process.pid);

    const raw = readFileSync(join(dir, 'locks', 'slice-a.json'), 'utf-8');
    const parsed = JSON.parse(raw) as typeof reservation;
    assert.equal(parsed.sliceId, 'slice-a');
    assert.deepEqual(parsed.writes, ['src/core/**']);
  });

  it('refuses to overwrite a live reservation unless replace is set', async () => {
    await store.acquire('slice-a', { writes: ['src/**'] });

    await assert.rejects(
      () => store.acquire('slice-a', { writes: ['src/**'], replace: false }),
      /已有生效中的写集预约/,
    );

    const replaced = await store.acquire('slice-a', { writes: ['lib/**'], replace: true });
    assert.deepEqual(replaced.writes, ['lib/**']);
  });

  it('allows re-acquiring after the previous one was released', async () => {
    await store.acquire('slice-a', { writes: ['src/**'] });
    assert.equal(await store.release('slice-a'), true);

    const again = await store.acquire('slice-a', { writes: ['src/**'], replace: false });
    assert.equal(again.releasedAt, null);
  });

  it('release marks the reservation as released and reports unknown slices', async () => {
    await store.acquire('slice-a', { writes: ['src/**'] });

    assert.equal(await store.release('slice-a'), true);
    const after = await store.read('slice-a');
    assert.ok(after);
    assert.notEqual(after.releasedAt, null);

    assert.equal(await store.release('never-existed'), false);
  });

  it('reads back what it wrote', async () => {
    await store.acquire('slice-a', { writes: ['a/**', 'b/**'] });
    const found = await store.read('slice-a');
    assert.ok(found);
    assert.deepEqual(found.writes, ['a/**', 'b/**']);
  });

  it('returns null for a missing or corrupt reservation', async () => {
    assert.equal(await store.read('nope'), null);

    mkdirSync(join(dir, 'locks'), { recursive: true });
    writeFileSync(join(dir, 'locks', 'broken.json'), '{ not json', 'utf-8');
    assert.equal(await store.read('broken'), null);
  });

  it('lists all reservations and separates the active ones', async () => {
    await store.acquire('slice-a', { writes: ['a/**'] });
    await store.acquire('slice-b', { writes: ['b/**'] });
    await store.release('slice-b');

    const all = await store.list();
    assert.equal(all.length, 2);

    const active = await store.active();
    assert.equal(active.length, 1);
    assert.equal(active[0].sliceId, 'slice-a');
  });

  it('lists nothing when the locks directory does not exist', async () => {
    const empty = new ReservationStore(join(dir, 'no-such-dir'));
    assert.deepEqual(await empty.list(), []);
    assert.deepEqual(await empty.active(), []);
  });
});

describe('isProcessAlive', () => {
  it('recognises the current process', () => {
    assert.equal(isProcessAlive(process.pid), true);
  });

  it('rejects nonsensical pids', () => {
    assert.equal(isProcessAlive(0), false);
    assert.equal(isProcessAlive(-1), false);
    assert.equal(isProcessAlive(1.5), false);
  });
});

describe('reapStaleReservations', () => {
  let dir: string;
  let store: ReservationStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zelto-res-reap-'));
    store = new ReservationStore(join(dir, 'locks'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('releases reservations whose owning process is gone', async () => {
    await store.acquire('alive', { writes: ['a/**'] });

    // A pid that cannot be running — the reservation looks stale.
    mkdirSync(join(dir, 'locks'), { recursive: true });
    writeFileSync(
      join(dir, 'locks', 'dead.json'),
      JSON.stringify({
        sliceId: 'dead',
        writes: ['b/**'],
        worktree: null,
        projectRoot: '/repo',
        acquiredAt: new Date().toISOString(),
        releasedAt: null,
        pid: 999_999,
      }),
      'utf-8',
    );

    const reaped = await reapStaleReservations(store);
    assert.deepEqual(reaped, ['dead']);

    const dead = await store.read('dead');
    assert.ok(dead);
    assert.notEqual(dead.releasedAt, null);

    // The live one (this process) is untouched.
    const alive = await store.read('alive');
    assert.ok(alive);
    assert.equal(alive.releasedAt, null);
  });
});
