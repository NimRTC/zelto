import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const TEST_DIR = join(tmpdir(), `zelto-create-test-${Date.now()}`);
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');

describe('zelto create', () => {
  before(async () => {
    await mkdir(join(TEST_DIR, '.zelto', 'slices'), { recursive: true });
    await mkdir(join(TEST_DIR, '.zelto', 'events'), { recursive: true });
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  function runCreate(...args: string[]): Promise<{ stdout: string; code: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn('node', [CLI_SCRIPT, 'create', ...args], {
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

  it('creates a slice with default title', async () => {
    const { stdout, code } = await runCreate('my-test-slice');

    assert.equal(code, 0);
    assert.ok(stdout.includes('my-test-slice'));
    assert.ok(/created/i.test(stdout));

    const slicePath = join(TEST_DIR, '.zelto', 'slices', 'my-test-slice.json');
    assert.ok(existsSync(slicePath));

    const content = JSON.parse(await readFile(slicePath, 'utf-8'));
    assert.equal(content.id, 'my-test-slice');
    assert.equal(content.title, 'my-test-slice'); // default title = id
    assert.equal(content.state, 'draft');
  });

  it('creates a slice with custom title', async () => {
    const { stdout, code } = await runCreate('another-slice', '--title', '我的切片');

    assert.equal(code, 0);
    assert.ok(stdout.includes('another-slice'));

    const content = JSON.parse(await readFile(join(TEST_DIR, '.zelto', 'slices', 'another-slice.json'), 'utf-8'));
    assert.equal(content.id, 'another-slice');
    assert.equal(content.title, '我的切片');
  });

  it('rejects invalid slice ID', async () => {
    const { stdout, code } = await runCreate('bad id with spaces');

    assert.notEqual(code, 0);
    assert.ok(stdout.includes('Invalid'));
  });

  it('rejects when slice already exists', async () => {
    // First creation should succeed
    await runCreate('duplicate-slice');
    // Second should fail
    const { stdout, code } = await runCreate('duplicate-slice');

    assert.notEqual(code, 0);
    assert.ok(stdout.includes('already exists'));
  });

  it('requires an ID argument', async () => {
    const { stdout, code } = await runCreate('--title', 'no-id');

    assert.notEqual(code, 0);
    assert.ok(stdout.includes('Usage') || stdout.includes('slice-id'));
  });
});
