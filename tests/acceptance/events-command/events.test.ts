import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const CLI_SCRIPT = join(import.meta.dirname, '..', '..', '..', 'dist', 'cli', 'index.js');
const TEST_DIR = join(
  tmpdir(),
  `zelto-accept-events-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
);
const SLICES_DIR = join(TEST_DIR, '.zelto', 'slices');
const EVENTS_DIR = join(TEST_DIR, '.zelto', 'events');

function zelto(...args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [CLI_SCRIPT, ...args], {
    cwd: TEST_DIR,
    encoding: 'utf-8',
  });
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim(), status: result.status };
}

describe('zelto events (acceptance)', { concurrency: false }, () => {
  before(async () => {
    await mkdir(TEST_DIR, { recursive: true });

    // Init zelto project
    const initResult = zelto('init');
    assert.equal(initResult.status, 0, `init failed: ${initResult.stderr}`);

    // Create a slice and generate events
    const createResult = zelto('create', 'events-test-slice', '--title', 'Events Acceptance Test');
    assert.equal(createResult.status, 0, `create failed: ${createResult.stderr}`);

    // Write a spec file so freeze works
    const specDir = join(TEST_DIR, 'specs', 'slices');
    await mkdir(specDir, { recursive: true });
    await writeFile(join(specDir, 'events-test-slice.md'), '# Events Test Spec', 'utf-8');

    // Freeze to generate more events (spec.frozen + slice.state.changed)
    const freezeResult = zelto('freeze', 'events-test-slice');
    assert.equal(freezeResult.status, 0, `freeze failed: ${freezeResult.stderr}`);

    // Create a truly empty slice: write slice file manually, but no events dir
    await mkdir(SLICES_DIR, { recursive: true });
    await writeFile(
      join(SLICES_DIR, 'no-events-slice.json'),
      JSON.stringify({
        id: 'no-events-slice',
        title: 'No Events Slice',
        state: 'draft',
        spec: { path: 'specs/slices/no-events-slice.md', frozenHash: null, frozenAt: null },
        acceptance: { dir: '', frozenHash: null, oracleSrc: null },
        baseCommit: null,
        drift: { detected: false, reason: null, at: null },
        trace: { requirements: [], contracts: [], tests: [] },
        traceWaiver: null,
        writes: [],
        runs: [],
        stall: { class: null, autoResolved: 0, gateRetries: 0 },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      'utf-8',
    );
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('lists events for a slice with events', () => {
    const result = zelto('events', 'events-test-slice');
    assert.equal(result.status, 0, `events failed: ${result.stderr}`);

    assert.ok(result.stdout.includes('spec.drafted'), 'Should list spec.drafted event');
    assert.ok(result.stdout.includes('spec.frozen'), 'Should list spec.frozen event');
    assert.ok(result.stdout.includes('zelto') || result.stdout.includes('cli'), 'Should show actor');
  });

  it('supports --tail N to show only recent events', () => {
    const result = zelto('events', 'events-test-slice', '--tail', '1');
    assert.equal(result.status, 0);

    // Output: "  HH:MM:SS  spec.frozen             zelto" + summary line
    assert.ok(result.stdout.includes('spec.frozen'), 'Should show only the last event');
    assert.ok(result.stdout.includes('showing last'), 'Should show summary of filtered count');
  });

  it('supports --json output', () => {
    const result = zelto('events', 'events-test-slice', '--json');
    assert.equal(result.status, 0);

    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.sliceId, 'events-test-slice');
    assert.ok(parsed.total >= 2, 'Should have at least 2 events');
    assert.ok(Array.isArray(parsed.events));
    assert.equal(parsed.events.length, parsed.total);
    assert.ok(parsed.events.some((e: { type: string }) => e.type === 'spec.drafted'));
  });

  it('returns error for non-existent slice', () => {
    const result = zelto('events', 'no-such-slice');
    assert.equal(result.status, 1);
    assert.ok(
      result.stdout.toLowerCase().includes('not found'),
      `Expected error about missing slice, got: ${result.stdout}`,
    );
  });

  it('shows empty list for a slice with no events', () => {
    const result = zelto('events', 'no-events-slice');
    assert.equal(result.status, 0);
    assert.ok(
      result.stdout.includes('No events'),
      `Expected "No events" message, got: ${result.stdout}`,
    );
  });

  it('supports --json for a slice with no events', () => {
    const result = zelto('events', 'no-events-slice', '--json');
    assert.equal(result.status, 0);

    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.sliceId, 'no-events-slice');
    assert.deepEqual(parsed.events, []);
  });

  it('supports --json with --tail', () => {
    const result = zelto('events', 'events-test-slice', '--json', '--tail', '1');
    assert.equal(result.status, 0);

    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.sliceId, 'events-test-slice');
    assert.ok(parsed.total >= 2, 'total should reflect all events');
    assert.equal(parsed.displayed, 1, 'displayed should be 1');
    assert.equal(parsed.events.length, 1, 'events array should have 1 entry');
  });
});
