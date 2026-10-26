// Dependency graph ASCII tree rendering module for the trace command (v3)
// Renders module dependency relationships as a tree using box-drawing characters.
// C2: core/ no SDK dependency — this is adapters/cli, safe to import color utils.
//
// Usage:
//   const graph = buildDepGraph(modules);
//   console.log(renderAsciiTree(graph));
//
//   // Or from design data directly:
//   console.log(renderDesignDepGraph(designs));

import { colors } from '../../color.js';
import type { TraceData } from './model.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/** A module with its dependency information */
export interface ModuleDep {
  name: string;
  description: string;
  dependencies: string[];
}

/** A resolved node in the dependency graph */
export interface DepGraphNode {
  name: string;
  description: string;
  /** Modules this module depends on (forward edges) */
  dependencies: string[];
  /** Modules that depend on this module (reverse edges) */
  dependents: string[];
}

/** The full dependency graph */
export interface DepGraph {
  /** All nodes in the graph, sorted by name */
  nodes: DepGraphNode[];
}

// ─── Graph Building ──────────────────────────────────────────────────────────

/**
 * Build a dependency graph from a list of modules.
 *
 * Resolves both forward (depends on) and reverse (depended by) relationships.
 * Unknown dependency names are kept as-is; they appear in the node's
 * dependencies array but have no corresponding node in the graph.
 *
 * @param modules - List of modules with their dependency declarations.
 * @returns A resolved dependency graph.
 *
 * @example
 *   const graph = buildDepGraph([
 *     { name: 'auth', description: 'Auth module', dependencies: ['db', 'api'] },
 *     { name: 'api', description: 'API module', dependencies: ['db'] },
 *     { name: 'db', description: 'Database module', dependencies: [] },
 *   ]);
 */
