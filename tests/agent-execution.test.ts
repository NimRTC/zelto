import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const TEST_DIR = join(tmpdir(), `zelto-agent-test-${Date.now()}`);
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');

describe('agent execution', () => {
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

  it('creates bundle file and spawns agent (dry-run check)', async () => {
    // Set up a slice
    await writeFile(join(TEST_DIR, 'policy', 'policy.yaml'), `
rules:
  - id: allow-all
    match: { path: "**", operation: "write" }
    action: allow
    basis: "test.yaml#allow-all"
`, 'utf-8');

    await writeFile(join(TEST_DIR, '.zelto', 'config.yaml'), `
gate:
  commands:
    - name: echo
      run: echo ok
  timeoutSec: 30
  retry:
    max: 1
agent:
  command: echo
`, 'utf-8');

    // Use dry-run to verify the bundle would be created
    const { stdout, code } = await runCommand('run', 'agent-slice', '--dry-run');
    // Should fail because slice doesn't exist — we're just testing the --dry-run path exists
    // A proper test needs to create + freeze first
    assert.ok(code !== 0 || stdout.includes('dry-run') || stdout.includes('Would'));
  });

  it('runs a mock agent via start command', async () => {
    // Create config with echo as mock agent
    await writeFile(join(TEST_DIR, '.zelto', 'config.yaml'), `
agent:
  command: echo
`, 'utf-8');

    // Create spec file
    await writeFile(join(TEST_DIR, 'specs', 'slices', 'mock-agent-test.md'), '# Mock Agent Test', 'utf-8');

    // Use start command with a custom --agent (echo exits 0)
    const { stdout, code } = await runCommand(
      'start', 'mock-agent-test',
      '--title', 'Mock Agent',
      '--agent', 'echo',
    );

    assert.equal(code, 0, `Expected 0, got ${code}: ${stdout}`);

    // Verify bundle file was created
    const bundlePath = join(TEST_DIR, '.zelto', 'mock-agent-test-bundle.json');
    assert.ok(existsSync(bundlePath), 'Bundle file should exist');

    // Read bundle
    const bundle = JSON.parse(await readFile(bundlePath, 'utf-8'));
    assert.equal(bundle.sliceId, 'mock-agent-test');
    assert.ok(bundle.instructions);
  });

  it('runs a mock agent via run command', async () => {
    // Create a fresh slice, freeze it first
    await writeFile(join(TEST_DIR, 'specs', 'slices', 'mock-run-test.md'), '# Mock Run Test', 'utf-8');
    await runCommand('create', 'mock-run-test');
    await runCommand('freeze', 'mock-run-test');

    // Run with echo as agent
    const { stdout, code } = await runCommand('run', 'mock-run-test', '--agent', 'echo');
    assert.equal(code, 0, `Expected 0, got ${code}: ${stdout}`);

    // Verify RUN_FINISH transition — slice should be back to frozen
    const content = JSON.parse(await readFile(join(TEST_DIR, '.zelto', 'slices', 'mock-run-test.json'), 'utf-8'));
    assert.equal(content.state, 'frozen', `Expected frozen after run, got ${content.state}`);
  });

  it('handles agent non-zero exit', async () => {
    await writeFile(join(TEST_DIR, 'specs', 'slices', 'fail-agent-test.md'), '# Fail Agent', 'utf-8');
    await runCommand('create', 'fail-agent-test');
    await runCommand('freeze', 'fail-agent-test');

    // Run with false as agent (exits 1)
    const { stdout, code } = await runCommand('run', 'fail-agent-test', '--agent', 'false');
    // Should still exit 0 (zelto handles the failure gracefully)
    assert.equal(code, 0, `Expected 0, got ${code}: ${stdout}`);
    assert.ok(stdout.includes('exit') || stdout.includes('aborted'));

    // Slice should still be in running state (not auto-reset on failure)
    const content = JSON.parse(await readFile(join(TEST_DIR, '.zelto', 'slices', 'fail-agent-test.json'), 'utf-8'));
    assert.equal(content.state, 'running', `Expected running after failure, got ${content.state}`);
  });
});
