import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DependencyGraph, parseDependsOnArgs } from '../src/core/sched/depgraph.js';

describe('DependencyGraph', () => {
  it('handles a single node with no dependencies', () => {
    const g = new DependencyGraph();
    g.addNode('slice-a', []);
    const sorted = g.topologicalSort();
    assert.equal(sorted.length, 1);
    assert.equal(sorted[0].sliceId, 'slice-a');
    assert.equal(sorted[0].phase, 0);
  });

  it('handles two independent slices (same phase)', () => {
    const g = new DependencyGraph();
    g.addNode('slice-a', []);
    g.addNode('slice-b', []);
    const sorted = g.topologicalSort();
    assert.equal(sorted.length, 2);
    assert.equal(sorted[0].phase, 0);
    assert.equal(sorted[1].phase, 0);
  });

  it('produces correct phases for linear dependency chain', () => {
    const g = new DependencyGraph();
    g.addNode('slice-a', []);
    g.addNode('slice-b', ['slice-a']);
    g.addNode('slice-c', ['slice-b']);
    const sorted = g.topologicalSort();
    assert.equal(sorted.length, 3);
    assert.equal(sorted[0].sliceId, 'slice-a');
    assert.equal(sorted[0].phase, 0);
    assert.equal(sorted[1].sliceId, 'slice-b');
    assert.equal(sorted[1].phase, 1);
    assert.equal(sorted[2].sliceId, 'slice-c');
    assert.equal(sorted[2].phase, 2);
  });

  it('groups parallel slices in same phase', () => {
    const g = new DependencyGraph();
    g.addNode('slice-a', []);
    g.addNode('slice-b', ['slice-a']);
    g.addNode('slice-c', ['slice-a']);
    const sorted = g.topologicalSort();
    assert.equal(sorted.length, 3);
    // slice-a is phase 0
    assert.equal(sorted[0].sliceId, 'slice-a');
    assert.equal(sorted[0].phase, 0);
    // slice-b and slice-c are both phase 1
    assert.equal(sorted[1].phase, 1);
    assert.equal(sorted[2].phase, 1);
  });

  it('phasesFromDeps returns grouped phases', () => {
    const g = new DependencyGraph();
    g.addNode('slice-a', []);
    g.addNode('slice-b', ['slice-a']);
    g.addNode('slice-c', ['slice-a']);
    g.addNode('slice-d', ['slice-b', 'slice-c']);
    const phases = g.phasesFromDeps();
    assert.equal(phases.length, 3);
    assert.deepEqual(phases[0], ['slice-a']);
    assert.equal(phases[1].length, 2);
    assert.ok(phases[1].includes('slice-b'));
    assert.ok(phases[1].includes('slice-c'));
    assert.deepEqual(phases[2], ['slice-d']);
  });

  it('detects a direct cycle', () => {
    const g = new DependencyGraph();
    g.addNode('slice-a', ['slice-b']);
    g.addNode('slice-b', ['slice-a']);
    const cycle = g.checkCycles();
    assert.notEqual(cycle, null);
    assert.equal(cycle!.hasCycle, true);
    assert.ok(cycle!.cycle.length >= 2);
  });

  it('detects a longer cycle', () => {
    const g = new DependencyGraph();
    g.addNode('slice-a', ['slice-b']);
    g.addNode('slice-b', ['slice-c']);
    g.addNode('slice-c', ['slice-a']);
    const cycle = g.checkCycles();
    assert.notEqual(cycle, null);
    assert.equal(cycle!.hasCycle, true);
  });

  it('returns null for acyclic graph', () => {
    const g = new DependencyGraph();
    g.addNode('slice-a', []);
    g.addNode('slice-b', ['slice-a']);
    g.addNode('slice-c', ['slice-a']);
    const cycle = g.checkCycles();
    assert.equal(cycle, null);
  });

  it('throws on topologicalSort with cycle', () => {
    const g = new DependencyGraph();
    g.addNode('slice-a', ['slice-b']);
    g.addNode('slice-b', ['slice-a']);
    assert.throws(() => g.topologicalSort(), /Circular dependency/);
  });

  it('handles diamond dependency', () => {
    const g = new DependencyGraph();
    g.addNode('root', []);
    g.addNode('left', ['root']);
    g.addNode('right', ['root']);
    g.addNode('leaf', ['left', 'right']);
    const sorted = g.topologicalSort();
    assert.equal(sorted.length, 4);
    // root phase 0, left+right phase 1, leaf phase 2
    assert.equal(sorted[0].phase, 0);
    assert.equal(sorted[1].phase, 1);
    assert.equal(sorted[2].phase, 1);
    assert.equal(sorted[3].phase, 2);
  });

  it('handles self-dependency as cycle', () => {
    const g = new DependencyGraph();
    g.addNode('slice-a', ['slice-a']);
    const cycle = g.checkCycles();
    assert.notEqual(cycle, null);
    assert.equal(cycle!.hasCycle, true);
  });

  it('handles unknown dependencies gracefully', () => {
    const g = new DependencyGraph();
    g.addNode('slice-a', []);
    g.addNode('slice-b', ['unknown-slice']);
    const sorted = g.topologicalSort();
    assert.equal(sorted.length, 2);
    // unknown-slice is not in the graph, so it's treated as having no deps
    // Both should be phase 0
    assert.equal(sorted[0].phase, 0);
    assert.equal(sorted[1].phase, 0);
  });

  it('serializes to JSON', () => {
    const g = new DependencyGraph();
    g.addNode('slice-a', []);
    g.addNode('slice-b', ['slice-a']);
    const json = g.toJSON();
    assert.ok('slice-a' in json);
    assert.ok('slice-b' in json);
    assert.deepEqual(json['slice-b'].dependsOn, ['slice-a']);
    assert.equal(json['slice-b'].phase, 1);
  });

  it('hasNode returns correct values', () => {
    const g = new DependencyGraph();
    g.addNode('slice-a', []);
    assert.equal(g.hasNode('slice-a'), true);
    assert.equal(g.hasNode('slice-b'), false);
  });

  it('getDependencies returns correct deps', () => {
    const g = new DependencyGraph();
    g.addNode('slice-a', ['dep1', 'dep2']);
    const deps = g.getDependencies('slice-a');
    assert.deepEqual(deps, ['dep1', 'dep2']);
  });

  it('getAllNodes returns all slice IDs', () => {
    const g = new DependencyGraph();
    g.addNode('slice-a', []);
    g.addNode('slice-b', []);
    const nodes = g.getAllNodes();
    assert.equal(nodes.length, 2);
    assert.ok(nodes.includes('slice-a'));
    assert.ok(nodes.includes('slice-b'));
  });

  it('getDependencies for unknown node returns empty array', () => {
    const g = new DependencyGraph();
    assert.deepEqual(g.getDependencies('nonexistent'), []);
  });
});

