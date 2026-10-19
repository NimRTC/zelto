import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { EventStream } from '../src/core/events/stream.js';
import { SliceStore } from '../src/core/slice/store.js';

const TEST_DIR = join(tmpdir(), `zelto-events-cmd-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
const EVENTS_DIR = join(TEST_DIR, 'events');
const SLICES_DIR = join(TEST_DIR, 'slices');

// Simulate the events command logic for testing
async function getEvents(
  id: string,
  options: { json?: boolean; tail?: number } = {},
): Promise<{ lines: string[]; exitCode: number }> {
  const events = new EventStream(EVENTS_DIR);
  const store = new SliceStore(SLICES_DIR);
  const lines: string[] = [];

  // Capture console.log
  const origLog = console.log;
  console.log = (...args: any[]) => {
    lines.push(args.map(String).join(' '));
  };

  let exitCode = 0;
  try {
    // Verify slice exists
    await store.read(id);

    const allEvents = await events.read(id);

    if (allEvents.length === 0) {
      if (options.json) {
        lines.push(JSON.stringify({ sliceId: id, events: [] }));
      } else {
        lines.push(`No events for slice: ${id}`);
      }
      return { lines, exitCode: 0 };
    }

    const displayEvents =
      options.tail != null && !Number.isNaN(options.tail)
        ? allEvents.slice(-options.tail)
        : allEvents;

    if (options.json) {
      lines.push(
        JSON.stringify({
          sliceId: id,
          total: allEvents.length,
          displayed: displayEvents.length,
          events: displayEvents,
        }),
      );
    } else {
      for (const evt of displayEvents) {
        const time = evt.ts
          ? new Date(evt.ts).toISOString().slice(11, 19)
          : '--:--:--';
        lines.push(`  ${time}  ${evt.type.padEnd(24)} ${evt.actor ?? ''}`);
      }
      if (displayEvents.length < allEvents.length) {
        lines.push(`  (showing last ${displayEvents.length} of ${allEvents.length} events)`);
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes('not found') || msg.includes('ENOENT')) {
      lines.push(options.json
        ? JSON.stringify({ error: `Slice not found: ${id}` })
        : `❌ Slice not found: ${id}`);
      exitCode = 1;
    } else {
      lines.push(options.json
        ? JSON.stringify({ error: msg })
        : `❌ Error: ${msg}`);
      exitCode = 1;
    }
  } finally {
    console.log = origLog;
  }

  return { lines, exitCode };
}

describe('events command', { concurrency: false }, () => {
  before(async () => {
    await mkdir(EVENTS_DIR, { recursive: true });
    await mkdir(SLICES_DIR, { recursive: true });
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('shows no events for a slice with no events', async () => {
    const store = new SliceStore(SLICES_DIR);
    const slice = store.create('empty-slice', 'Empty Slice');
    await store.write(slice);

    const result = await getEvents('empty-slice');
    assert.equal(result.exitCode, 0);
    assert.ok(result.lines[0]?.includes('No events'));
  });

  it('lists events for a slice with events', async () => {
    const store = new SliceStore(SLICES_DIR);
    const slice = store.create('eventful-slice', 'Eventful Slice');
    await store.write(slice);

    const events = new EventStream(EVENTS_DIR);
    await events.append('eventful-slice', 'slice.state.changed', 'system', {
      sliceId: 'eventful-slice',
      from: 'draft',
      to: 'frozen',
      event: 'FREEZE',
    });
    await events.append('eventful-slice', 'run.started', 'agent', {
      sliceId: 'eventful-slice',
    });
    await events.append('eventful-slice', 'run.finished', 'agent', {
      sliceId: 'eventful-slice',
    });

    const result = await getEvents('eventful-slice');
    assert.equal(result.exitCode, 0);
    assert.equal(result.lines.length, 3);
    assert.ok(result.lines[0]?.includes('slice.state.changed'));
    assert.ok(result.lines[1]?.includes('run.started'));
    assert.ok(result.lines[2]?.includes('run.finished'));
  });

  it('supports --tail flag', async () => {
    const store = new SliceStore(SLICES_DIR);
    const tailSlice = store.create('tail-slice', 'Tail Test');
    await store.write(tailSlice);

    const events = new EventStream(EVENTS_DIR);
    await events.append('tail-slice', 'run.started', 'agent', {});
    await events.append('tail-slice', 'gate.executed', 'system', {});
    await events.append('tail-slice', 'sign.requested', 'zelto', {});

    const result = await getEvents('tail-slice', { tail: 2 });
    assert.equal(result.exitCode, 0);
    assert.equal(result.lines.length, 3);
    assert.ok(result.lines[0]?.includes('gate.executed'));
    assert.ok(result.lines[1]?.includes('sign.requested'));
    assert.ok(result.lines[2]?.includes('showing last'));
  });

  it('returns error for non-existent slice', async () => {
    const result = await getEvents('no-such-slice');
    assert.equal(result.exitCode, 1);
    assert.ok(result.lines[0]?.includes('not found'));
  });

  it('supports --json output', async () => {
    const store = new SliceStore(SLICES_DIR);
    const jsonSlice = store.create('json-slice', 'JSON Test');
    await store.write(jsonSlice);

    const events = new EventStream(EVENTS_DIR);
    await events.append('json-slice', 'run.started', 'agent', {});

    const result = await getEvents('json-slice', { json: true });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.lines[0]!);
    assert.equal(parsed.sliceId, 'json-slice');
    assert.equal(parsed.total, 1);
    assert.equal(parsed.events.length, 1);
    assert.equal(parsed.events[0].type, 'run.started');
  });
});
