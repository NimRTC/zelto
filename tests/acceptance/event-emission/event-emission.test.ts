// Acceptance test: event-emission
// Verifies that freeze, check, and start commands emit correct events to the event stream

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

function findProjectRoot(from: string): string {
  let dir = from;
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return from;
}
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const BASE_DIR = join(tmpdir(), 'zelto-acceptance-event-emission');
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');

function zelto(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI_SCRIPT, ...args], {
      cwd: BASE_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    child.on('error', reject);
  });
}

async function readEvents(sliceId: string): Promise<Record<string, unknown>[]> {
  const eventsFile = join(BASE_DIR, '.zelto', 'events', sliceId, 'events.jsonl');
  if (!existsSync(eventsFile)) return [];
  const content = await readFile(eventsFile, 'utf-8');
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line) as Record<string, unknown>; }
      catch { return null; }
    })
    .filter((e): e is Record<string, unknown> => e !== null);
}

describe('acceptance: event-emission', () => {
  before(async () => {
    await rm(BASE_DIR, { recursive: true, force: true });
    await mkdir(join(BASE_DIR, '.zelto', 'slices'), { recursive: true });
    await mkdir(join(BASE_DIR, '.zelto', 'events'), { recursive: true });
    await mkdir(join(BASE_DIR, 'specs', 'slices'), { recursive: true });

    // Write config with echo as mock agent
    await writeFile(join(BASE_DIR, '.zelto', 'config.yaml'), [
      'gate:',
      '  commands:',
      '    - { name: test, run: "echo ok" }',
      '    - { name: lint, run: "echo ok" }',
      '  timeoutSec: 30',
      '  retry:',
      '    max: 1',
      'agent:',
      '  command: "echo"',
      '',
    ].join('\n'), 'utf-8');
  });

  after(async () => {
    await rm(BASE_DIR, { recursive: true, force: true });
  });

  it('zelto freeze emits spec.frozen event', async () => {
    // Create a slice and freeze it
    await zelto('create', 'freeze-event-test');
    await writeFile(join(BASE_DIR, 'specs', 'slices', 'freeze-event-test.md'), '# Freeze event test spec', 'utf-8');
    await zelto('freeze', 'freeze-event-test');

    const events = await readEvents('freeze-event-test');
    const frozenEvents = events.filter((e) => e.type === 'spec.frozen');
    assert.equal(frozenEvents.length, 1, 'should have exactly one spec.frozen event');
    assert.ok(frozenEvents[0].ts, 'event should have a timestamp');
    assert.ok(frozenEvents[0].payload, 'event should have payload');
    const payload = frozenEvents[0].payload as Record<string, unknown>;
    assert.ok(typeof payload.frozenHash === 'string', 'payload should have frozenHash');
    assert.ok(payload.frozenHash.toString().startsWith('sha256:'), 'frozenHash should be sha256 format');
  });

  it('zelto check emits spec.checked event', async () => {
    // Create a slice, freeze it, then check it
    await zelto('create', 'check-event-test');
    await writeFile(join(BASE_DIR, 'specs', 'slices', 'check-event-test.md'), '# Check event test spec', 'utf-8');
    await zelto('freeze', 'check-event-test');
    await zelto('check', 'check-event-test');

    const events = await readEvents('check-event-test');
    const checkedEvents = events.filter((e) => e.type === 'spec.checked');
    assert.equal(checkedEvents.length, 1, 'should have exactly one spec.checked event');
    const payload = checkedEvents[0].payload as Record<string, unknown>;
    // passed may be false due to empty traces (no reqs/contracts/tests traced)
    assert.ok('passed' in payload, 'payload should have passed field');
    assert.ok('issues' in payload, 'payload should have issues field');
    assert.ok(Array.isArray(payload.details), 'payload.details should be an array');
  });

  it('zelto check emits slice.drift_detected on hash mismatch', async () => {
    // Create a slice and freeze it
    await zelto('create', 'drift-event-test');
    await writeFile(join(BASE_DIR, 'specs', 'slices', 'drift-event-test.md'), '# Original spec for drift test', 'utf-8');
    await zelto('freeze', 'drift-event-test');

    // Modify the spec file to cause drift
    await writeFile(join(BASE_DIR, 'specs', 'slices', 'drift-event-test.md'), '# Modified spec — should trigger drift', 'utf-8');

    // Check should detect drift
    await zelto('check', 'drift-event-test');

    const events = await readEvents('drift-event-test');
    const driftEvents = events.filter((e) => e.type === 'slice.drift_detected');
    assert.equal(driftEvents.length, 1, 'should have exactly one slice.drift_detected event');
    const payload = driftEvents[0].payload as Record<string, unknown>;
    assert.ok(payload.expectedHash, 'should have expectedHash');
    assert.ok(payload.actualHash, 'should have actualHash');
    assert.notEqual(payload.expectedHash, payload.actualHash, 'hashes should differ');
  });

  it('zelto start auto-freeze emits spec.frozen event', async () => {
    // zelto start on a new slice should auto-freeze and emit spec.frozen
    const { stdout, code } = await zelto('start', 'start-freeze-event', '--title', 'Start Freeze Event');
    assert.equal(code, 0, `start should exit 0: ${stdout}`);

    const events = await readEvents('start-freeze-event');
    const frozenEvents = events.filter((e) => e.type === 'spec.frozen');
    assert.equal(frozenEvents.length, 1, 'start auto-freeze should emit spec.frozen event');
    const payload = frozenEvents[0].payload as Record<string, unknown>;
    assert.ok(typeof payload.frozenHash === 'string', 'payload should have frozenHash');
  });
});
