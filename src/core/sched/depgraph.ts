// Dependency graph — DAG-based slice ordering for coordinated parallel execution
//
// C3: deterministic, no model calls, no network
// C6: core/ only — no adapters/ imports
//
// See docs/adr-012-parallel-coordination.md §3.2

/**
 * A node in the dependency graph.
 */
export interface DepGraphNode {
  sliceId: string;
  dependsOn: string[];
  phase: number;
}

/**
 * Cycle detection result.
 */
export interface CycleInfo {
  hasCycle: boolean;
  cycle: string[];
}

/**
 * Dependency graph for slice execution ordering.
 *
 * Constructed from slice specs (## Prerequisites section) and/or CLI --depends-on args.
 * Uses Kahn's algorithm for topological sort and cycle detection.
 */
export class DependencyGraph {
  private readonly nodes: Map<string, string[]> = new Map(); // sliceId → dependsOn[]

  /**
   * Add a node (slice) with its dependencies.
   * Dependencies that reference unknown slices are kept — they will be caught by cycle detection.
   */
  addNode(sliceId: string, dependsOn: string[]): void {
    this.nodes.set(sliceId, dependsOn);
  }

  /**
   * Check if a slice is registered in the graph.
   */
  hasNode(sliceId: string): boolean {
    return this.nodes.has(sliceId);
  }

  /**
   * Get the dependencies of a slice.
   */
  getDependencies(sliceId: string): string[] {
    return this.nodes.get(sliceId) ?? [];
  }

  /**
   * Get all registered slice IDs.
   */
  getAllNodes(): string[] {
    return Array.from(this.nodes.keys());
  }

  /**
   * Check for cycles in the dependency graph.
   * Uses DFS-based cycle detection.
   */
  checkCycles(): CycleInfo | null {
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const parent: Map<string, string | null> = new Map();

    const dfs = (node: string): string[] | null => {
      visited.add(node);
      inStack.add(node);

      const deps = this.nodes.get(node) ?? [];
      for (const dep of deps) {
        if (!this.nodes.has(dep) && dep !== '') continue; // unknown dependency — skip
        if (!visited.has(dep)) {
          parent.set(dep, node);
          const result = dfs(dep);
          if (result) return result;
        } else if (inStack.has(dep)) {
          // Found a cycle — reconstruct it
          const cycle: string[] = [dep];
          let current = node;
          while (current !== dep) {
            cycle.push(current);
            current = parent.get(current) ?? '';
            if (!current) break;
          }
          cycle.push(dep);
          cycle.reverse();
          return cycle;
        }
      }

      inStack.delete(node);
      return null;
    };

    for (const node of this.nodes.keys()) {
      if (!visited.has(node)) {
        const cycle = dfs(node);
        if (cycle) {
          return { hasCycle: true, cycle };
        }
      }
    }

    return null;
  }

  /**
   * Topological sort using Kahn's algorithm.
   * Returns nodes grouped by phase (0 = no dependencies, 1 = depends on phase 0, etc.).
   * Throws if a cycle is detected.
   */
  topologicalSort(): DepGraphNode[] {
    const cycleInfo = this.checkCycles();
    if (cycleInfo) {
      throw new Error(
        `Circular dependency detected: ${cycleInfo.cycle.join(' → ')}`,
      );
    }

    // Calculate in-degree for each node
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>(); // dep → [dependents]

    for (const [id, deps] of this.nodes) {
      if (!inDegree.has(id)) inDegree.set(id, 0);
      for (const dep of deps) {
        if (!this.nodes.has(dep)) continue; // skip unknown deps
        if (!adjacency.has(dep)) adjacency.set(dep, []);
        adjacency.get(dep)!.push(id);
        inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
      }
    }

    // Phase 0: nodes with no dependencies
    const phaseNodes: DepGraphNode[] = [];
    const queue: string[] = [];

    for (const [id, degree] of inDegree) {
      if (degree === 0) {
        queue.push(id);
        phaseNodes.push({ sliceId: id, dependsOn: this.nodes.get(id) ?? [], phase: 0 });
      }
    }

    let processed = 0;

    while (queue.length > 0) {
      const current = queue.shift()!;
      processed++;

      const currentPhase = phaseNodes.find((n) => n.sliceId === current)?.phase ?? 0;

      for (const dependent of adjacency.get(current) ?? []) {
        const newDegree = (inDegree.get(dependent) ?? 1) - 1;
        inDegree.set(dependent, newDegree);
        if (newDegree === 0) {
          queue.push(dependent);
          phaseNodes.push({
            sliceId: dependent,
            dependsOn: this.nodes.get(dependent) ?? [],
            phase: currentPhase + 1,
          });
        }
      }
    }

    // Sort by phase then sliceId for deterministic output
    phaseNodes.sort((a, b) => {
      if (a.phase !== b.phase) return a.phase - b.phase;
      return a.sliceId.localeCompare(b.sliceId);
    });

    return phaseNodes;
  }

  /**
   * Group slices by execution phase.
   * Returns an array where each element is an array of slice IDs in that phase.
   */
  phasesFromDeps(): string[][] {
    const sorted = this.topologicalSort();
    const phases: string[][] = [];

    for (const node of sorted) {
      while (phases.length <= node.phase) {
        phases.push([]);
      }
      phases[node.phase].push(node.sliceId);
    }

    return phases;
  }

  /**
   * Serialize the dependency graph to a plain object (for events/display).
   */
  toJSON(): Record<string, { dependsOn: string[]; phase: number }> {
    const result: Record<string, { dependsOn: string[]; phase: number }> = {};
    for (const [id, deps] of this.nodes) {
      result[id] = { dependsOn: deps, phase: 0 };
    }
    // Fill in phases from topological sort
    try {
      const sorted = this.topologicalSort();
      for (const node of sorted) {
        if (result[node.sliceId]) {
          result[node.sliceId].phase = node.phase;
        }
      }
    } catch {
      // Ignore cycle errors in serialization
    }
    return result;
  }
}

/**
 * Parse slice IDs and their dependency declarations from CLI-style args.
 *
 * Supports:
 *   --depends-on slice-b=slice-a          (slice-b depends on slice-a)
 *   --depends-on slice-b=slice-a,slice-c   (slice-b depends on slice-a and slice-c)
 *   --depends-on slice-b=slice-a --depends-on slice-c=slice-b
 */
export function parseDependsOnArgs(args: string[]): Map<string, string[]> {
  const deps = new Map<string, string[]>();

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--depends-on' && i + 1 < args.length) {
      const spec = args[i + 1];
      const eqIdx = spec.indexOf('=');
      if (eqIdx > 0) {
        const sliceId = spec.slice(0, eqIdx);
        const depStr = spec.slice(eqIdx + 1);
        const dependencies = depStr
          .split(',')
          .map((d) => d.trim())
          .filter(Boolean);
        if (dependencies.length > 0) {
          deps.set(sliceId, dependencies);
        }
      }
    }
  }

  return deps;
}
