// Acceptance test: stall-resume
// Verifies that zelto stall and zelto resume commands work correctly via CLI
// Tests: listing stalled slices, resume (retry/skip/abandon), event emission

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const BASE_DIR = join(tmpdir(), `zelto-acceptance-stall-resume-${Date.now()}`);
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

/** Create a slice directly as a JSON file (bypass CLI for stalled slices) */
async function createSliceFile(
  id: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const now = new Date().toISOString();
  const slice = {
    id,
    title: overrides.title ?? `Stall test: ${id}`,
    state: overrides.state ?? 'running',
    spec: { path: `specs/slices/${id}.md`, frozenHash: 'sha256:test', frozenAt: now },
    acceptance: { dir: `tests/acceptance/${id}/`, frozenHash: null, oracleSrc: null },
    baseCommit: null,
    drift: { detected: false, reason: null, at: null },
    trace: { requirements: [], contracts: [], tests: [] },
    traceWaiver: null,
    writes: [],
    runs: [],
    stall: overrides.stall ?? { class: 'permission_prompt', autoResolved: 0, gateRetries: 0 },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  await writeFile(join(SLICES_DIR, `${id}.json`), JSON.stringify(slice, null, 2));
}

describe('acceptance: stall-resume', { concurrency: false }, () => {
  before(async () => {
    await rm(BASE_DIR, { recursive: true, force: true });
    await mkdir(join(BASE_DIR, '.zelto', 'slices'), { recursive: true });
    await mkdir(join(BASE_DIR, '.zelto', 'events'), { recursive: true });

    // Create stalled slices directly
    await createSliceFile('stall-permission', {
      title: 'Permission prompt stall',
      stall: { class: 'permission_prompt', autoResolved: 0, gateRetries: 0 },
    });
    await createSliceFile('stall-cognitive', {
      title: 'Cognitive stuck stall',
      stall: { class: 'cognitive_stuck', autoResolved: 1, gateRetries: 0 },
    });
    await createSliceFile('normal-slice', {
      title: 'Normal (non-stalled) slice',
      state: 'frozen',
      stall: { class: null, autoResolved: 0, gateRetries: 0 },
    });
  });

  after(async () => {
    await rm(BASE_DIR, { recursive: true, force: true });
  });

  it('zelto stall lists stalled slices', async () => {
    const { stdout, code } = await zelto('stall');
    assert.equal(code, 0, `stall should exit 0: ${stdout}`);

    // Should show stalled slices
    assert.ok(stdout.includes('stall-permission'), 'should list stall-permission');
    assert.ok(stdout.includes('stall-cognitive'), 'should list stall-cognitive');
    assert.ok(stdout.includes('permission_prompt'), 'should show stall class');
    assert.ok(stdout.includes('cognitive_stuck'), 'should show stall class');

    // Should NOT show normal-slice
    assert.ok(!stdout.includes('normal-slice'), 'should NOT list non-stalled slice');
  });

  it('zelto stall <id> shows details for a stalled slice', async () => {
    const { stdout, code } = await zelto('stall', 'stall-permission');
    assert.equal(code, 0, `stall <id> should exit 0: ${stdout}`);

    assert.ok(stdout.includes('permission_prompt'), 'should show stall class');
    assert.ok(stdout.includes('Stall class'), 'should have Stall class label');
  });

  it('zelto stall --auto-resolved includes resolved stalls', async () => {
    const { stdout, code } = await zelto('stall', '--auto-resolved');
    assert.equal(code, 0, `stall --auto-resolved should exit 0: ${stdout}`);

    // stall-cognitive has autoResolved: 1
    assert.ok(stdout.includes('stall-cognitive'), 'should show auto-resolved slice');
    assert.ok(stdout.includes('resolved'), 'should indicate resolved status');
  });

  it('zelto resume <id> clears stall and emits run.resumed event', async () => {
    // Create a fresh stalled slice for resume test
    await createSliceFile('resume-retry-test', {
      title: 'Resume retry test',
      stall: { class: 'environment_failure', autoResolved: 2, gateRetries: 0 },
    });

    const { stdout, code } = await zelto('resume', 'resume-retry-test');
    assert.equal(code, 0, `resume should exit 0: ${stdout}`);
    assert.ok(stdout.includes('resumed'), 'output should mention resumed');

    // Verify stall is cleared
    const slice = JSON.parse(await readFile(join(SLICES_DIR, 'resume-retry-test.json'), 'utf-8'));
    assert.equal(slice.stall.class, null, 'stall class should be cleared');
    assert.equal(slice.state, 'running', 'slice should remain in running state');

    // Verify run.resumed event was emitted
    const events = await readEvents('resume-retry-test');
    const resumedEvents = events.filter((e) => e.type === 'run.resumed');
    assert.equal(resumedEvents.length, 1, 'should have exactly one run.resumed event');

    const payload = resumedEvents[0].payload as Record<string, unknown>;
    assert.equal(payload.resolution, 'manual_retry', 'resolution should be manual_retry');
    assert.equal(payload.previousStallClass, 'environment_failure', 'should record previous stall class');
  });

  it('zelto resume <id> --skip marks resolved without re-execution', async () => {
    await createSliceFile('resume-skip-test', {
      title: 'Resume skip test',
      stall: { class: 'context_exhaustion', autoResolved: 3, gateRetries: 0 },
    });

    const { stdout, code } = await zelto('resume', 'resume-skip-test', '--skip');
    assert.equal(code, 0, `resume --skip should exit 0: ${stdout}`);

    const slice = JSON.parse(await readFile(join(SLICES_DIR, 'resume-skip-test.json'), 'utf-8'));
    assert.equal(slice.stall.class, null, 'stall class should be cleared');

    const events = await readEvents('resume-skip-test');
    const resumedEvents = events.filter((e) => e.type === 'run.resumed');
    const payload = resumedEvents[0].payload as Record<string, unknown>;
    assert.equal(payload.resolution, 'manual_skip', 'resolution should be manual_skip');
  });

  it('zelto resume <id> --abandon abandons the slice', async () => {
    await createSliceFile('resume-abandon-test', {
      title: 'Resume abandon test',
      stall: { class: 'plan_gate', autoResolved: 0, gateRetries: 0 },
    });

    const { stdout, code } = await zelto('resume', 'resume-abandon-test', '--abandon');
    assert.equal(code, 0, `resume --abandon should exit 0: ${stdout}`);
    assert.ok(stdout.includes('abandon'), 'output should mention abandon');

    const slice = JSON.parse(await readFile(join(SLICES_DIR, 'resume-abandon-test.json'), 'utf-8'));
    assert.equal(slice.state, 'abandoned', 'slice should be abandoned');

    const events = await readEvents('resume-abandon-test');
    const resumedEvents = events.filter((e) => e.type === 'run.resumed');
    const payload = resumedEvents[0].payload as Record<string, unknown>;
    assert.equal(payload.resolution, 'manual_abandon', 'resolution should be manual_abandon');
  });

  it('zelto resume rejects non-stalled slice', async () => {
    const { stdout, stderr, code } = await zelto('resume', 'normal-slice');
    assert.notEqual(code, 0, 'resume on non-stalled slice should fail');
    assert.ok(
      stderr.includes('not stalled') || stdout.includes('not stalled'),
      'error should mention not stalled',
    );
  });

  it('zelto resume rejects non-existent slice', async () => {
    const { stderr, code } = await zelto('resume', 'non-existent-slice');
    assert.notEqual(code, 0, 'resume on non-existent slice should fail');
    assert.ok(stderr.includes('not found'), 'error should mention not found');
  });

  it('zelto stall shows empty when no stalled slices', async () => {
    // Create a clean directory with no stalled slices
    const cleanDir = join(tmpdir(), `zelto-stall-empty-${Date.now()}`);
    await mkdir(join(cleanDir, '.zelto', 'slices'), { recursive: true });
    await mkdir(join(cleanDir, '.zelto', 'events'), { recursive: true });

    // Create a normal (non-stalled) slice
    const now = new Date().toISOString();
    const normalSlice = {
      id: 'only-normal',
      title: 'Only normal slice',
      state: 'frozen',
      stall: { class: null, autoResolved: 0, gateRetries: 0 },
      spec: { path: '', frozenHash: null, frozenAt: null },
      acceptance: { dir: '', frozenHash: null, oracleSrc: null },
      baseCommit: null, drift: { detected: false, reason: null, at: null },
      trace: { requirements: [], contracts: [], tests: [] },
      traceWaiver: null, writes: [], runs: [],
      createdAt: now, updatedAt: now,
    };
    await writeFile(join(cleanDir, '.zelto', 'slices', 'only-normal.json'), JSON.stringify(normalSlice, null, 2));

    const child = spawn('node', [CLI_SCRIPT, 'stall'], {
      cwd: cleanDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const cleanCode = await new Promise<number>((resolve) => {
      child.on('close', (code) => resolve(code ?? 1));
    });

    assert.equal(cleanCode, 0, 'stall on empty should exit 0');
    assert.ok(
      stdout.includes('No stalled'),
      `should show empty state: ${stdout}`,
    );

    await rm(cleanDir, { recursive: true, force: true });
  });
});
