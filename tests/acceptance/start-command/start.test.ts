import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const BASE_DIR = join(tmpdir(), 'zelto-acceptance-start-test');
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

describe('acceptance: zelto start', () => {
  before(async () => {
    await mkdir(BASE_DIR, { recursive: true });
    await mkdir(join(BASE_DIR, '.zelto', 'slices'), { recursive: true });
    await mkdir(join(BASE_DIR, '.zelto', 'events'), { recursive: true });
    // Use echo as agent so it doesn't hang
    await writeFile(join(BASE_DIR, '.zelto', 'config.yaml'), [
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
    ].join('\n'), 'utf-8');
  });

  after(async () => {
    await rm(BASE_DIR, { recursive: true, force: true });
  });

  it('runs full start flow on a new slice', async () => {
    const { stdout, code } = await zelto('start', 'new-slice', '--title', 'New Slice');
    assert.equal(code, 0, `Expected 0, got ${code}: ${stdout}`);
    assert.ok(/created/i.test(stdout), 'should show created');
    assert.ok(/frozen/i.test(stdout), 'should mention frozen');
    assert.ok(stdout.includes('Agent:'), 'should show agent info');
    assert.ok(stdout.includes('completed successfully'), 'should show completion');
  });

  it('skips create for existing draft slice', async () => {
    await zelto('create', 'existing-draft');
    const { stdout, code } = await zelto('start', 'existing-draft');
    assert.equal(code, 0, `Expected 0, got ${code}: ${stdout}`);
    assert.ok(/already exists/i.test(stdout), 'should mention existing');
    assert.ok(stdout.includes('Agent:'), 'should run agent');
  });

  it('produces a valid bundle file', async () => {
    await zelto('start', 'bundle-check');
    const bundlePath = join(BASE_DIR, '.zelto', 'bundle-check-bundle.json');
    assert.ok(existsSync(bundlePath), 'bundle file should exist');
    const bundle = JSON.parse(await readFile(bundlePath, 'utf-8'));
    assert.ok(bundle.writes, 'bundle should have writes');
    assert.ok(bundle.protectedPaths, 'bundle should have protectedPaths');
  });
});
