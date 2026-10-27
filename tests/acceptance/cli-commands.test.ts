/**
 * Acceptance tests for audit, snapshot, and policy CLI commands.
 *
 * Tests run in a temporary directory with a minimal zelto project setup.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_DIR = join(tmpdir(), `zelto-cli-acceptance-${Date.now()}`);
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');

function runCli(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI_SCRIPT, ...args], {
      cwd: TEST_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }));
    child.on('error', reject);
  });
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const POLICY_YAML = `rules:
  - id: allow-src
    match: { path: "src/**/*.ts", operation: "write" }
    action: allow
    basis: "policy.yaml#allow-src"
  - id: deny-policy
    match: { path: "policy/**", operation: "write" }
    action: deny
    basis: "AGENTS.md#禁区"
  - id: ask-sensitive
    match: { path: "config/**", operation: "write" }
    action: ask
    basis: "policy.yaml#ask-sensitive"
  - id: allow-read-all
    match: { path: "**", operation: "read" }
    action: allow
    basis: "policy.yaml#allow-read-all"
    priority: 0
  - id: allow-specs
    match: { path: "specs/**", operation: "write" }
    action: allow
    basis: "policy.yaml#allow-specs"
  - id: deny-hook
    match: { path: "zelto-hook", operation: "write" }
    action: deny
    basis: "AGENTS.md#禁区"
