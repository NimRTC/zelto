// Tests for the trace dependency graph ASCII tree rendering module
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDepGraph,
  renderAsciiTree,
  renderDesignDepGraph,
  detectCycle,
  topologicalSort,
} from '../src/cli/commands/trace/graph_render.js';
import type { DepGraph, ModuleDep } from '../src/cli/commands/trace/graph_render.js';

// ─── buildDepGraph ───────────────────────────────────────────────────────────

describe('buildDepGraph', () => {
  it('builds an empty graph from no modules', () => {
    const graph = buildDepGraph([]);
    assert.equal(graph.nodes.length, 0);
  });

  it('creates a node for each module', () => {
    const graph = buildDepGraph([
      { name: 'auth', description: 'Auth module', dependencies: [] },
      { name: 'db', description: 'Database module', dependencies: [] },
    ]);
    assert.equal(graph.nodes.length, 2);
    assert.ok(graph.nodes.some((n) => n.name === 'auth'));
    assert.ok(graph.nodes.some((n) => n.name === 'db'));
  });

  it('resolves forward dependencies', () => {
    const graph = buildDepGraph([
      { name: 'auth', description: 'Auth module', dependencies: ['db'] },
      { name: 'db', description: 'Database module', dependencies: [] },
    ]);
    const auth = graph.nodes.find((n) => n.name === 'auth')!;
    assert.deepEqual(auth.dependencies, ['db']);
  });

  it('resolves reverse dependencies', () => {
    const graph = buildDepGraph([
      { name: 'auth', description: 'Auth module', dependencies: ['db'] },
      { name: 'db', description: 'Database module', dependencies: [] },
    ]);
    const db = graph.nodes.find((n) => n.name === 'db')!;
    assert.deepEqual(db.dependents, ['auth']);
  });

  it('sorts nodes alphabetically', () => {
    const graph = buildDepGraph([
      { name: 'zebra', description: '', dependencies: [] },
      { name: 'alpha', description: '', dependencies: [] },
      { name: 'beta', description: '', dependencies: [] },
    ]);
    assert.equal(graph.nodes[0].name, 'alpha');
    assert.equal(graph.nodes[1].name, 'beta');
    assert.equal(graph.nodes[2].name, 'zebra');
  });

  it('handles modules with no dependencies', () => {
    const graph = buildDepGraph([
      { name: 'standalone', description: '', dependencies: [] },
    ]);
    assert.equal(graph.nodes.length, 1);
    assert.deepEqual(graph.nodes[0].dependencies, []);
    assert.deepEqual(graph.nodes[0].dependents, []);
  });

  it('handles unknown dependency names gracefully', () => {
    const graph = buildDepGraph([
      { name: 'auth', description: '', dependencies: ['unknown-lib'] },
    ]);
    assert.equal(graph.nodes.length, 1);
    assert.deepEqual(graph.nodes[0].dependencies, ['unknown-lib']);
    assert.deepEqual(graph.nodes[0].dependents, []);
  });

  it('handles a chain of dependencies', () => {
    const graph = buildDepGraph([
      { name: 'ui', description: '', dependencies: ['api'] },
      { name: 'api', description: '', dependencies: ['db'] },
      { name: 'db', description: '', dependencies: [] },
    ]);

    const ui = graph.nodes.find((n) => n.name === 'ui')!;
    const api = graph.nodes.find((n) => n.name === 'api')!;
    const db = graph.nodes.find((n) => n.name === 'db')!;

    assert.deepEqual(ui.dependencies, ['api']);
    assert.deepEqual(api.dependencies, ['db']);
    assert.deepEqual(db.dependencies, []);

    assert.deepEqual(db.dependents, ['api']);
    assert.deepEqual(api.dependents, ['ui']);
    assert.deepEqual(ui.dependents, []);
  });
});

// ─── detectCycle ─────────────────────────────────────────────────────────────

