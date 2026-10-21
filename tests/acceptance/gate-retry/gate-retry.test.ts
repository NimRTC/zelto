// Acceptance test: gate-retry
// Verifies that zelto gate correctly handles command failures and retries
// Tests: gate.retry events, stall info update, and final failure report

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const BASE_DIR = join(tmpdir(), `zelto-acceptance-gate-retry-${Date.now()}`);
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');
const SLICES_DIR = join(BASE_DIR, '.zelto', 'slices');

function zelto(
  ...args: string[]
): Promise<{ stdout: string; stderr: string; code: number }> {
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

describe('acceptance: gate-retry', { concurrency: false }, () => {
  before(async () => {
    await rm(BASE_DIR, { recursive: true, force: true });
    await mkdir(join(BASE_DIR, '.zelto', 'slices'), { recursive: true });
    await mkdir(join(BASE_DIR, '.zelto', 'events'), { recursive: true });
    await mkdir(join(BASE_DIR, 'specs', 'slices'), { recursive: true });

    // Config with a command that always fails, retry max = 2
    await writeFile(join(BASE_DIR, '.zelto', 'config.yaml'), [
      'gate:',
      '  commands:',
      '    - { name: test, run: "node -e process.exit(1)" }',
      '  timeoutSec: 10',
      '  retry:',
      '    max: 2',
      'agent:',
      '  command: "echo"',
      '',
    ].join('\n'), 'utf-8');
  });

  after(async () => {
    await rm(BASE_DIR, { recursive: true, force: true });
  });

  it('gate command failure emits gate.retry events and updates stall info', async () => {
    // Create a slice, freeze it
    const { stdout: createOut, code: createCode } = await zelto('create', 'gate-retry-test', '--title', 'Gate Retry Test');
    assert.equal(createCode, 0, `create failed: ${createOut}`);

    await writeFile(join(BASE_DIR, 'specs', 'slices', 'gate-retry-test.md'), '# Gate retry test spec', 'utf-8');

    const { stdout: freezeOut, code: freezeCode } = await zelto('freeze', 'gate-retry-test');
    assert.equal(freezeCode, 0, `freeze failed: ${freezeOut}`);

    // Run gate (should fail with retries)
    const { stdout } = await zelto('gate', 'gate-retry-test');

    // Gate CLI always exits 0; check output for failure markers instead
    assert.ok(stdout.includes('❌'), `output should show failure: ${stdout}`);
    assert.ok(stdout.includes('Gate failed'), `output should say Gate failed: ${stdout}`);

    // Read events — should have gate.retry events
    const events = await readEvents('gate-retry-test');
    const retryEvents = events.filter((e) => e.type === 'gate.retry');
    assert.ok(retryEvents.length > 0, `should have gate.retry events, got ${retryEvents.length}`);
    assert.ok(retryEvents.length <= 2, `gate.retry events should not exceed max retries (2), got ${retryEvents.length}`);

    // gate.executed and gate.result events should exist
    const executedEvents = events.filter((e) => e.type === 'gate.executed');
    assert.equal(executedEvents.length, 1, 'should have exactly one gate.executed event');

    const resultEvents = events.filter((e) => e.type === 'gate.result');
    assert.equal(resultEvents.length, 1, 'should have exactly one gate.result event');

    // Verify gate.result indicates failure
    const gateResult = resultEvents[0].payload as Record<string, unknown>;
    assert.equal(gateResult.passed, false, 'gate.result should indicate failure');

    // Slice stall info should be updated
    const slice = JSON.parse(await readFile(join(SLICES_DIR, 'gate-retry-test.json'), 'utf-8'));
    assert.ok(slice.stall.gateRetries > 0, `gateRetries should be > 0, got ${slice.stall.gateRetries}`);
    assert.equal(slice.stall.class, 'gate_retry', 'stall class should be gate_retry');
  });

  it('passing gate does not create gate.retry events or stall', async () => {
    // Create a slice with passing gate commands
    await zelto('create', 'gate-pass-test', '--title', 'Gate Pass Test');
    await writeFile(join(BASE_DIR, 'specs', 'slices', 'gate-pass-test.md'), '# Gate pass test spec', 'utf-8');
    await zelto('freeze', 'gate-pass-test');

    // Override config to use passing commands for this test
    await writeFile(join(BASE_DIR, '.zelto', 'config.yaml'), [
      'gate:',
      '  commands:',
      '    - { name: test, run: "node -e process.exit(0)" }',
      '  timeoutSec: 10',
      '  retry:',
      '    max: 2',
      'agent:',
      '  command: "echo"',
      '',
    ].join('\n'), 'utf-8');

    const { stdout, code } = await zelto('gate', 'gate-pass-test');
    assert.equal(code, 0, `gate should pass: ${stdout}`);

    // Read events — should NOT have gate.retry
    const events = await readEvents('gate-pass-test');
    const retryEvents = events.filter((e) => e.type === 'gate.retry');
    assert.equal(retryEvents.length, 0, 'should NOT have gate.retry events');

    // Slice should be completed
    const slice = JSON.parse(await readFile(join(SLICES_DIR, 'gate-pass-test.json'), 'utf-8'));
    assert.equal(slice.state, 'completed', 'slice should be completed');
    assert.equal(slice.stall.class, null, 'stall class should be null');
  });

  it('gate retry respects max retry limit', async () => {
    // Create a separate clean directory to avoid config contamination
    const cleanDir = join(tmpdir(), `zelto-gate-max-retry-${Date.now()}`);
    await mkdir(join(cleanDir, '.zelto', 'slices'), { recursive: true });
    await mkdir(join(cleanDir, '.zelto', 'events'), { recursive: true });
    await mkdir(join(cleanDir, 'specs', 'slices'), { recursive: true });

    await writeFile(join(cleanDir, '.zelto', 'config.yaml'), [
      'gate:',
      '  commands:',
      '    - { name: test, run: "node -e process.exit(1)" }',
      '  timeoutSec: 10',
      '  retry:',
      '    max: 1',
      'agent:',
      '  command: "echo"',
      '',
    ].join('\n'), 'utf-8');

    // Use spawn directly for this test to use cleanDir
    const child = spawn('node', [CLI_SCRIPT, 'create', 'gate-max-retry-test'], { cwd: cleanDir, stdio: ['pipe', 'pipe', 'pipe'] });
    await new Promise<void>((resolve) => { child.on('close', () => resolve()); });
    await writeFile(join(cleanDir, 'specs', 'slices', 'gate-max-retry-test.md'), '# Gate max retry test spec', 'utf-8');
    const child2 = spawn('node', [CLI_SCRIPT, 'freeze', 'gate-max-retry-test'], { cwd: cleanDir, stdio: ['pipe', 'pipe', 'pipe'] });
    await new Promise<void>((resolve) => { child2.on('close', () => resolve()); });

    // Run gate
    const child3 = spawn('node', [CLI_SCRIPT, 'gate', 'gate-max-retry-test'], { cwd: cleanDir, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child3.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    await new Promise<void>((resolve) => { child3.on('close', () => resolve()); });

    // Verify output shows failure (gate CLI always exits 0)
    assert.ok(stdout.includes('❌'), `output should show failure: ${stdout}`);

    // Read events
    const eventsFile = join(cleanDir, '.zelto', 'events', 'gate-max-retry-test', 'events.jsonl');
    const content = await readFile(eventsFile, 'utf-8');
    const events = content.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const retryEvents = events.filter((e: Record<string, unknown>) => e.type === 'gate.retry');

    // With max: 1, we should have exactly 1 retry event
    assert.equal(retryEvents.length, 1, `should have 1 gate.retry event with max=1, got ${retryEvents.length}`);

    const retryPayload = retryEvents[0].payload as Record<string, unknown>;
    assert.equal(retryPayload.maxRetries, 1, 'maxRetries should be 1');
    assert.equal(retryPayload.attempt, 1, 'attempt should be 1');

    await rm(cleanDir, { recursive: true, force: true });
  });
});