export function buildDepGraph(modules: ModuleDep[]): DepGraph {
  const nodeMap = new Map<string, DepGraphNode>();

  // Create nodes for all declared modules
  for (const m of modules) {
    nodeMap.set(m.name, {
      name: m.name,
      description: m.description,
      dependencies: [...m.dependencies],
      dependents: [],
    });
  }

  // Build reverse-dependency links
  for (const m of modules) {
    for (const dep of m.dependencies) {
      const depNode = nodeMap.get(dep);
      if (depNode) {
        depNode.dependents.push(m.name);
      }
    }
  }

  // Sort nodes alphabetically for deterministic output
  const nodes = Array.from(nodeMap.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  // Sort each node's dependency/dependent arrays
  for (const node of nodes) {
    node.dependencies.sort((a, b) => a.localeCompare(b));
    node.dependents.sort((a, b) => a.localeCompare(b));
  }

  return { nodes };
}

/**
 * Check whether the dependency graph contains cycles.
 *
 * Uses a standard DFS-based cycle detection. Returns the first cycle found,
 * or an empty array if the graph is acyclic.
 *
 * @param graph - The dependency graph to check.
 * @returns A cycle path (module names) if one exists, or an empty array.
 */
export function detectCycle(graph: DepGraph): string[] {
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const parent = new Map<string, string | null>();

  function dfs(name: string): string[] {
    if (inStack.has(name)) {
      // Found a cycle — walk back to reconstruct the path
      const cycle: string[] = [name];
      let current: string | null = parent.get(name) ?? null;
      while (current !== null && current !== name) {
        cycle.push(current);
        current = parent.get(current) ?? null;
      }
      cycle.push(name);
      return cycle.reverse();
    }
    if (visited.has(name)) return [];

    visited.add(name);
    inStack.add(name);

    const node = graph.nodes.find((n) => n.name === name);
    if (node) {
      for (const dep of node.dependencies) {
        parent.set(dep, name);
        const result = dfs(dep);
        if (result.length > 0) return result;
      }
    }

    inStack.delete(name);
    return [];
  }

  for (const node of graph.nodes) {
    const result = dfs(node.name);
    if (result.length > 0) return result;
  }

  return [];
}

// ─── ASCII Tree Rendering ────────────────────────────────────────────────────

/** Box-drawing characters for tree layout */
const T_BRANCH = '├── ';
const T_LAST = '└── ';
const T_PIPE = '│   ';
const T_SPACE = '    ';

/**
 * Render a dependency graph as an ASCII tree.
 *
 * Each module appears as a tree entry with its dependencies and dependents
 * shown as indented sub-entries. Modules are listed in alphabetical order.
 * Unknown dependencies (those not present in the graph) are highlighted in red.
 *
 * @param graph - The dependency graph to render.
 * @returns A formatted ASCII tree string.
 *
 * @example
 *   // Given: auth → [api, db], api → [db], db → []
 *   console.log(renderAsciiTree(graph));
 *   // ├── api
 *   // │   └── depends on: db
 *   // ├── auth
 *   // │   ├── depends on: api, db
 *   // │   └── depended by: session
 *   // ├── db
 *   // │   └── depended by: api, auth
 *   // └── session
 *   //     └── depends on: auth
 */
export function renderAsciiTree(graph: DepGraph): string {
  if (graph.nodes.length === 0) {
    return colors.dim('(no modules)');
  }

  const lines: string[] = [];

  for (let i = 0; i < graph.nodes.length; i++) {
    const node = graph.nodes[i];
    const isLast = i === graph.nodes.length - 1;
    const prefix = isLast ? T_LAST : T_BRANCH;

    // Module name line
    lines.push(`${prefix}${colors.cyan(node.name)}`);

    // Dependencies sub-entry
    if (node.dependencies.length > 0) {
      const childPrefix = isLast ? T_SPACE : T_PIPE;
      const depLabel = node.dependencies
        .map((d) => {
          const exists = graph.nodes.some((n) => n.name === d);
          return exists ? d : colors.red(d);
        })
        .join(', ');
      lines.push(`${childPrefix}${T_LAST}depends on: ${depLabel}`);
    }

    // Dependents sub-entry
    const childPrefix =
      node.dependencies.length > 0
        ? isLast
          ? T_SPACE
          : T_PIPE
        : isLast
          ? T_SPACE
          : T_PIPE;
    if (node.dependents.length > 0) {
      const depByLabel = node.dependents.join(', ');
      lines.push(
        `${childPrefix}${T_LAST}depended by: ${depByLabel}`,
      );
    } else if (node.dependencies.length > 0) {
      // We already showed "depends on", show "(no dependents)" to keep alignment
      lines.push(`${childPrefix}${T_LAST}${colors.dim('(no dependents)')}`);
    }
  }

  return lines.join('\n');
}

/**
 * Render dependency graphs for one or more designs.
 *
 * Each design is rendered as a separate section showing its module
 * dependency graph as an ASCII tree.
 *
 * @param designs - Array of design objects, each containing id, title, and modules.
 * @returns A formatted multi-line string ready for console output.
 *
 * @example
 *   console.log(renderDesignDepGraph([{
 *     id: 'dsg-1',
 *     title: 'Auth system design',
 *     status: 'confirmed',
 *     modules: [
 *       { name: 'auth', description: 'Auth module', dependencies: ['db'] },
 *       { name: 'db', description: 'Database module', dependencies: [] },
 *     ],
 *   }]));
 */
export function renderDesignDepGraph(
  designs: Array<{
    id: string;
    title: string;
    status: string;
    modules: ModuleDep[];
  }>,
): string {
  if (designs.length === 0) {
    return colors.dim('(no designs)');
  }

  const parts: string[] = [];

  for (const design of designs) {
    const graph = buildDepGraph(design.modules);

    parts.push('');
    parts.push(
      `${colors.bold('Design:')} ${design.id}  ${colors.dim(design.title)}  (${design.status})`,
    );
    parts.push(colors.dim('  Dependency graph:'));

    const tree = renderAsciiTree(graph);
    if (tree) {
      // Indent the tree by two spaces
      const indented = tree
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n');
      parts.push(indented);
    }

    // Show cycle warning if present
    const cycle = detectCycle(graph);
    if (cycle.length > 0) {
      parts.push(
        `  ${colors.yellow('⚠  Cycle detected:')} ${colors.red(cycle.join(' → '))}`,
      );
    }
  }

  return parts.join('\n');
}

/**
 * Compute the topological order of modules in the dependency graph.
 *
 * Uses Kahn's algorithm. Modules with no dependencies come first.
 * If a cycle is detected, the remaining modules are appended in arbitrary order.
 *
 * @param graph - The dependency graph.
 * @returns Module names in topological order (dependencies before dependents).
 */
export function topologicalSort(graph: DepGraph): string[] {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  // Initialize
  for (const node of graph.nodes) {
    if (!inDegree.has(node.name)) inDegree.set(node.name, 0);
    if (!adjacency.has(node.name)) adjacency.set(node.name, []);

    for (const dep of node.dependencies) {
      if (graph.nodes.some((n) => n.name === dep)) {
        if (!adjacency.has(dep)) adjacency.set(dep, []);
        adjacency.get(dep)!.push(node.name);
        inDegree.set(node.name, (inDegree.get(node.name) ?? 0) + 1);
      }
    }
  }

  // Queue nodes with in-degree 0
  const queue: string[] = [];
  for (const [name, degree] of inDegree) {
    if (degree === 0) queue.push(name);
  }
  queue.sort();

  const result: string[] = [];
  while (queue.length > 0) {
    const name = queue.shift()!;
    result.push(name);

    for (const dependent of adjacency.get(name) ?? []) {
      const newDegree = (inDegree.get(dependent) ?? 1) - 1;
      inDegree.set(dependent, newDegree);
      if (newDegree === 0) {
        queue.push(dependent);
        queue.sort();
      }
    }
  }

  return result;
}

/**
 * Render the dependency graph from trace command data.
 *
 * Converts TraceData designs into module dependency graphs and renders
 * each design as an ASCII tree section.
 *
 * This is the entry point called by trace.ts (v3) when `--graph` format
 * is requested.
 *
 * @param data - The trace data (requirement + designs) from the trace command.
 * @returns A formatted multi-line string with dependency trees per design.
 *
 * @example
 *   console.log(renderGraphTrace(data));
 *   // Design: dsg-1  Auth system design  (confirmed)
 *   //   Dependency graph:
 *   //   ├── auth
 *   //   │   └── depends on: db
 *   //   ...
 */
export function renderGraphTrace(data: TraceData): string {
  const parts: string[] = [];

  const req = data.requirement;
  parts.push(
    `${colors.bold('📋 Trace:')} ${req.id}  "${req.title}"  (${req.status})`,
  );
  parts.push('');

  if (data.designs.length === 0) {
    parts.push(colors.dim('   No designs trace to this requirement.'));
    return parts.join('\n');
  }

  const designInputs = data.designs.map((d) => ({
    id: d.id,
    title: d.title,
    status: d.status,
    modules: d.modules.map((m) => ({
      name: m.name,
      description: m.description,
      dependencies: m.dependencies ?? [],
    })),
  }));

  parts.push(renderDesignDepGraph(designInputs));

  return parts.join('\n');
}
