import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeMergePlan, type MergeSliceInfo } from '../src/cli/commands/merge-executor.js';
import { buildMergePlan } from '../src/cli/commands/merge-plan.js';
import { EventStream } from '../src/core/events/stream.js';
import type { SliceData } from '../src/core/slice/store.js';

/**
 * Merge orchestration integration tests.
 *
 * See docs/adr-012-parallel-coordination.md section 3.4.
 *
 * Covers the three acceptance criteria of slice C:
 * 1. Two parallel slices merge into main one after another; the second one does
 *    not fail because of --ff-only.
 * 2. On a real conflict the merge stops, reports the conflicting files, and the
 *    main branch stays buildable.
 * 3. Every merge produces a merge.completed event carrying the slice id and
 *    the merge commit.
 */

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Create a throwaway repo with a single commit. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zelto-merge-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# base\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-m', 'base']);
  return dir;
}

/** Create a branch off main that commits one file, then return to main. */
function makeBranch(repo: string, branch: string, file: string, content: string): string {
  git(repo, ['checkout', '-b', branch]);
  writeFileSync(join(repo, file), content);
  git(repo, ['add', file]);
  git(repo, ['commit', '-m', `commit ${file}`]);
  git(repo, ['checkout', 'main']);
  return branch;
}

function makeSlice(id: string, writes: string[]): SliceData {
  return {
    id,
    title: `Slice ${id}`,
    state: 'completed',
    spec: { path: `specs/slices/${id}.md`, frozenHash: 'abc', frozenAt: new Date().toISOString() },
    acceptance: { dir: `tests/acceptance/${id}/`, frozenHash: null, oracleSrc: null },
    baseCommit: null,
    drift: { detected: false, reason: null, at: null },
    trace: { requirements: [], contracts: [], tests: [] },
    traceWaiver: null,
    baseline: false,
    writes,
    runs: [],
    stall: { class: null, autoResolved: 0, gateRetries: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function existsInRepo(repo: string, file: string): boolean {
  try {
    git(repo, ['cat-file', '-e', `HEAD:${file}`]);
    return true;
  } catch {
    return false;
  }
}

function readFile(repo: string, file: string): string {
  try {
    return readFileSync(join(repo, file), 'utf-8');
  } catch {
    return '';
  }
}

describe('merge orchestration — acceptance', () => {
  it('criterion 1: two parallel slices merge in order, second does not fail on ff-only', async () => {
    const repo = makeRepo();
    try {
      const alpha = makeBranch(repo, 'slice/alpha', 'alpha.txt', 'alpha\n');
      const beta = makeBranch(repo, 'slice/beta', 'beta.txt', 'beta\n');

      const slices = new Map<string, SliceData>([
        ['alpha', makeSlice('alpha', ['alpha.txt'])],
        ['beta', makeSlice('beta', ['beta.txt'])],
      ]);

      const plan = await buildMergePlan({
        ids: ['alpha', 'beta'],
        slices,
        specDir: join(repo, 'specs', 'slices'),
      });

      // Force sequential_ff: the first slice fast-forwards, the second one has
      // to fall back to a merge commit.
      plan.strategy = 'sequential_ff';
      for (const phase of plan.phases) phase.strategy = 'sequential_ff';

      const events = new EventStream(mkdtempSync(join(tmpdir(), 'zelto-merge-ev1-')));
      const result = await executeMergePlan(
        plan,
        [
          { id: 'alpha', branch: alpha, baseCommit: null },
          { id: 'beta', branch: beta, baseCommit: null },
        ],
        { events, repoRoot: repo },
      );

      assert.equal(result.aborted, false, 'no conflict expected');
      assert.deepEqual(result.merged, ['alpha', 'beta'], 'both slices should merge');
      assert.ok(existsInRepo(repo, 'alpha.txt'));
      assert.ok(existsInRepo(repo, 'beta.txt'));

      // The second slice's history has diverged from main, so the degraded path
      // (merge commit) must be taken.
      const betaLog = await events.read('beta');
      const phaseDone = betaLog.find((e) => e.type === 'merge.phase_complete');
      assert.ok(phaseDone, 'beta should have a merge.phase_complete event');
      assert.equal(phaseDone!.payload.strategy, 'merge_commit', 'diverged history falls back to merge commit');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('criterion 2: on a real conflict the merge stops and main stays clean', async () => {
    const repo = makeRepo();
    try {
      const one = makeBranch(repo, 'slice/one', 'shared.txt', 'from one\n');
      const two = makeBranch(repo, 'slice/two', 'shared.txt', 'from two\n');

      const slices = new Map<string, SliceData>([
        ['one', makeSlice('one', ['shared.txt'])],
        ['two', makeSlice('two', ['shared.txt'])],
      ]);

      const plan = await buildMergePlan({
        ids: ['one', 'two'],
        slices,
        specDir: join(repo, 'specs', 'slices'),
      });

      // Overlapping write-sets normally yield the manual strategy (no automatic
      // execution). Force a merge commit here to exercise the conflict path.
      plan.strategy = 'merge_commit';
      for (const phase of plan.phases) phase.strategy = 'merge_commit';

      const events = new EventStream(mkdtempSync(join(tmpdir(), 'zelto-merge-ev2-')));
      const result = await executeMergePlan(
        plan,
        [
          { id: 'one', branch: one, baseCommit: null },
          { id: 'two', branch: two, baseCommit: null },
        ],
        { events, repoRoot: repo },
      );

      assert.equal(result.aborted, true, 'conflict should abort the merge');
      assert.ok(result.conflicts.length > 0);
      const reported = result.conflicts.flatMap((c) => c.files);
      assert.ok(
        reported.includes('shared.txt'),
        `conflicting file list should contain shared.txt, got ${JSON.stringify(reported)}`,
      );

      // main is not polluted by the conflict: the tree is clean and the file
      // holds the version that was merged before the conflict.
      assert.equal(git(repo, ['status', '--porcelain']).trim(), '', 'tree should stay clean');
      assert.equal(readFile(repo, 'shared.txt').trim(), 'from one');
      let mergeHead = '';
      try {
        mergeHead = git(repo, ['rev-parse', '--verify', 'MERGE_HEAD']).trim();
      } catch {
        mergeHead = '';
      }
      assert.equal(mergeHead, '', 'MERGE_HEAD should be cleared');

      // merge.conflict is recorded against the real slice id.
      const log = await events.read('two');
      const conflictEvent = log.find((e) => e.type === 'merge.conflict');
      assert.ok(conflictEvent, 'a merge.conflict event should exist');
      assert.equal(conflictEvent!.slice, 'two');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('criterion 3: merge.completed carries the slice id and the merge commit', async () => {
    const repo = makeRepo();
    try {
      const gamma = makeBranch(repo, 'slice/gamma', 'gamma.txt', 'gamma\n');
      const slices = new Map<string, SliceData>([['gamma', makeSlice('gamma', ['gamma.txt'])]]);

      const plan = await buildMergePlan({
        ids: ['gamma'],
        slices,
        specDir: join(repo, 'specs', 'slices'),
      });

      const events = new EventStream(mkdtempSync(join(tmpdir(), 'zelto-merge-ev3-')));
      const result = await executeMergePlan(
        plan,
        [{ id: 'gamma', branch: gamma, baseCommit: null }],
        { events, repoRoot: repo },
      );

      assert.deepEqual(result.merged, ['gamma']);

      const log = await events.read('gamma');
      const completed = log.find((e) => e.type === 'merge.completed');
      assert.ok(completed, 'a merge.completed event should exist');
      // The event must land on the real slice id, not a pseudo slice.
      assert.equal(completed!.slice, 'gamma');
      assert.equal(completed!.payload.sliceId, 'gamma');
      const mergeCommit = completed!.payload.mergeCommit as string;
      assert.ok(
        typeof mergeCommit === 'string' && mergeCommit.length > 0,
        'merge.completed should carry the merge commit',
      );
      assert.equal(mergeCommit, git(repo, ['rev-parse', 'HEAD']).trim());

      assert.ok(log.some((e) => e.type === 'merge.planned'));
      assert.ok(log.some((e) => e.type === 'merge.phase_complete'));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('records merge.stale_base and falls back to a merge commit when the base drifted', async () => {
    const repo = makeRepo();
    try {
      const base = git(repo, ['rev-parse', 'HEAD']).trim();
      const delta = makeBranch(repo, 'slice/delta', 'delta.txt', 'delta\n');
      // Move main forward so the slice base is no longer an ancestor of HEAD.
      writeFileSync(join(repo, 'main.txt'), 'main\n');
      git(repo, ['add', 'main.txt']);
      git(repo, ['commit', '-m', 'main moves on']);

      const slices = new Map<string, SliceData>([['delta', makeSlice('delta', ['delta.txt'])]]);
      const plan = await buildMergePlan({
        ids: ['delta'],
        slices,
        specDir: join(repo, 'specs', 'slices'),
      });
      plan.strategy = 'sequential_ff';
      for (const phase of plan.phases) phase.strategy = 'sequential_ff';

      const events = new EventStream(mkdtempSync(join(tmpdir(), 'zelto-merge-ev4-')));
      const result = await executeMergePlan(
        plan,
        [{ id: 'delta', branch: delta, baseCommit: base }],
        { events, repoRoot: repo },
      );

      assert.deepEqual(result.merged, ['delta']);
      assert.deepEqual(result.staleBase, ['delta']);

      const log = await events.read('delta');
      assert.ok(log.some((e) => e.type === 'merge.stale_base'), 'a merge.stale_base event should exist');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
