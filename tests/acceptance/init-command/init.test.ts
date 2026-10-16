import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const BASE_DIR = join(tmpdir(), 'zelto-acceptance-init-test');
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');

function runInit(): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI_SCRIPT, 'init'], {
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

describe('acceptance: zelto init', () => {
  before(async () => {
    await mkdir(BASE_DIR, { recursive: true });
  });

  after(async () => {
    await rm(BASE_DIR, { recursive: true, force: true });
  });

  it('creates .zelto directory structure on first run', async () => {
    const { stdout, code } = await runInit();
    assert.equal(code, 0, 'init should exit with code 0');
    assert.ok(stdout.includes('.zelto'), 'output should mention .zelto');

    const sliceDir = join(BASE_DIR, '.zelto', 'slices');
    const eventsDir = join(BASE_DIR, '.zelto', 'events');
    const locksDir = join(BASE_DIR, '.zelto', 'locks');
    const configFile = join(BASE_DIR, '.zelto', 'config.yaml');

    assert.ok(existsSync(sliceDir), 'slices/ dir should exist');
    assert.ok(existsSync(eventsDir), 'events/ dir should exist');
    assert.ok(existsSync(locksDir), 'locks/ dir should exist');
    assert.ok(existsSync(configFile), 'config.yaml should exist');
  });

  it('succeeds on second run without overwriting config', async () => {
    await runInit();
    const configPath = join(BASE_DIR, '.zelto', 'config.yaml');
    const originalContent = await readFile(configPath, 'utf-8');
    const modifiedContent = originalContent + '\n# custom comment\n';
    const { writeFile } = await import('node:fs/promises');
    await writeFile(configPath, modifiedContent, 'utf-8');

    const { stdout, code } = await runInit();
    assert.equal(code, 0, 'second init should exit with code 0');
    assert.ok(stdout.includes('already') || stdout.includes('skip') || stdout.includes('exist'),
      'output should indicate skipping existing items');

    const afterContent = await readFile(configPath, 'utf-8');
    assert.equal(afterContent, modifiedContent, 'config.yaml should not be overwritten');
  });

  it('outputs clear status information', async () => {
    const { stdout, code } = await runInit();
    assert.equal(code, 0);
    assert.ok(stdout.includes('✓') || stdout.includes('✅') || stdout.includes('created') || stdout.includes('exist'),
      'output should contain status indicators');
  });
});
