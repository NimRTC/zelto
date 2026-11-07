// Acceptance test: sign-state-event
// Verifies that zelto sign --approve and --reject emit slice.state.changed events

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

const BASE_DIR = join(tmpdir(), 'zelto-acceptance-sign-state-event');
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

describe('acceptance: sign-state-event', () => {
  before(async () => {
    await rm(BASE_DIR, { recursive: true, force: true });
    await mkdir(join(BASE_DIR, '.zelto', 'slices'), { recursive: true });
    await mkdir(join(BASE_DIR, '.zelto', 'events'), { recursive: true });
    await mkdir(join(BASE_DIR, 'specs', 'slices'), { recursive: true });

    // Write config with node -e as mock gate commands
    await writeFile(join(BASE_DIR, '.zelto', 'config.yaml'), [
      'gate:',
      '  commands:',
      '    - { name: test, run: "node -e process.exitCode=0" }',
      '    - { name: lint, run: "node -e process.exitCode=0" }',
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

  it('zelto sign --approve emits slice.state.changed event', async () => {
    // Create a slice, freeze it, run gate to create sign request, then approve
    await zelto('create', 'sign-approve-test', '--requirement', 'REQ-1: 签字通过要推进切片状态');
    await writeFile(join(BASE_DIR, 'specs', 'slices', 'sign-approve-test.md'), '# Sign approve test spec', 'utf-8');
    await zelto('freeze', 'sign-approve-test');
    const gateResult = await zelto('gate', 'sign-approve-test');
    assert.equal(gateResult.code, 0, `gate should exit 0: ${gateResult.stdout}`);

    // Now approve
    const { code, stdout } = await zelto('sign', 'sign-approve-test', '--approve');
    assert.equal(code, 0, `sign --approve should exit 0: ${stdout}`);

    // Read events and find slice.state.changed for SIGN_APPROVE
    const events = await readEvents('sign-approve-test');
    const stateChangedEvents = events.filter((e) => e.type === 'slice.state.changed');
    const approveEvent = stateChangedEvents.find((e) => {
      const p = e.payload as Record<string, unknown>;
      return p.event === 'SIGN_APPROVE';
    });
    assert.ok(approveEvent, 'should have SIGN_APPROVE state change event');
    const payload = approveEvent.payload as Record<string, unknown>;
    assert.equal(payload.from, 'completed', 'from should be completed');
    assert.equal(payload.to, 'completed', 'to should be completed');
    assert.equal(payload.event, 'SIGN_APPROVE', 'event should be SIGN_APPROVE');
    assert.equal(payload.sliceId, 'sign-approve-test', 'should reference correct slice');
    assert.ok(approveEvent.ts, 'event should have timestamp');
  });

  it('zelto sign --reject emits slice.state.changed event', async () => {
    // Create a slice, freeze it, run gate, then reject
    await zelto('create', 'sign-reject-test', '--requirement', 'REQ-2: 签字否决要把切片置为已放弃');
    await writeFile(join(BASE_DIR, 'specs', 'slices', 'sign-reject-test.md'), '# Sign reject test spec', 'utf-8');
    await zelto('freeze', 'sign-reject-test');
    const gateResult = await zelto('gate', 'sign-reject-test');
    assert.equal(gateResult.code, 0, `gate should exit 0: ${gateResult.stdout}`);

    // Now reject
    const { code, stdout } = await zelto('sign', 'sign-reject-test', '--reject');
    assert.equal(code, 0, `sign --reject should exit 0: ${stdout}`);

    // Read events and find slice.state.changed for SIGN_REJECT
    const events = await readEvents('sign-reject-test');
    const stateChangedEvents = events.filter((e) => e.type === 'slice.state.changed');
    const rejectEvent = stateChangedEvents.find((e) => {
      const p = e.payload as Record<string, unknown>;
      return p.event === 'SIGN_REJECT';
    });
    assert.ok(rejectEvent, 'should have SIGN_REJECT state change event');
    const payload = rejectEvent.payload as Record<string, unknown>;
    assert.equal(payload.from, 'completed', 'from should be completed');
    assert.equal(payload.to, 'abandoned', 'to should be abandoned');
    assert.equal(payload.event, 'SIGN_REJECT', 'event should be SIGN_REJECT');
    assert.equal(payload.sliceId, 'sign-reject-test', 'should reference correct slice');
    assert.ok(rejectEvent.ts, 'event should have timestamp');
  });

  it('zelto sign --reject updates slice state to abandoned', async () => {
    const slice = JSON.parse(await readFile(join(SLICES_DIR, 'sign-reject-test.json'), 'utf-8'));
    assert.equal(slice.state, 'abandoned', 'slice should be in abandoned state');
  });
});
