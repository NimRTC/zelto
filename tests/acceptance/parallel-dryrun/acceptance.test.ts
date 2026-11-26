/**
 * Acceptance: `zelto run --parallel ... --dry-run` must not touch slice state.
 *
 * Regression for the bug where the parallel path ignored `--dry-run`: it called
 * `startRun` (frozen -> running), then crashed with an illegal transition
 * (`running -> RUN_START` on a re-run), leaving orphan `running` slices that
 * only `zelto stall --reap` could recover.
 *
 * Two checks:
 *   1. `--dry-run` exits 0, prints a dry-run notice, and leaves every slice's
 *      state file untouched (`frozen`).
 *   2. It creates no slice worktree.
 *
 * No agent is ever launched, so this is deterministic and offline (C3).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const ZELTO_CLI = join(process.cwd(), 'dist', 'cli', 'index.js');
const TEST_DIR = join(tmpdir(), `zelto-accept-parallel-dryrun-${Date.now()}`);
const ZELTO_DIR = join(TEST_DIR, '.zelto');
const SLICES_DIR = join(ZELTO_DIR, 'slices');
const EVENTS_DIR = join(ZELTO_DIR, 'events');
const LOCKS_DIR = join(ZELTO_DIR, 'locks');
const CONFIG_PATH = join(ZELTO_DIR, 'config.yaml');
const SPEC_DIR = join(TEST_DIR, 'specs', 'slices');
const POLICY_DIR = join(TEST_DIR, 'policy');

function zelto(
  ...args: string[]
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [ZELTO_CLI, ...args], {
    cwd: TEST_DIR,
    encoding: 'utf-8',
    env: { ...process.env, ZELTO_DIR: TEST_DIR },
    timeout: 60_000,
  });
  return {
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    status: result.status,
  };
}

async function setupFrozenSlice(
  id: string,
  writes: string[],
): Promise<void> {
  const slice = {
    id,
    title: id,
    state: 'frozen',
    spec: {
      path: `specs/slices/${id}.md`,
      frozenHash: `sha256:${id}-hash`,
      frozenAt: new Date().toISOString(),
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

async function readState(id: string): Promise<string> {
  const raw = await readFile(join(SLICES_DIR, `${id}.json`), 'utf-8');
  return JSON.parse(raw).state;
}

describe('zelto run --parallel --dry-run — acceptance', { concurrency: false }, () => {
  before(async () => {
    await mkdir(SLICES_DIR, { recursive: true });
    await mkdir(EVENTS_DIR, { recursive: true });
    await mkdir(LOCKS_DIR, { recursive: true });
    await mkdir(SPEC_DIR, { recursive: true });
    await mkdir(POLICY_DIR, { recursive: true });

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

    await writeFile(join(SPEC_DIR, 'dry-a.md'), '# Dry A\n\nTest spec', 'utf-8');
    await writeFile(join(SPEC_DIR, 'dry-b.md'), '# Dry B\n\nTest spec', 'utf-8');
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('does not start slices and leaves state frozen', async () => {
    // Disjoint code write-sets, but sharing CHANGELOG.md (append-only doc).
    // Both conditions are covered: disjoint code must not conflict, and the
    // shared doc must not either (ADR-107) — this is also a regression for the
    // parallel conflict check treating CHANGELOG.md as a hard conflict.
    await setupFrozenSlice('dry-a', ['src/a/one.ts', 'CHANGELOG.md']);
    await setupFrozenSlice('dry-b', ['src/b/two.ts', 'CHANGELOG.md']);

    const result = zelto('run', '--parallel', 'dry-a', 'dry-b', '--dry-run');

    assert.equal(
      result.status,
      0,
      `Expected exit 0, got ${result.status}. stdout: ${result.stdout} stderr: ${result.stderr}`,
    );
    assert.ok(
      /dry-run/i.test(result.stdout),
      `Expected a dry-run notice in output, got: ${result.stdout}`,
    );

    // State must be untouched — this is the whole point.
    assert.equal(await readState('dry-a'), 'frozen', 'dry-a state must stay frozen');
    assert.equal(await readState('dry-b'), 'frozen', 'dry-b state must stay frozen');

    // No slice worktree may be created.
    assert.equal(
      existsSync(join(ZELTO_DIR, 'worktrees', 'dry-a')),
      false,
      'dry-run must not create a slice worktree',
    );
    assert.equal(
      existsSync(join(ZELTO_DIR, 'worktrees', 'dry-b')),
      false,
      'dry-run must not create a slice worktree',
    );
  });

  it('degrades a hard write-set conflict to serial phases, still no start under dry-run', async () => {
    await setupFrozenSlice('dry-c', ['src/shared/code.ts']);
    await setupFrozenSlice('dry-d', ['src/shared/code.ts']);

    const result = zelto('run', '--parallel', 'dry-c', 'dry-d', '--dry-run');

    assert.equal(
      result.status,
      0,
      `Expected exit 0 (conflict degrades to serial, not a hard failure), got ${result.status}: ${result.stdout}`,
    );
    // The two slices must be split into separate phases (serial), not run together.
    assert.ok(
      /阶段 2\/2|Phase 2\/2/.test(result.stdout),
      `Expected two serial phases after the conflict, got: ${result.stdout}`,
    );
    assert.ok(
      /降级为串行|serial/i.test(result.stdout),
      `Expected a "degraded to serial" note, got: ${result.stdout}`,
    );
    // Even degraded, dry-run must not start anything.
    assert.equal(await readState('dry-c'), 'frozen', 'dry-c must stay frozen');
    assert.equal(await readState('dry-d'), 'frozen', 'dry-d must stay frozen');
  });
});