`;

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

before(async () => {
  await mkdir(TEST_DIR, { recursive: true });

  // Initialize zelto project
  const initResult = await runCli('init');
  assert.equal(initResult.code, 0, `init failed: ${initResult.stderr}`);

  // Create minimal policy file
  await mkdir(join(TEST_DIR, 'policy'), { recursive: true });
  await writeFile(join(TEST_DIR, 'policy', 'policy.yaml'), POLICY_YAML, 'utf-8');
});

after(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

// ─── Policy Command Tests ─────────────────────────────────────────────────────

void describe('zelto policy', () => {
  void it('policy without args shows usage', async () => {
    const { stdout, code } = await runCli('policy');
    assert.equal(code, 0);
    assert.ok(stdout.includes('Usage'));
    assert.ok(stdout.includes('list'));
    assert.ok(stdout.includes('check'));
    assert.ok(stdout.includes('validate'));
  });

  void it('policy --help shows usage', async () => {
    const { stdout, code } = await runCli('policy', '--help');
    assert.equal(code, 0);
    assert.ok(stdout.includes('Usage'));
  });

  void it('policy list shows rules', async () => {
    const { stdout, code } = await runCli('policy', 'list');
    assert.equal(code, 0);
    assert.ok(stdout.includes('allow-src'));
    assert.ok(stdout.includes('deny-policy'));
    assert.ok(stdout.includes('allow-read-all'));
  });

  void it('policy list --json outputs valid JSON', async () => {
    const { stdout, code } = await runCli('policy', 'list', '--json');
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.ok(Array.isArray(parsed.rules));
    assert.equal(parsed.rules.length, 6);
    assert.ok(parsed.rules.some((r: { id: string }) => r.id === 'allow-src'));
  });

  void it('policy check accepts allowed path', async () => {
    const { stdout, code } = await runCli('policy', 'check', 'src/foo.ts', '--operation', 'write');
    assert.equal(code, 0);
    assert.ok(stdout.includes('allow') || stdout.includes('allow-src'));
  });

  void it('policy check denies protected path', async () => {
    const { stdout, code } = await runCli('policy', 'check', 'policy/policy.yaml', '--operation', 'write');
    assert.equal(code, 0);
    assert.ok(stdout.includes('deny') || stdout.includes('deny-policy'));
  });

  void it('policy check without path shows error', async () => {
    const { stderr, code } = await runCli('policy', 'check');
    assert.equal(code, 1);
    assert.ok(stderr.includes('required'));
  });

  void it('policy validate passes on valid policy', async () => {
    const { stdout, code } = await runCli('policy', 'validate');
    assert.equal(code, 0);
    assert.ok(stdout.includes('PASSED'));
  });

  void it('policy validate --json outputs valid JSON', async () => {
    const { stdout, code } = await runCli('policy', 'validate', '--json');
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.valid, true);
  });

  void it('policy add creates new rule', async () => {
    const { stdout, code } = await runCli(
      'policy', 'add', 'test-rule',
      '--path', 'test/**',
      '--operation', 'write',
      '--action', 'allow',
      '--basis', 'test',
      '--description', 'Test rule',
    );
    assert.equal(code, 0);

    // Verify it appears in list
    const listResult = await runCli('policy', 'list');
    assert.ok(listResult.stdout.includes('test-rule'));
  });

  void it('policy add without required args shows error', async () => {
    const { stderr, code } = await runCli('policy', 'add', 'my-rule', '--path', 'test/**');
    // Missing --action and --basis
    assert.equal(code, 1);
    assert.ok(stderr.includes('required') || stderr.includes('Error'));
  });

  void it('policy remove deletes a rule', async () => {
    // First ensure the rule exists (added by previous test)
    const { code } = await runCli('policy', 'remove', 'test-rule');
    assert.equal(code, 0);

    // Verify it's gone
    const listResult = await runCli('policy', 'list');
    assert.equal(listResult.stdout.includes('test-rule'), false);
  });

  void it('policy unknown subcommand shows error', async () => {
    const { stderr, code } = await runCli('policy', 'nonexistent');
    assert.equal(code, 1);
    assert.ok(stderr.includes('Unknown'));
  });
});

// ─── Audit Command Tests ──────────────────────────────────────────────────────

void describe('zelto audit', () => {
  void it('audit without args shows usage', async () => {
    const { stdout, code } = await runCli('audit');
    assert.equal(code, 0);
    assert.ok(stdout.includes('Usage'));
    assert.ok(stdout.includes('slice-id'));
  });

  void it('audit --help shows usage', async () => {
    const { stdout, code } = await runCli('audit', '--help');
    assert.equal(code, 0);
    assert.ok(stdout.includes('Usage'));
  });

  void it('audit nonexistent slice shows error', async () => {
    const { stderr, code } = await runCli('audit', 'nonexistent-slice');
    assert.equal(code, 1);
    assert.ok(stderr.includes('not found'));
  });

  void it('audit existing slice shows audit trail', async () => {
    // First create a slice so there's something to audit
    await runCli('create', 'test-audit-slice');
    await runCli('freeze', 'test-audit-slice');

    const { stdout, code } = await runCli('audit', 'test-audit-slice');
    assert.equal(code, 0);
    assert.ok(stdout.includes('Audit Trail'));
    assert.ok(stdout.includes('test-audit-slice'));
  });

  void it('audit --json outputs valid JSON', async () => {
    const { stdout, code } = await runCli('audit', 'test-audit-slice', '--json');
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.sliceId, 'test-audit-slice');
    assert.ok(Array.isArray(parsed.entries));
  });
});

// ─── Snapshot Command Tests ───────────────────────────────────────────────────

void describe('zelto snapshot', () => {
  void it('snapshot captures project state', async () => {
    const { stdout, code } = await runCli('snapshot');
    assert.equal(code, 0);
    assert.ok(stdout.includes('Snapshot captured'));
    assert.ok(stdout.includes('snap-'));
  });

  void it('snapshot --help shows usage', async () => {
    const { stdout, code } = await runCli('snapshot', '--help');
    assert.equal(code, 0);
    assert.ok(stdout.includes('Usage'));
  });

  void it('snapshot list shows snapshots', async () => {
    const { stdout, code } = await runCli('snapshot', 'list');
    assert.equal(code, 0);
    assert.ok(stdout.includes('snap-'));
  });

  void it('snapshot show displays snapshot details', async () => {
    // Get the latest snapshot ID
    const listResult = await runCli('snapshot', 'list');
    const match = listResult.stdout.match(/snap-\d+/);
    assert.ok(match, 'No snapshot found');
    const snapId = match[0];

    const { stdout, code } = await runCli('snapshot', 'show', snapId);
    assert.equal(code, 0);
    assert.ok(stdout.includes(snapId));
    assert.ok(stdout.includes('Slices'));
  });

  void it('snapshot show nonexistent shows error', async () => {
    const { stderr, code } = await runCli('snapshot', 'show', 'snap-nonexistent');
    assert.equal(code, 1);
    assert.ok(stderr.includes('not found'));
  });

  void it('snapshot --json outputs valid JSON', async () => {
    const { stdout, code } = await runCli('snapshot', '--json');
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.ok(parsed.id.startsWith('snap-'));
    assert.ok(Array.isArray(parsed.slices));
  });
});
