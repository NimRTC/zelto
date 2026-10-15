import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const TEST_DIR = join(tmpdir(), `zelto-init-test-${Date.now()}`);
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');

describe('zelto init', () => {
  before(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  function runInit(): Promise<{ stdout: string; code: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn('node', [CLI_SCRIPT, 'init'], {
        cwd: TEST_DIR,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('close', (code) => resolve({ stdout, code: code ?? 1 }));
      child.on('error', reject);
    });
  }

  it('creates .zelto directory structure', async () => {
    const { stdout, code } = await runInit();

    assert.equal(code, 0);
    assert.ok(stdout.includes('initialized'));
    assert.ok(existsSync(join(TEST_DIR, '.zelto', 'slices')));
    assert.ok(existsSync(join(TEST_DIR, '.zelto', 'events')));
    assert.ok(existsSync(join(TEST_DIR, '.zelto', 'locks')));
    assert.ok(existsSync(join(TEST_DIR, '.zelto', 'config.yaml')));

    const config = await readFile(join(TEST_DIR, '.zelto', 'config.yaml'), 'utf-8');
    assert.ok(config.includes('commands:'));
    assert.ok(config.includes('timeoutSec: 120'));
  });

  it('skips when .zelto already exists', async () => {
    const { stdout, code } = await runInit();

    assert.equal(code, 0);
    assert.ok(stdout.includes('already exists'));
  });

  it('does not overwrite existing config.yaml', async () => {
    const configPath = join(TEST_DIR, '.zelto', 'config.yaml');
    await writeFile(configPath, '# custom config', 'utf-8');

    const { code } = await runInit();
    assert.equal(code, 0);

    const config = await readFile(configPath, 'utf-8');
    assert.equal(config, '# custom config');
  });
});