describe('parseDependsOnArgs', () => {
  it('parses single --depends-on argument', () => {
    const deps = parseDependsOnArgs(['--depends-on', 'slice-b=slice-a']);
    assert.equal(deps.size, 1);
    assert.ok(deps.has('slice-b'));
    assert.deepEqual(deps.get('slice-b'), ['slice-a']);
  });

  it('parses multiple dependencies separated by comma', () => {
    const deps = parseDependsOnArgs(['--depends-on', 'slice-c=slice-a,slice-b']);
    assert.equal(deps.size, 1);
    assert.deepEqual(deps.get('slice-c'), ['slice-a', 'slice-b']);
  });

  it('parses multiple --depends-on arguments', () => {
    const deps = parseDependsOnArgs([
      '--depends-on', 'slice-b=slice-a',
      '--depends-on', 'slice-c=slice-b',
    ]);
    assert.equal(deps.size, 2);
    assert.deepEqual(deps.get('slice-b'), ['slice-a']);
    assert.deepEqual(deps.get('slice-c'), ['slice-b']);
  });

  it('returns empty map when no --depends-on present', () => {
    const deps = parseDependsOnArgs(['slice-a', 'slice-b']);
    assert.equal(deps.size, 0);
  });

  it('handles empty dependency string', () => {
    const deps = parseDependsOnArgs(['--depends-on', 'slice-b=']);
    assert.equal(deps.size, 0);
  });

  it('ignores arguments without = sign', () => {
    const deps = parseDependsOnArgs(['--depends-on', 'invalid-format']);
    assert.equal(deps.size, 0);
  });
});
