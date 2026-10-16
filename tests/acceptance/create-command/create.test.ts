import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const BASE_DIR = join(tmpdir(), 'zelto-acceptance-create-test');
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');

function runCreate(...args: string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI_SCRIPT, 'create', ...args], {
      cwd: BASE_DIR,
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

async function initZelto(): Promise<void> {
  await mkdir(join(BASE_DIR, '.zelto', 'slices'), { recursive: true });
  await mkdir(join(BASE_DIR, '.zelto', 'events'), { recursive: true });
}

describe('acceptance: zelto create', () => {
  before(async () => {
    await mkdir(BASE_DIR, { recursive: true });
    await initZelto();
  });

  after(async () => {
    await rm(BASE_DIR, { recursive: true, force: true });
  });

  it('creates a slice file with state draft', async () => {
    const { stdout, code } = await runCreate('my-slice');
    assert.equal(code, 0, 'create should exit with code 0');
    assert.ok(stdout.includes('✅'), 'output should show success indicator');

    const slicePath = join(BASE_DIR, '.zelto', 'slices', 'my-slice.json');
    assert.ok(existsSync(slicePath), 'slice JSON file should exist');

    const slice = JSON.parse(await readFile(slicePath, 'utf-8'));
    assert.equal(slice.id, 'my-slice');
    assert.equal(slice.state, 'draft');
    assert.equal(slice.title, 'my-slice');
    assert.equal(slice.spec.path, 'specs/slices/my-slice.md');
  });

  it('uses custom --title when provided', async () => {
    await runCreate('my-title-test', '--title', 'My Custom Title');

    const slicePath = join(BASE_DIR, '.zelto', 'slices', 'my-title-test.json');
    const slice = JSON.parse(await readFile(slicePath, 'utf-8'));
    assert.equal(slice.id, 'my-title-test');
    assert.equal(slice.title, 'My Custom Title');
  });

  it('rejects duplicate slice creation', async () => {
    await runCreate('dup-slice');
    const { stdout, code } = await runCreate('dup-slice');
    assert.notEqual(code, 0, 'duplicate create should exit with non-zero');
    assert.ok(stdout.includes('already exists'), 'output should mention already exists');
  });

  it('outputs structured success info', async () => {
    const { stdout, code } = await runCreate('info-check');
    assert.equal(code, 0);
    assert.ok(stdout.includes('ID:'), 'output should contain ID:');
    assert.ok(stdout.includes('Title:'), 'output should contain Title:');
    assert.ok(stdout.includes('State:'), 'output should contain State:');
    assert.ok(stdout.includes('Next:'), 'output should contain Next:');
    assert.ok(stdout.includes('draft'), 'output should mention draft state');
  });

  it('rejects invalid slice IDs', async () => {
    const { stdout, code } = await runCreate('invalid id with spaces');
    assert.notEqual(code, 0, 'invalid ID should exit with non-zero');
    assert.ok(stdout.includes('Invalid'), 'output should mention invalid');
  });
});
