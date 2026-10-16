import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const TEST_DIR = join(tmpdir(), `zelto-event-test-${Date.now()}`);
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');

describe('event emission', () => {
  before(async () => {
    await mkdir(join(TEST_DIR, '.zelto', 'slices'), { recursive: true });
    await mkdir(join(TEST_DIR, '.zelto', 'events'), { recursive: true });
    await mkdir(join(TEST_DIR, '.zelto', 'locks'), { recursive: true });
    await mkdir(join(TEST_DIR, 'specs', 'slices'), { recursive: true });
    await mkdir(join(TEST_DIR, 'policy'), { recursive: true });
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  function runCommand(...args: string[]): Promise<{ stdout: string; code: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn('node', [CLI_SCRIPT, ...args], {
        cwd: TEST_DIR,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('close', (code) => resolve({ stdout: stdout || stderr, code: code ?? 1 }));
      child.on('error', reject);
    });
  }

  async function readEvents(sliceId: string): Promise<any[]> {
    try {
      const content = await readFile(join(TEST_DIR, '.zelto', 'events', sliceId, 'events.jsonl'), 'utf-8');
      return content.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  it('emits spec.frozen on freeze', async () => {
    await runCommand('create', 'event-freeze-test', '--title', 'Freeze Event');
    await writeFile(join(TEST_DIR, 'specs', 'slices', 'event-freeze-test.md'), '# freeze event', 'utf-8');
    await runCommand('freeze', 'event-freeze-test');

    const events = await readEvents('event-freeze-test');
    const frozenEvts = events.filter((e) => e.type === 'spec.frozen');
    assert.equal(frozenEvts.length, 1, 'Should have 1 spec.frozen event');
    assert.ok(frozenEvts[0].payload.frozenHash);
    assert.ok(frozenEvts[0].payload.frozenAt);
  });

  it('emits spec.checked on check', async () => {
    await runCommand('create', 'event-check-test', '--title', 'Check Event');
    await writeFile(join(TEST_DIR, 'specs', 'slices', 'event-check-test.md'), '# check event', 'utf-8');
    await runCommand('freeze', 'event-check-test');
    await runCommand('check', 'event-check-test');

    const events = await readEvents('event-check-test');
    const checkEvts = events.filter((e) => e.type === 'spec.checked');
    assert.equal(checkEvts.length, 1, 'Should have 1 spec.checked event');
  });

  it('emits spec.frozen via clarify --auto', async () => {
    await runCommand('create', 'event-clarify-test', '--title', 'Clarify Event');
    await runCommand('clarify', 'event-clarify-test', '--auto');

    const events = await readEvents('event-clarify-test');
    const frozenEvts = events.filter((e) => e.type === 'spec.frozen');
    assert.equal(frozenEvts.length, 1, 'Should have 1 spec.frozen from clarify');
  });

  it('emits slice.drift_detected on hash mismatch', async () => {
    await runCommand('create', 'event-drift-test', '--title', 'Drift Event');
    await writeFile(join(TEST_DIR, 'specs', 'slices', 'event-drift-test.md'), '# original', 'utf-8');
    await runCommand('freeze', 'event-drift-test');

    // Modify spec to trigger drift
    await writeFile(join(TEST_DIR, 'specs', 'slices', 'event-drift-test.md'), '# modified', 'utf-8');
    await runCommand('check', 'event-drift-test');

    const events = await readEvents('event-drift-test');
    const driftEvts = events.filter((e) => e.type === 'slice.drift_detected');
    assert.equal(driftEvts.length, 1, 'Should have 1 slice.drift_detected event');
    assert.ok(driftEvts[0].payload.expectedHash);
    assert.ok(driftEvts[0].payload.actualHash);
  });
});
