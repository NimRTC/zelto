import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MergePlanner, formatMergePlan, selectMergeStrategy } from '../src/core/sched/merge.js';
import type { SliceData } from '../src/core/slice/store.js';
import { DependencyGraph } from '../src/core/sched/depgraph.js';

function makeSlice(id: string, writes: string[]): SliceData {
  return {
    id,
    title: `Slice ${id}`,
    state: 'frozen',
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

describe('MergePlanner', () => {
  it('returns empty plan for no slices', () => {
    const planner = new MergePlanner();
    const plan = planner.planFromDependencyGraph([], new Map());
    assert.equal(plan.slices.length, 0);
    assert.equal(plan.phases.length, 0);
  });

  it('plans single slice with sequential_ff', () => {
    const graph = new DependencyGraph();
    graph.addNode('slice-a', []);
    const sorted = graph.topologicalSort();
    const slices = new Map<string, SliceData>();
    slices.set('slice-a', makeSlice('slice-a', ['src/feature.ts']));

    const planner = new MergePlanner();
    const plan = planner.planFromDependencyGraph(sorted, slices);
    assert.equal(plan.strategy, 'sequential_ff');
    assert.deepEqual(plan.slices, ['slice-a']);
  });

  it('plans parallel slices with merge_commit when no overlap', () => {
    const graph = new DependencyGraph();
    graph.addNode('slice-a', []);
    graph.addNode('slice-b', []);
    const sorted = graph.topologicalSort();
    const slices = new Map<string, SliceData>();
    slices.set('slice-a', makeSlice('slice-a', ['src/feature-a.ts']));
    slices.set('slice-b', makeSlice('slice-b', ['src/feature-b.ts']));

    const planner = new MergePlanner();
    const plan = planner.planFromDependencyGraph(sorted, slices);
    assert.equal(plan.strategy, 'merge_commit');
    assert.equal(plan.phases.length, 1);
    assert.equal(plan.phases[0].strategy, 'merge_commit');
  });

  it('detects write-set overlap → manual strategy', () => {
    const graph = new DependencyGraph();
    graph.addNode('slice-a', []);
    graph.addNode('slice-b', []);
    const sorted = graph.topologicalSort();
    const slices = new Map<string, SliceData>();
    slices.set('slice-a', makeSlice('slice-a', ['src/shared.ts']));
    slices.set('slice-b', makeSlice('slice-b', ['src/shared.ts']));

    const planner = new MergePlanner();
    const plan = planner.planFromDependencyGraph(sorted, slices);
    assert.equal(plan.strategy, 'manual');
    assert.equal(plan.estimatedConflicts.length, 1);
    assert.ok(plan.estimatedConflicts[0].includes('src/shared.ts'));
  });

  it('generates multiple phases for dependency chain', () => {
    const graph = new DependencyGraph();
    graph.addNode('slice-a', []);
    graph.addNode('slice-b', ['slice-a']);
    graph.addNode('slice-c', ['slice-a']);
    const sorted = graph.topologicalSort();
    const slices = new Map<string, SliceData>();
    slices.set('slice-a', makeSlice('slice-a', ['src/core.ts']));
    slices.set('slice-b', makeSlice('slice-b', ['src/cli.ts']));
    slices.set('slice-c', makeSlice('slice-c', ['src/tests.ts']));

    const planner = new MergePlanner();
    const plan = planner.planFromDependencyGraph(sorted, slices);
    // Phase 0: slice-a (sequential_ff)
    // Phase 1: slice-b, slice-c (merge_commit — no overlap)
    assert.equal(plan.phases.length, 2);
    assert.equal(plan.phases[0].strategy, 'sequential_ff');
    assert.equal(plan.phases[1].strategy, 'merge_commit');
  });

  it('generates phase with manual strategy when overlap exists within phase', () => {
    const graph = new DependencyGraph();
    graph.addNode('slice-a', []);
    graph.addNode('slice-b', ['slice-a']);
    graph.addNode('slice-c', ['slice-a']);
    const sorted = graph.topologicalSort();
    const slices = new Map<string, SliceData>();
    slices.set('slice-a', makeSlice('slice-a', ['src/core.ts']));
    slices.set('slice-b', makeSlice('slice-b', ['src/shared.ts']));
    slices.set('slice-c', makeSlice('slice-c', ['src/shared.ts']));

    const planner = new MergePlanner();
    const plan = planner.planFromDependencyGraph(sorted, slices);
    // Phase 0: slice-a (sequential_ff)
    // Phase 1: slice-b, slice-c (manual — overlap on src/shared.ts)
    assert.equal(plan.phases.length, 2);
    assert.equal(plan.phases[0].strategy, 'sequential_ff');
    assert.equal(plan.phases[1].strategy, 'manual');
  });

  it('detectMergeConflicts finds exact file matches', () => {
    const planner = new MergePlanner();
    const conflicts = planner.detectMergeConflicts(
      ['src/shared.ts', 'src/foo.ts'],
      ['src/shared.ts', 'src/bar.ts'],
      'slice-a', 'slice-b',
    );
    assert.ok(conflicts.length >= 1);
    const fileConflict = conflicts.find((c) => c.filePath === 'src/shared.ts');
    assert.ok(fileConflict);
    assert.deepEqual(fileConflict!.between, ['slice-a', 'slice-b']);
  });

  it('detectMergeConflicts finds pattern overlaps', () => {
    const planner = new MergePlanner();
    const conflicts = planner.detectMergeConflicts(
      ['src/**/*.ts'],
      ['src/core/types.ts'],
      'slice-a', 'slice-b',
    );
    assert.ok(conflicts.length > 0);
  });

  it('detectMergeConflicts returns empty for non-overlapping writes', () => {
    const planner = new MergePlanner();
    const conflicts = planner.detectMergeConflicts(
      ['src/feature-a/**'],
      ['src/feature-b/**'],
      'slice-a', 'slice-b',
    );
    assert.equal(conflicts.length, 0);
  });
});

describe('selectMergeStrategy', () => {
  it('returns sequential_ff for single slice', () => {
    assert.equal(selectMergeStrategy(['slice-a'], false, false), 'sequential_ff');
  });

  it('returns manual for overlapping write-sets', () => {
    assert.equal(selectMergeStrategy(['a', 'b'], false, true), 'manual');
  });

  it('returns sequential_ff for dependent slices with no overlap', () => {
    assert.equal(selectMergeStrategy(['a', 'b'], true, false), 'sequential_ff');
  });

  it('returns merge_commit for independent slices with no overlap', () => {
    assert.equal(selectMergeStrategy(['a', 'b'], false, false), 'merge_commit');
  });
});

describe('formatMergePlan', () => {
  it('formats a simple plan', () => {
    const plan = {
      slices: ['slice-a'],
      strategy: 'sequential_ff' as const,
      phases: [{ phase: 0, slices: ['slice-a'], strategy: 'sequential_ff' as const }],
      estimatedConflicts: [],
      createdAt: new Date().toISOString(),
    };
    const text = formatMergePlan(plan);
    assert.ok(text.includes('Merge Plan'));
    assert.ok(text.includes('sequential_ff'));
    assert.ok(text.includes('slice-a'));
  });

  it('includes conflict information when present', () => {
    const plan = {
      slices: ['slice-a', 'slice-b'],
      strategy: 'manual' as const,
      phases: [{ phase: 0, slices: ['slice-a', 'slice-b'], strategy: 'manual' as const }],
      estimatedConflicts: ['src/shared.ts'],
      createdAt: new Date().toISOString(),
    };
    const text = formatMergePlan(plan);
    assert.ok(text.includes('Estimated Conflicts'));
    assert.ok(text.includes('src/shared.ts'));
  });
});
