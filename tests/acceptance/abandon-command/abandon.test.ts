import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const BASE_DIR = join(tmpdir(), 'zelto-acceptance-abandon-test');
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');

function zelto(...args: string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI_SCRIPT, ...args], {
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

async function readSlice(id: string): Promise<any> {
  return JSON.parse(await readFile(join(BASE_DIR, '.zelto', 'slices', `${id}.json`), 'utf-8'));
}

describe('acceptance: zelto abandon', () => {
  before(async () => {
    await mkdir(BASE_DIR, { recursive: true });
    await initZelto();
  });

  after(async () => {
    await rm(BASE_DIR, { recursive: true, force: true });
  });

  it('abandons a draft slice', async () => {
    await zelto('create', 'abandon-draft');
    const { stdout, code } = await zelto('abandon', 'abandon-draft');
    assert.equal(code, 0);

    const slice = await readSlice('abandon-draft');
    assert.equal(slice.state, 'abandoned');
    assert.ok(stdout.includes('Previous state:'), 'output should show previous state');
    assert.ok(stdout.includes('abandoned'), 'output should mention abandoned');
  });

  it('rejects already-abandoned slices', async () => {
    await zelto('create', 'double-abandon');
    await zelto('abandon', 'double-abandon');
    const { stdout, code } = await zelto('abandon', 'double-abandon');
    assert.notEqual(code, 0, 'already abandoned should exit non-zero');
    assert.ok(stdout.includes('already abandoned'), 'output should mention already abandoned');
  });

  it('rejects non-existent slices', async () => {
    const { stdout, code } = await zelto('abandon', 'does-not-exist');
    assert.notEqual(code, 0);
    assert.ok(stdout.includes('Error'), 'output should contain Error');
  });

  it('shows previous state in output', async () => {
    await zelto('create', 'state-check');
    const { stdout } = await zelto('abandon', 'state-check');
    assert.ok(stdout.includes('draft'), 'should show previous state was draft');
    assert.ok(stdout.includes('abandoned'), 'should show now is abandoned');
  });
});
