import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync, spawnSync } from 'node:child_process';

const ZELTO_CLI = join(import.meta.dirname, '..', '..', '..', 'dist', 'cli', 'index.js');
const TEST_DIR = join(tmpdir(), `zelto-accept-admit-${Date.now()}`);
const SLICES_DIR = join(TEST_DIR, 'slices');
const EVENTS_DIR = join(TEST_DIR, 'events');
const LOCKS_DIR = join(TEST_DIR, 'locks');
const CONFIG_PATH = join(TEST_DIR, 'config.yaml');
const SPEC_DIR = join(TEST_DIR, 'specs', 'slices');
const POLICY_DIR = join(TEST_DIR, 'policy');

function zelto(...args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [ZELTO_CLI, ...args], {
    cwd: TEST_DIR,
    encoding: 'utf-8',
    env: { ...process.env, ZELTO_DIR: TEST_DIR },
  });
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim(), status: result.status };
}

function zeltoRaw(...args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [ZELTO_CLI, ...args], {
    cwd: TEST_DIR,
    encoding: 'utf-8',
    env: { ...process.env, ZELTO_DIR: TEST_DIR },
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

async function setupSlice(id: string, title: string, writes: string[], state: string) {
  const slice = {
    id,
    title,
    state,
    spec: {
      path: `specs/slices/${id}.md`,
      frozenHash: state === 'frozen' || state === 'running' ? `sha256:${id}-hash` : null,
      frozenAt: state === 'frozen' || state === 'running' ? new Date().toISOString() : null,
    },
    acceptance: { dir: `tests/acceptance/${id}/`, frozenHash: null, oracleSrc: null },
    baseCommit: null,
    drift: { detected: false, reason: null, at: null },
    trace: { requirements: ['REQ-1'], contracts: ['CT-1'], tests: [`tests/${id}.test.ts`] },
    traceWaiver: null,
    writes,
    runs: [],
    stall: { class: null, autoResolved: 0, gateRetries: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(join(SLICES_DIR, `${id}.json`), JSON.stringify(slice, null, 2), 'utf-8');
}

describe('zelto admit — acceptance tests', { concurrency: false }, () => {
  before(async () => {
    // Initialize test environment via zelto init
    await mkdir(SLICES_DIR, { recursive: true });
    await mkdir(EVENTS_DIR, { recursive: true });
    await mkdir(LOCKS_DIR, { recursive: true });
    await mkdir(SPEC_DIR, { recursive: true });
    await mkdir(POLICY_DIR, { recursive: true });

    // Write a minimal config
    await writeFile(
      CONFIG_PATH,
      `agent:
  command: npx claude-code
gate:
  commands:
    - name: test
      run: node --test
  timeoutSec: 120
  retry:
    max: 2
`,
      'utf-8',
    );

    // Write a minimal spec file
    await writeFile(join(SPEC_DIR, 'test-slice.md'), '# Test Slice\n\nTest spec', 'utf-8');
    await writeFile(join(SPEC_DIR, 'conflict-a.md'), '# Conflict A\n\nTest spec', 'utf-8');
    await writeFile(join(SPEC_DIR, 'conflict-b.md'), '# Conflict B\n\nTest spec', 'utf-8');
    await writeFile(join(SPEC_DIR, 'nonoverlap-a.md'), '# Non-overlap A\n\nTest spec', 'utf-8');
    await writeFile(join(SPEC_DIR, 'nonoverlap-b.md'), '# Non-overlap B\n\nTest spec', 'utf-8');
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('admits a frozen slice', async () => {
    await setupSlice('test-admit-frozen', 'Frozen slice', ['src/**/*.ts'], 'frozen');

    const result = zelto('admit', 'test-admit-frozen');
    assert.equal(result.status, 0, `Expected exit 0, got ${result.status}: ${result.stderr}`);
    assert.ok(result.stdout.includes('Admitted') || result.stdout.includes('admitted'),
      `Expected 'Admitted' in output, got: ${result.stdout}`);
  });

  it('blocks a draft slice', async () => {
    await setupSlice('test-admit-draft', 'Draft slice', ['src/**/*.ts'], 'draft');

    const result = zeltoRaw('admit', 'test-admit-draft');
    assert.equal(result.status, 1, `Expected exit 1, got ${result.status}: ${result.stdout}`);
    assert.ok(result.stdout.includes('Blocked') || result.stdout.includes('blocked') || result.stderr.includes('must be'),
      `Expected blocked in output, got: ${result.stdout} ${result.stderr}`);
  });

  it('detects write-set conflict', async () => {
    await setupSlice('test-conflict-a', 'Conflict A', ['src/shared/**'], 'running');
    await setupSlice('test-conflict-b', 'Conflict B', ['src/shared/component.ts'], 'frozen');

    const result = zeltoRaw('admit', 'test-conflict-b');
    assert.equal(result.status, 1, `Expected exit 1, got ${result.status}: ${result.stdout}`);
    assert.ok(result.stdout.includes('Blocked') || result.stdout.includes('conflict') || result.stdout.includes('blocked'),
      `Expected conflict in output, got: ${result.stdout} ${result.stderr}`);
  });

  it('admits non-overlapping write-sets', async () => {
    await setupSlice('test-nonoverlap-a', 'Non-overlap A', ['src/core/**'], 'running');
    await setupSlice('test-nonoverlap-b', 'Non-overlap B', ['src/cli/**'], 'frozen');

    const result = zelto('admit', 'test-nonoverlap-b');
    assert.equal(result.status, 0, `Expected exit 0, got ${result.status}: ${result.stderr}`);
    assert.ok(result.stdout.includes('Admitted') || result.stdout.includes('admitted'),
      `Expected 'Admitted' in output, got: ${result.stdout}`);
  });

  it('outputs valid JSON with --json flag', async () => {
    await setupSlice('test-admit-json', 'JSON test', ['src/**/*.ts'], 'frozen');

    const result = zelto('admit', 'test-admit-json', '--json');
    assert.equal(result.status, 0, `Expected exit 0, got ${result.status}: ${result.stderr}`);

    let parsed: any;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      assert.fail(`Expected valid JSON, got: ${result.stdout}`);
    }
    assert.equal(parsed.sliceId, 'test-admit-json');
    assert.ok(parsed.decision === 'admitted' || parsed.decision === 'blocked');
  });
});
