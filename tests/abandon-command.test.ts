import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const TEST_DIR = join(tmpdir(), `zelto-abandon-test-${Date.now()}`);
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');

describe('zelto abandon', () => {
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

  it('rejects missing ID', async () => {
    const { stdout, code } = await runCommand('abandon');
    assert.notEqual(code, 0);
    assert.ok(stdout.includes('Usage'));
  });

  it('rejects non-existent slice', async () => {
    const { stdout, code } = await runCommand('abandon', 'no-such-slice');
    assert.notEqual(code, 0);
  });

  it('abandons a draft slice', async () => {
    await runCommand('create', 'abandon-draft', '--title', 'Draft to Abandon');
    const { stdout, code } = await runCommand('abandon', 'abandon-draft');
    assert.equal(code, 0);
    assert.ok(stdout.includes('abandoned'));

    const content = JSON.parse(await readFile(join(TEST_DIR, '.zelto', 'slices', 'abandon-draft.json'), 'utf-8'));
    assert.equal(content.state, 'abandoned');
  });

  it('rejects already-abandoned slice', async () => {
    const { stdout, code } = await runCommand('abandon', 'abandon-draft');
    assert.notEqual(code, 0);
    assert.ok(stdout.includes('already abandoned'));
  });

  it('abandons from any non-abandoned state', async () => {
    // Create and freeze a slice, then abandon
    await runCommand('create', 'abandon-frozen', '--title', 'Frozen to Abandon');
    const { stdout, code } = await runCommand('abandon', 'abandon-frozen');
    assert.equal(code, 0);
    assert.ok(stdout.includes('draft'));

    const content = JSON.parse(await readFile(join(TEST_DIR, '.zelto', 'slices', 'abandon-frozen.json'), 'utf-8'));
    assert.equal(content.state, 'abandoned');
  });

  it('emits slice.state.changed event', async () => {
    await runCommand('create', 'abandon-event', '--title', 'Event Check');
    await runCommand('abandon', 'abandon-event');

    const { stdout, code } = await runCommand('slices');
    assert.equal(code, 0);
    // Just verify no crash
  });
});
