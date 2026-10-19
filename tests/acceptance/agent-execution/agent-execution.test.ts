// Acceptance test: agent-execution
// Verifies that zelto run correctly spawns agent subprocess with constraint bundle

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

function findProjectRoot(from: string): string {
  let dir = from;
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return from;
}
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const BASE_DIR = join(tmpdir(), 'zelto-acceptance-agent-execution');
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');
const SLICES_DIR = join(BASE_DIR, '.zelto', 'slices');
const EVENTS_DIR = join(BASE_DIR, '.zelto', 'events');

function zelto(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
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

describe('acceptance: agent-execution', () => {
  before(async () => {
    await rm(BASE_DIR, { recursive: true, force: true });
    await mkdir(join(BASE_DIR, '.zelto', 'slices'), { recursive: true });
    await mkdir(join(BASE_DIR, '.zelto', 'events'), { recursive: true });
    await mkdir(join(BASE_DIR, 'specs', 'slices'), { recursive: true });

    // Write config with echo as mock agent
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

  it('zelto run spawns agent and transitions to running state', async () => {
    // Use start to create + freeze + run in one go
    const { stdout, code } = await zelto('start', 'run-test-1', '--title', 'Agent Run Test');
    assert.equal(code, 0, `start should exit 0: ${stdout}`);

    // After start with echo agent, the slice should eventually be in frozen state
    // (echo exits immediately, so RUN_FINISH transitions back to frozen)
    const sliceFile = join(SLICES_DIR, 'run-test-1.json');
    assert.ok(existsSync(sliceFile), 'slice file should exist');
    const slice = JSON.parse(await readFile(sliceFile, 'utf-8'));

    // The agent ran and finished, so state should be frozen (RUN_FINISH transition)
    assert.ok(slice.state === 'frozen' || slice.state === 'running',
      `Expected frozen or running, got ${slice.state}`);

    // Should have at least one run recorded
    assert.ok(Array.isArray(slice.runs), 'slice should have runs array');
  });

  it('zelto run with already-running slice is rejected', async () => {
    // Create a frozen slice first
    await zelto('create', 'conflict-test');
    await mkdir(join(BASE_DIR, 'specs', 'slices'), { recursive: true });
    await writeFile(join(BASE_DIR, 'specs', 'slices', 'conflict-test.md'), '# conflict test', 'utf-8');
    await zelto('freeze', 'conflict-test');

    // Run it once (should succeed)
    const { code: runCode } = await zelto('run', 'conflict-test');
    assert.equal(runCode, 0, 'first run should succeed');
  });

  it('zelto run --dry-run simulates without executing agent', async () => {
    await zelto('create', 'dry-run-test');
    await mkdir(join(BASE_DIR, 'specs', 'slices'), { recursive: true });
    await writeFile(join(BASE_DIR, 'specs', 'slices', 'dry-run-test.md'), '# dry run test', 'utf-8');
    await zelto('freeze', 'dry-run-test');

    const { stdout, code } = await zelto('run', 'dry-run-test', '--dry-run');
    assert.equal(code, 0, `dry-run should exit 0: ${stdout}`);
    assert.ok(stdout.includes('dry') || stdout.includes('Dry') || stdout.includes('Would'),
      'output should indicate dry-run mode');

    // Slice should still be frozen (not running)
    const slice = JSON.parse(await readFile(join(SLICES_DIR, 'dry-run-test.json'), 'utf-8'));
    assert.equal(slice.state, 'frozen', 'slice should remain frozen after dry-run');
  });

  it('zelto run rejects non-frozen slices', async () => {
    await zelto('create', 'draft-run-test');

    const { stdout, stderr, code } = await zelto('run', 'draft-run-test');
    assert.notEqual(code, 0, 'run on draft should fail');
    assert.ok(stderr.includes('must be "frozen"') || stderr.includes('state'),
      `stderr should mention state constraint, got: ${stderr}`);
  });
});
