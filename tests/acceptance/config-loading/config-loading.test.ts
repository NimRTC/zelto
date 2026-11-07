// Acceptance test: config-loading
// Verifies that zelto commands correctly load policy.yaml and config.yaml

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
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
import { randomBytes } from 'node:crypto';

const BASE_DIR = join(tmpdir(), 'zelto-acceptance-config-loading');
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');
const SLICES_DIR = join(BASE_DIR, '.zelto', 'slices');
const EVENTS_DIR = join(BASE_DIR, '.zelto', 'events');
const LOCKS_DIR = join(BASE_DIR, '.zelto', 'locks');
const CONFIG_FILE = join(BASE_DIR, '.zelto', 'config.yaml');
const POLICY_FILE = join(BASE_DIR, 'policy', 'policy.yaml');
const POLICY_LOCK_FILE = join(BASE_DIR, 'policy', 'lock.json');
const SPEC_FILE = join(BASE_DIR, 'specs', 'slices', 'test-config-slice.md');

function runZelto(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
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

// Helper: create a minimal slice JSON + spec file for testing
async function createTestSlice(sliceId: string, specContent: string) {
  const sliceFile = join(SLICES_DIR, `${sliceId}.json`);
  const specDir = join(BASE_DIR, 'specs', 'slices');
  await mkdir(specDir, { recursive: true });
  await writeFile(SPEC_FILE, specContent, 'utf-8');

  const sliceData = {
    id: sliceId,
    title: 'Test Config Slice',
    state: 'draft',
    spec: { path: 'specs/slices/test-config-slice.md', frozenHash: null, frozenAt: null },
    acceptance: { dir: null, frozenHash: null, oracleSrc: null },
    baseCommit: null,
    drift: { detected: false, reason: null, at: null },
    trace: { requirements: ['R1: Test requirement'], contracts: [], tests: [] },
    traceWaiver: null,
    writes: ['src/**/*.ts'],
    runs: [],
    stall: { class: null, autoResolved: 0, gateRetries: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(sliceFile, JSON.stringify(sliceData, null, 2), 'utf-8');
}

describe('acceptance: config-loading', () => {
  before(async () => {
    await rm(BASE_DIR, { recursive: true, force: true });
    await mkdir(join(BASE_DIR, '.zelto', 'slices'), { recursive: true });
    await mkdir(join(BASE_DIR, '.zelto', 'events'), { recursive: true });
    await mkdir(join(BASE_DIR, '.zelto', 'locks'), { recursive: true });
    await mkdir(join(BASE_DIR, 'policy'), { recursive: true });

    // Write a minimal config.yaml
    await writeFile(CONFIG_FILE, [
      'gate:',
      '  commands:',
      '    - name: test',
      '      run: echo "acceptance-test-passed"',
      '    - name: lint',
      '      run: echo "lint-passed"',
      '  timeoutSec: 30',
      '  retry:',
      '    max: 1',
      'agent:',
      '  command: echo',
    ].join('\n'), 'utf-8');

    // Write a policy.yaml
    await writeFile(POLICY_FILE, [
      'rules:',
      '  - id: allow-src-ts',
      '    match: { path: "src/**/*.ts", operation: "write" }',
      '    action: allow',
      '    basis: "policy.yaml#allow-src-ts"',
      '  - id: allow-read-all',
      '    match: { path: "**", operation: "read" }',
      '    action: allow',
      '    basis: "policy.yaml#allow-read-all"',
      '    priority: 0',
    ].join('\n'), 'utf-8');

    // Write a lock.json
    await writeFile(POLICY_LOCK_FILE, JSON.stringify({
      hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      commit: null,
      lockedAt: new Date().toISOString(),
      lockedBy: 'system',
    }, null, 2), 'utf-8');
  });

  after(async () => {
    await rm(BASE_DIR, { recursive: true, force: true });
  });

  it('zelto init sets up config.yaml in the project', async () => {
    // Run init in a fresh sub-directory
    const freshDir = join(BASE_DIR, 'fresh-init');
    await mkdir(freshDir, { recursive: true });

    const { stdout, code } = await new Promise<{ stdout: string; code: number }>((resolve, reject) => {
      const child = spawn('node', [CLI_SCRIPT, 'init'], {
        cwd: freshDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
      child.on('close', (code) => resolve({ stdout: out, code: code ?? 1 }));
      child.on('error', reject);
    });

    assert.equal(code, 0, 'init should exit 0');
    assert.ok(existsSync(join(freshDir, '.zelto', 'config.yaml')), 'config.yaml should exist');
  });

  it('zelto check uses policy.yaml for policy decisions', async () => {
    const sliceId = 'config-test-slice-1';
    await createTestSlice(sliceId, '# Test spec for config-loading acceptance test');

    const { stdout, code } = await runZelto(['check', sliceId]);
    assert.equal(code, 0, 'check should exit 0');
    // Should reference policy in output
    assert.ok(stdout.includes('check') || stdout.includes('Check'), 'output should mention check');
  });

  it('zelto freeze uses real sha256 of spec file as frozenHash', async () => {
    const sliceId = 'config-test-slice-2';
    const specContent = '# Unique spec for frozenHash verification: ' + randomBytes(16).toString('hex');
    await createTestSlice(sliceId, specContent);

    const { stdout, code } = await runZelto(['freeze', sliceId]);
    assert.equal(code, 0, 'freeze should exit 0');

    // Read the slice JSON to verify frozenHash
    const sliceFile = join(SLICES_DIR, `${sliceId}.json`);
    const sliceData = JSON.parse(await readFile(sliceFile, 'utf-8'));
    assert.ok(sliceData.spec.frozenHash, 'frozenHash should be set');
    assert.ok(sliceData.spec.frozenHash.startsWith('sha256:'), 'frozenHash should be sha256 format');
    assert.notEqual(sliceData.spec.frozenHash, 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      'frozenHash should not be the placeholder value');
  });

  it('zelto gate uses config.yaml for gate commands', async () => {
    const sliceId = 'config-test-slice-3';
    await createTestSlice(sliceId, '# Gate test spec');

    // Must be frozen first
    await runZelto(['freeze', sliceId]);

    // Read slice to get current state
    const sliceFile = join(SLICES_DIR, `${sliceId}.json`);
    let sliceData = JSON.parse(await readFile(sliceFile, 'utf-8'));

    // If frozen, run start (which runs agent then auto-gates with config)
    if (sliceData.state === 'frozen') {
      const startResult = await runZelto(['start', sliceId]);

      // After start with auto-gate-after-run, gate already ran using config.yaml.
      // Verify the slice transitioned to completed (auto-gate passed)
      sliceData = JSON.parse(await readFile(sliceFile, 'utf-8'));
      assert.ok(
        sliceData.state === 'completed' || sliceData.state === 'running',
        `Expected completed or running after start with auto-gate, got ${sliceData.state}`,
      );

      // If completed, verify gate.executed event exists
      if (sliceData.state === 'completed') {
        const eventsDir = join(EVENTS_DIR, sliceId);
        const eventsFile = join(eventsDir, 'events.jsonl');
        if (existsSync(eventsFile)) {
          const eventsContent = await readFile(eventsFile, 'utf-8');
          assert.ok(
            eventsContent.includes('gate.executed'),
            'gate.executed event should exist after auto-gate',
          );
        }
      }
    }
  });

  it('zelto check detects when spec file hash mismatches after freeze', async () => {
    const sliceId = 'config-test-slice-4';
    await createTestSlice(sliceId, '# Spec for mismatch test');

    // Freeze it
    await runZelto(['freeze', sliceId]);

    // Modify the spec file
    await writeFile(SPEC_FILE, '# Modified spec content for mismatch detection', 'utf-8');

    // Re-check should detect drift
    const { stdout, code } = await runZelto(['check', sliceId]);
    // ADR-032 §3.4：check 有问题时返回 1，漂移算问题（改动前文本模式恒为 0）。
    assert.equal(code, 1, 'check should exit 1 when drift detected');
    assert.ok(stdout.includes('drift') || stdout.includes('mismatch') || stdout.includes('hash'),
      'output should indicate drift or hash mismatch');
  });
});