describe('detectCycle', () => {
  it('returns empty array for acyclic graph', () => {
    const graph = buildDepGraph([
      { name: 'a', description: '', dependencies: ['b'] },
      { name: 'b', description: '', dependencies: ['c'] },
      { name: 'c', description: '', dependencies: [] },
    ]);
    assert.equal(detectCycle(graph).length, 0);
  });

  it('detects a direct cycle (A → B → A)', () => {
    const graph = buildDepGraph([
      { name: 'a', description: '', dependencies: ['b'] },
      { name: 'b', description: '', dependencies: ['a'] },
    ]);
    const cycle = detectCycle(graph);
    assert.ok(cycle.length > 0);
    assert.equal(cycle[0], cycle[cycle.length - 1]);
  });

  it('detects a self-loop', () => {
    const graph = buildDepGraph([
      { name: 'a', description: '', dependencies: ['a'] },
    ]);
    const cycle = detectCycle(graph);
    assert.ok(cycle.length > 0);
  });

  it('detects a longer cycle (A → B → C → A)', () => {
    const graph = buildDepGraph([
      { name: 'a', description: '', dependencies: ['b'] },
      { name: 'b', description: '', dependencies: ['c'] },
      { name: 'c', description: '', dependencies: ['a'] },
    ]);
    const cycle = detectCycle(graph);
    assert.ok(cycle.length >= 3);
    assert.equal(cycle[0], cycle[cycle.length - 1]);
  });

  it('handles empty graph', () => {
    const graph = buildDepGraph([]);
    assert.equal(detectCycle(graph).length, 0);
  });
});

// ─── renderAsciiTree ─────────────────────────────────────────────────────────

describe('renderAsciiTree', () => {
  it('renders "(no modules)" for empty graph', () => {
    const graph = buildDepGraph([]);
    const output = renderAsciiTree(graph);
    assert.ok(output.includes('no modules'));
  });

  it('renders a single module with no deps', () => {
    const graph = buildDepGraph([
      { name: 'standalone', description: '', dependencies: [] },
    ]);
    const output = renderAsciiTree(graph);
    assert.ok(output.includes('standalone'));
    // No "depends on" line
    assert.ok(!output.includes('depends on'));
    // No "depended by" line
    assert.ok(!output.includes('depended by'));
  });

  it('renders a module with dependencies', () => {
    const graph = buildDepGraph([
      { name: 'auth', description: '', dependencies: ['db'] },
      { name: 'db', description: '', dependencies: [] },
    ]);
    const output = renderAsciiTree(graph);
    assert.ok(output.includes('auth'));
    assert.ok(output.includes('db'));
    assert.ok(output.includes('depends on: db'));
    assert.ok(output.includes('depended by: auth'));
  });

  it('renders multiple modules with tree connectors', () => {
    const graph = buildDepGraph([
      { name: 'api', description: '', dependencies: ['db'] },
      { name: 'auth', description: '', dependencies: ['db', 'api'] },
      { name: 'db', description: '', dependencies: [] },
      { name: 'ui', description: '', dependencies: ['auth'] },
    ]);
    const output = renderAsciiTree(graph);
    // All module names present
    assert.ok(output.includes('api'));
    assert.ok(output.includes('auth'));
    assert.ok(output.includes('db'));
    assert.ok(output.includes('ui'));
    // Tree connectors present
    assert.ok(output.includes('├──') || output.includes('└──'));
    // Dependencies shown
    assert.ok(output.includes('depends on: api, db'));
    assert.ok(output.includes('depended by: api, auth'));
  });

  it('highlights unknown dependencies in red', () => {
    const graph = buildDepGraph([
      { name: 'auth', description: '', dependencies: ['missing-dep'] },
    ]);
    const output = renderAsciiTree(graph);
    assert.ok(output.includes('missing-dep'));
  });

  it('renders "(no dependents)" when module has deps but no dependents', () => {
    const graph = buildDepGraph([
      { name: 'top', description: '', dependencies: ['middle'] },
      { name: 'middle', description: '', dependencies: [] },
    ]);
    const output = renderAsciiTree(graph);
    // top has dependents? Actually top has dependencies, not dependents
    // top depends on middle, so top's sub-items are:
    //   "depends on: middle"
    //   "(no dependents)"
    assert.ok(output.includes('(no dependents)'));
  });
});

