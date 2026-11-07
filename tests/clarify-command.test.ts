import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const TEST_DIR = join(tmpdir(), `zelto-clarify-test-${Date.now()}`);
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');

describe('zelto clarify', () => {
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
    const { stdout, code } = await runCommand('clarify');
    assert.notEqual(code, 0);
    assert.ok(stdout.includes('Usage'));
  });

  it('rejects non-existent slice', async () => {
    const { stdout, code } = await runCommand('clarify', 'no-such-slice', '--auto');
    assert.notEqual(code, 0);
  });

  it('rejects frozen slice', async () => {
    await runCommand('create', 'already-frozen', '--title', 'Frozen', '--requirement', 'REQ-1: 已冻结的切片不允许再澄清');
    await writeFile(join(TEST_DIR, 'specs', 'slices', 'already-frozen.md'), '# frozen', 'utf-8');
    await runCommand('freeze', 'already-frozen');

    const { stdout, code } = await runCommand('clarify', 'already-frozen', '--auto');
    assert.notEqual(code, 0);
    assert.ok(stdout.includes('frozen'));
  });

  it('shows questions in dry-run mode', async () => {
    await runCommand('create', 'dry-run-test', '--title', 'Dry Run');
    const { stdout, code } = await runCommand('clarify', 'dry-run-test', '--dry-run');
    assert.equal(code, 0);
    assert.ok(stdout.includes('dry-run'));
    assert.ok(stdout.includes('Questions: 5') || stdout.includes('Questions:'));
    assert.ok(stdout.includes('reqs') || stdout.includes('requirements'));
  });

  it('auto-answers and freezes slice', async () => {
    await runCommand('create', 'auto-test', '--title', 'Auto Answer');
    const { stdout, code } = await runCommand('clarify', 'auto-test', '--auto');
    assert.equal(code, 0, `Expected 0, got ${code}: ${stdout}`);
    assert.ok(stdout.includes('frozen'));

    // Verify slice state
    const content = JSON.parse(await readFile(join(TEST_DIR, '.zelto', 'slices', 'auto-test.json'), 'utf-8'));
    assert.equal(content.state, 'frozen');
    assert.ok(content.trace.requirements.length > 0);
    assert.ok(content.trace.contracts.length > 0);
    assert.ok(content.trace.tests.length > 0);
    assert.ok(content.writes.length > 0);
    assert.ok(content.acceptance.oracleSrc);
  });

  it('detects already-complete slice', async () => {
    await runCommand('create', 'complete-test', '--title', 'Complete');
    // Pre-fill trace
    const slicePath = join(TEST_DIR, '.zelto', 'slices', 'complete-test.json');
    const slice = JSON.parse(await readFile(slicePath, 'utf-8'));
    slice.trace.requirements = ['REQ-1'];
    slice.trace.contracts = ['CT-1'];
    slice.trace.tests = ['tests/test.ts'];
    slice.writes = ['src/**/*.ts'];
    slice.acceptance.oracleSrc = 'human';
    await writeFile(slicePath, JSON.stringify(slice, null, 2), 'utf-8');

    const { stdout, code } = await runCommand('clarify', 'complete-test', '--auto');
    assert.equal(code, 0);
    assert.ok(stdout.includes('No open questions'));
  });
});
