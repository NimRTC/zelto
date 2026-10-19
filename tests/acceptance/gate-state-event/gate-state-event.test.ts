// Acceptance test: gate-state-event
// Verifies that zelto gate emits slice.state.changed event on GATE_PASS transition

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

const BASE_DIR = join(tmpdir(), 'zelto-acceptance-gate-state-event');
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');
const SLICES_DIR = join(BASE_DIR, '.zelto', 'slices');

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

describe('acceptance: gate-state-event', () => {
  before(async () => {
    await rm(BASE_DIR, { recursive: true, force: true });
    await mkdir(join(BASE_DIR, '.zelto', 'slices'), { recursive: true });
    await mkdir(join(BASE_DIR, '.zelto', 'events'), { recursive: true });
    await mkdir(join(BASE_DIR, 'specs', 'slices'), { recursive: true });

    // Write config with node -e as mock gate commands
    await writeFile(join(BASE_DIR, '.zelto', 'config.yaml'), [
      'gate:',
      '  commands:',
      '    - { name: test, run: "node -e process.exit(0)" }',
      '    - { name: lint, run: "node -e process.exit(0)" }',
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

  it('zelto gate emits slice.state.changed event on GATE_PASS', async () => {
    // Create a slice, freeze it, then run gate
    await zelto('create', 'gate-event-test');
    await writeFile(join(BASE_DIR, 'specs', 'slices', 'gate-event-test.md'), '# Gate event test spec', 'utf-8');
    await zelto('freeze', 'gate-event-test');

    // Run gate (should pass with echo commands)
    const { stdout, code } = await zelto('gate', 'gate-event-test');
    assert.equal(code, 0, `gate should exit 0: ${stdout}`);

    // Read events and find slice.state.changed
    const events = await readEvents('gate-event-test');
    const stateChangedEvents = events.filter((e) => e.type === 'slice.state.changed');
    assert.equal(stateChangedEvents.length, 1, 'should have exactly one slice.state.changed event');

    const payload = stateChangedEvents[0].payload as Record<string, unknown>;
    assert.equal(payload.from, 'frozen', 'from should be frozen');
    assert.equal(payload.to, 'completed', 'to should be completed');
    assert.equal(payload.event, 'GATE_PASS', 'event should be GATE_PASS');
    assert.equal(payload.sliceId, 'gate-event-test', 'should reference correct slice');
    assert.ok(stateChangedEvents[0].ts, 'event should have timestamp');
  });

  it('zelto gate updates slice state to completed', async () => {
    // Verify the slice file also shows completed state
    const slice = JSON.parse(await readFile(join(SLICES_DIR, 'gate-event-test.json'), 'utf-8'));
    assert.equal(slice.state, 'completed', 'slice should be in completed state');
  });
});