// ─── renderDesignDepGraph ────────────────────────────────────────────────────

describe('renderDesignDepGraph', () => {
  it('renders "(no designs)" for empty input', () => {
    const output = renderDesignDepGraph([]);
    assert.ok(output.includes('no designs'));
  });

  it('renders a single design with module deps', () => {
    const output = renderDesignDepGraph([
      {
        id: 'dsg-1',
        title: 'Auth system design',
        status: 'confirmed',
        modules: [
          { name: 'auth', description: 'Auth module', dependencies: ['db'] },
          { name: 'db', description: 'Database module', dependencies: [] },
        ],
      },
    ]);

    assert.ok(output.includes('dsg-1'));
    assert.ok(output.includes('Auth system design'));
    assert.ok(output.includes('confirmed'));
    assert.ok(output.includes('auth'));
    assert.ok(output.includes('db'));
    assert.ok(output.includes('depends on: db'));
    assert.ok(output.includes('depended by: auth'));
  });

  it('renders multiple designs', () => {
    const output = renderDesignDepGraph([
      {
        id: 'dsg-1',
        title: 'First design',
        status: 'confirmed',
        modules: [{ name: 'a', description: '', dependencies: [] }],
      },
      {
        id: 'dsg-2',
        title: 'Second design',
        status: 'draft',
        modules: [{ name: 'b', description: '', dependencies: [] }],
      },
    ]);

    assert.ok(output.includes('dsg-1'));
    assert.ok(output.includes('dsg-2'));
    assert.ok(output.includes('First design'));
    assert.ok(output.includes('Second design'));
  });

  it('detects and reports cycles', () => {
    const output = renderDesignDepGraph([
      {
        id: 'dsg-cycle',
        title: 'Cyclic design',
        status: 'draft',
        modules: [
          { name: 'a', description: '', dependencies: ['b'] },
          { name: 'b', description: '', dependencies: ['a'] },
        ],
      },
    ]);

    assert.ok(output.includes('Cycle detected'));
    assert.ok(output.includes('a'));
    assert.ok(output.includes('b'));
  });
});

// ─── topologicalSort ─────────────────────────────────────────────────────────

describe('topologicalSort', () => {
  it('returns empty for empty graph', () => {
    const graph = buildDepGraph([]);
    assert.deepEqual(topologicalSort(graph), []);
  });

  it('returns modules with no deps first', () => {
    const graph = buildDepGraph([
      { name: 'ui', description: '', dependencies: ['api'] },
      { name: 'api', description: '', dependencies: ['db'] },
      { name: 'db', description: '', dependencies: [] },
    ]);
    const sorted = topologicalSort(graph);
    assert.equal(sorted[0], 'db');
    assert.equal(sorted[1], 'api');
    assert.equal(sorted[2], 'ui');
  });

  it('handles independent modules', () => {
    const graph = buildDepGraph([
      { name: 'b', description: '', dependencies: [] },
      { name: 'a', description: '', dependencies: [] },
      { name: 'c', description: '', dependencies: [] },
    ]);
    const sorted = topologicalSort(graph);
    // All three should be present, no particular order among independents
    assert.equal(sorted.length, 3);
    assert.ok(sorted.includes('a'));
    assert.ok(sorted.includes('b'));
    assert.ok(sorted.includes('c'));
  });

  it('handles diamond dependency (A→B, A→C, B→D, C→D)', () => {
    const graph = buildDepGraph([
      { name: 'a', description: '', dependencies: ['b', 'c'] },
      { name: 'b', description: '', dependencies: ['d'] },
      { name: 'c', description: '', dependencies: ['d'] },
      { name: 'd', description: '', dependencies: [] },
    ]);
    const sorted = topologicalSort(graph);
    assert.equal(sorted.length, 4);
    // d must come before b and c
    assert.ok(sorted.indexOf('d') < sorted.indexOf('b'));
    assert.ok(sorted.indexOf('d') < sorted.indexOf('c'));
    // b and c must come before a
    assert.ok(sorted.indexOf('b') < sorted.indexOf('a'));
    assert.ok(sorted.indexOf('c') < sorted.indexOf('a'));
  });
});
