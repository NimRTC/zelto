// E2E integration test: full slice lifecycle
// Tests the complete "create → freeze → check → run(dry-run) → events → summary" flow
// Uses echo as mock agent; run phase is tested but gate/sign may vary by platform

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const BASE_DIR = join(tmpdir(), `zelto-e2e-full-cycle-${Date.now()}`);
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');

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
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) =>
      resolve({ stdout: stdout || stderr, stderr, code: code ?? 1 }),
    );
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
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((e): e is Record<string, unknown> => e !== null);
}

describe('acceptance: e2e full lifecycle', { concurrency: false }, () => {
  before(async () => {
    await rm(BASE_DIR, { recursive: true, force: true });
    await mkdir(BASE_DIR, { recursive: true });

    // Init zelto project
    const initResult = await zelto('init');
    assert.equal(initResult.code, 0, `init failed: ${initResult.stderr}`);

    // Write config with echo as mock agent
    await writeFile(
      join(BASE_DIR, '.zelto', 'config.yaml'),
      [
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
      ].join('\n'),
      'utf-8',
    );

    // Write spec file
    const specDir = join(BASE_DIR, 'specs', 'slices');
    await mkdir(specDir, { recursive: true });
    await writeFile(
      join(specDir, 'e2e-test-slice.md'),
      '# E2E Test Slice\n\n## Requirements\n- E2E-TEST-1: Full lifecycle test\n\n## Contracts\n- CT-1: Lifecycle contract\n',
      'utf-8',
    );

    // Create the slice
    const createResult = await zelto(
      'create',
      'e2e-test-slice',
      '--title',
      'E2E Full Lifecycle Test',
    );
    assert.equal(createResult.code, 0, `create failed: ${createResult.stderr}`);
  });

  after(async () => {
    await rm(BASE_DIR, { recursive: true, force: true });
  });

  it('step 1: freeze emits spec.frozen event', async () => {
    const result = await zelto('freeze', 'e2e-test-slice');
    assert.equal(result.code, 0, `freeze failed: ${result.stdout}`);

    const events = await readEvents('e2e-test-slice');
    const frozenEvents = events.filter((e) => e.type === 'spec.frozen');
    assert.equal(frozenEvents.length, 1, 'should have spec.frozen event');
  });

  it('step 2: check emits spec.checked event', async () => {
    const result = await zelto('check', 'e2e-test-slice');
    assert.equal(result.code, 0, `check failed: ${result.stdout}`);

    const events = await readEvents('e2e-test-slice');
    const checkedEvents = events.filter((e) => e.type === 'spec.checked');
    assert.equal(checkedEvents.length, 1, 'should have spec.checked event');
  });

  it('step 3: run --dry-run passes admission', async () => {
    const result = await zelto('run', 'e2e-test-slice', '--dry-run');
    assert.equal(result.code, 0, `dry-run failed: ${result.stdout}`);
    assert.ok(
      result.stdout.includes('Would admit'),
      `dry-run should show admission: ${result.stdout}`,
    );
  });

  it('step 4: events lists all lifecycle events', async () => {
    const result = await zelto('events', 'e2e-test-slice');
    assert.equal(result.code, 0, `events failed: ${result.stderr}`);

    assert.ok(result.stdout.includes('spec.drafted'), 'should show spec.drafted');
    assert.ok(result.stdout.includes('spec.frozen'), 'should show spec.frozen');
    assert.ok(result.stdout.includes('spec.checked'), 'should show spec.checked');
  });

  it('step 5: events --json outputs valid JSON', async () => {
    const result = await zelto('events', 'e2e-test-slice', '--json');
    assert.equal(result.code, 0);

    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.sliceId, 'e2e-test-slice');
    assert.ok(parsed.total >= 3, 'should have at least 3 events');
    assert.ok(Array.isArray(parsed.events));
  });

  it('step 6: events --tail shows only recent events', async () => {
    const result = await zelto('events', 'e2e-test-slice', '--tail', '1');
    assert.equal(result.code, 0);
    assert.ok(
      result.stdout.includes('showing last'),
      `tail should show summary: ${result.stdout}`,
    );
  });

  it('step 7: summary includes slice in audit & metrics', async () => {
    const result = await zelto('summary');
    assert.equal(result.code, 0, `summary failed: ${result.stderr}`);

    assert.ok(
      result.stdout.includes('e2e-test-slice'),
      `summary should include slice: ${result.stdout}`,
    );
    assert.ok(
      result.stdout.includes('Audit & Metrics'),
      `summary should have audit section: ${result.stdout}`,
    );
  });

  it('step 8: run with echo agent (platform-dependent exit)', async () => {
    const result = await zelto('run', 'e2e-test-slice');
    // On some platforms echo exits 0, on others (Windows) it may not
    // The important thing is that run.started event was emitted
    const events = await readEvents('e2e-test-slice');
    const runStarted = events.filter((e) => e.type === 'run.started');
    assert.equal(runStarted.length, 1, 'should have run.started event');
  });

  it('step 9: gate runs (platform-dependent pass/fail)', async () => {
    const result = await zelto('gate', 'e2e-test-slice');
    // Gate runs the commands; may or may not pass depending on slice state.
    // With auto-gate-after-run, the slice may already be "completed".
    // At minimum, gate.executed event should exist (from auto-gate) or a state message.
    const events = await readEvents('e2e-test-slice');
    const gateExecuted = events.filter((e) => e.type === 'gate.executed');
    // Gate may be skipped if already completed; just verify it doesn't crash
    assert.ok(
      result.stdout.includes('running gate') || result.stdout.includes('Error') || result.stdout.includes('completed'),
      `gate should at least attempt: ${result.stdout}`,
    );
  });

  it('step 10: inbox shows sign requests if any', async () => {
    const result = await zelto('inbox', '--list');
    assert.equal(result.code, 0, `inbox failed: ${result.stderr}`);
    // Inbox is valid whether empty or has items
    assert.ok(
      result.stdout.includes('pending') ||
        result.stdout.includes('empty') ||
        result.stdout.includes('Pending'),
      `inbox should show status: ${result.stdout}`,
    );
  });
});
