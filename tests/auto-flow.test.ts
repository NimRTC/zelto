// Phase 2 tests: auto sign-request creation and auto-pilot flow
// Tests the automation features without spawning real agents

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const TEST_DIR = join(tmpdir(), `zelto-auto-flow-test-${Date.now()}`);
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');

function runCli(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI_SCRIPT, ...args], {
      cwd: TEST_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ZELTO_SKIP_LLM: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    child.on('error', reject);
    setTimeout(() => { child.kill(); reject(new Error('timeout')); }, 15000).unref();
  });
}

describe('Phase 2 — Auto sign-request & pipeline automation', () => {
  before(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    await mkdir(join(TEST_DIR, '.zelto', 'slices'), { recursive: true });
    await mkdir(join(TEST_DIR, '.zelto', 'events'), { recursive: true });
    await mkdir(join(TEST_DIR, '.zelto', 'locks'), { recursive: true });
    await mkdir(join(TEST_DIR, 'policy'), { recursive: true });

    // Create a minimal package.json so gate commands (pnpm test, pnpm lint) work
    await writeFile(join(TEST_DIR, 'package.json'), JSON.stringify({
      name: 'test-project',
      scripts: { test: 'echo ok', lint: 'echo ok' },
    }), 'utf-8');

    // Init zelto
    const { code } = await runCli('init');
    assert.equal(code, 0);

    // Override gate config to use simple commands for test environment
    await writeFile(join(TEST_DIR, '.zelto', 'config.yaml'), `# zelto project configuration
gate:
  commands:
    - { name: test, run: "node -e process.exit(0)" }
    - { name: lint, run: "node -e process.exit(0)" }
  timeoutSec: 30
  retry:
    max: 1
agent:
  command: npx claude-code
`, 'utf-8');
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('gate auto-creates sign request on pass', async () => {
    // Create a slice, freeze it (skip gate① by setting minimal data)
    const sliceId = 'test-auto-sign';
    let { code } = await runCli('create', sliceId, '--title', 'Auto sign test');
    assert.equal(code, 0);

    // Manually set it to frozen by writing frozen state
    const slicePath = join(TEST_DIR, '.zelto', 'slices', `${sliceId}.json`);
    const sliceData = JSON.parse(await readFile(slicePath, 'utf-8'));
    sliceData.state = 'frozen';
    sliceData.spec.frozenHash = 'sha256:test';
    sliceData.spec.frozenAt = new Date().toISOString();
    await writeFile(slicePath, JSON.stringify(sliceData, null, 2));

    // Run gate
    const result = await runCli('gate', sliceId);
    assert.equal(result.code, 0);
    assert.ok(result.stdout.includes('Gate passed'), `gate should pass: ${result.stdout}`);

    // Verify sign request was auto-created
    const locksDir = join(TEST_DIR, '.zelto', 'locks');
    assert.ok(existsSync(locksDir), 'locks directory should exist');
    const lockFiles = await readdir(locksDir);
    const signFiles = lockFiles.filter((f) => f.startsWith(`sign-${sliceId}`));
    assert.ok(signFiles.length > 0, `sign request should exist for ${sliceId}: ${lockFiles.join(', ')}`);

    // Verify the sign request content
    const signReq = JSON.parse(await readFile(join(locksDir, signFiles[0]), 'utf-8'));
    assert.equal(signReq.sliceId, sliceId);
    assert.equal(signReq.status, 'pending');
    assert.equal(signReq.requestedBy, 'zelto');
  });

  it('inbox shows pending sign requests', async () => {
    const { stdout, code } = await runCli('inbox', '--list');
    assert.equal(code, 0);
    assert.ok(stdout.includes('test-auto-sign'), `inbox should show test-auto-sign: ${stdout}`);
    assert.ok(stdout.includes('Pending'), `inbox should say pending: ${stdout}`);
  });

  it('sign --approve approves sign request', async () => {
    // Make sure the slice is in completed state for sign
    const slicePath = join(TEST_DIR, '.zelto', 'slices', 'test-auto-sign.json');
    const sliceData = JSON.parse(await readFile(slicePath, 'utf-8'));
    if (sliceData.state !== 'completed') {
      sliceData.state = 'completed';
      await writeFile(slicePath, JSON.stringify(sliceData, null, 2));
    }

    // Create a pending sign request if one doesn't exist
    const locksDir = join(TEST_DIR, '.zelto', 'locks');
    const signReqPath = join(locksDir, `sign-test-auto-sign-test.json`);
    if (!existsSync(signReqPath)) {
      await writeFile(signReqPath, JSON.stringify({
        id: 'sign-test-auto-sign-test',
        sliceId: 'test-auto-sign',
        requestedAt: new Date().toISOString(),
        requestedBy: 'zelto',
        status: 'pending',
        decidedAt: null,
        decidedBy: null,
        comment: null,
      }), 'utf-8');
    }

    // Approve the sign request
    const { code, stdout } = await runCli('sign', 'test-auto-sign', '--approve');
    assert.equal(code, 0, `sign approve should succeed: ${stdout}`);
    assert.ok(stdout.includes('Approved'), `should say approved: ${stdout}`);
  });

  it('version start --help shows auto flag', async () => {
    const { stderr, code } = await runCli('version', 'start');
    assert.equal(code, 1, 'version start without args should fail');
    assert.ok(stderr.includes('--auto'), `help should mention --auto: ${stderr}`);
  });

  it('version status shows no plans in test dir', async () => {
    const { stdout, code } = await runCli('version', 'status');
    assert.equal(code, 0);
    assert.ok(stdout.includes('No version plans'), `should show no plans: ${stdout}`);
  });

  it('pipeline status shows no requirements in test dir', async () => {
    const { stdout, code } = await runCli('pipeline', 'status');
    assert.equal(code, 0);
    assert.ok(stdout.includes('No requirements'), `should show no reqs: ${stdout}`);
  });
});

function readdir(dir: string): Promise<string[]> {
  return import('node:fs/promises').then((fs) => fs.readdir(dir));
}
