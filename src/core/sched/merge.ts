// Merge orchestration — plan and detect conflicts for merging parallel slice outputs
//
// C3: deterministic, no model calls, no network
// C6: core/ only — no adapters/ imports
//
// See docs/adr-012-parallel-coordination.md §3.4

import type { SliceData } from '../slice/store.js';
import type { DepGraphNode } from './depgraph.js';
import { pathsOverlap } from './paths.js';

/**
 * Merge strategy for combining parallel slice outputs.
 */
export type MergeStrategy =
  | 'sequential_ff'    // Sequential fast-forward (dep graph guarantees no conflicts)
  | 'merge_commit'     // Create merge commit (parallel slices, potential conflicts)
  | 'rebase_onto'      // Rebase onto main branch (requires conflict resolution)
  | 'manual';          // Manual intervention required

/**
 * A single merge phase — part of a larger merge plan.
 */
export interface MergePhase {
  phase: number;
  slices: string[];
  strategy: MergeStrategy;
}

/**
 * A merge conflict between two slices.
 */
export interface MergeConflict {
  filePath: string;
  between: [string, string];   // [sliceA, sliceB]
  description: string;
}

/**
 * Full merge plan for a set of parallel slices.
 */
export interface MergePlan {
  slices: string[];
  strategy: MergeStrategy;
  phases: MergePhase[];
  estimatedConflicts: string[];
  createdAt: string;
}

/**
 * Merge planner — generates merge plans from dependency graphs and slice data.
 *
 * Strategy selection rules:
 * 1. Single slice → sequential_ff
 * 2. All slices in same phase with no write-set overlap → merge_commit
 * 3. Multiple phases with dependency chain → sequential_ff per phase
 * 4. Write-set overlap detected → manual
 * 5. Mixed: some phases sequential, some parallel → mixed strategy per phase
 */
export class MergePlanner {
  /**
   * Generate a merge plan from a dependency graph.
   *
   * @param graph - The dependency graph with topological ordering
   * @param slices - Slice data for write-set analysis
   * @returns A merge plan
   */
  planFromDependencyGraph(graph: DepGraphNode[], slices: Map<string, SliceData>): MergePlan {
    if (graph.length === 0) {
      return {
        slices: [],
        strategy: 'sequential_ff',
        phases: [],
        estimatedConflicts: [],
        createdAt: new Date().toISOString(),
      };
    }

    if (graph.length === 1) {
      return {
        slices: [graph[0].sliceId],
        strategy: 'sequential_ff',
        phases: [
          { phase: 0, slices: [graph[0].sliceId], strategy: 'sequential_ff' },
        ],
        estimatedConflicts: [],
        createdAt: new Date().toISOString(),
      };
    }

    // Group by phase
    const phases = this.groupByPhase(graph);
    const allSliceIds = graph.map((n) => n.sliceId);

    // Check if all slices are in the same phase (no dependencies)
    const allSamePhase = phases.length <= 1;

    if (allSamePhase) {
      // Check for write-set overlap
      const overlaps = this.findWriteSetOverlaps(allSliceIds, slices);
      if (overlaps.length > 0) {
        return {
          slices: allSliceIds,
          strategy: 'manual',
          phases: [
            { phase: 0, slices: allSliceIds, strategy: 'manual' },
          ],
          estimatedConflicts: overlaps,
          createdAt: new Date().toISOString(),
        };
      }

      return {
        slices: allSliceIds,
        strategy: 'merge_commit',
        phases: [
          { phase: 0, slices: allSliceIds, strategy: 'merge_commit' },
        ],
        estimatedConflicts: [],
        createdAt: new Date().toISOString(),
      };
    }

    // Multiple phases — sequential per phase
    const mergePhases: MergePhase[] = phases.map((sliceIds, i) => {
      // Check for write-set overlap within this phase
      const overlaps = this.findWriteSetOverlaps(sliceIds, slices);
      const strategy: MergeStrategy =
        overlaps.length > 0 ? 'manual' : sliceIds.length === 1 ? 'sequential_ff' : 'merge_commit';
      return { phase: i, slices: sliceIds, strategy };
    });

    // Collect all estimated conflicts
    const estimatedConflicts: string[] = [];
    for (const mp of mergePhases) {
      estimatedConflicts.push(
        ...this.findWriteSetOverlaps(mp.slices, slices),
      );
    }

    return {
      slices: allSliceIds,
      strategy: 'sequential_ff',
      phases: mergePhases,
      estimatedConflicts,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Group sorted graph nodes by phase.
   */
  private groupByPhase(nodes: DepGraphNode[]): string[][] {
    const phases: string[][] = [];
    for (const node of nodes) {
      while (phases.length <= node.phase) {
        phases.push([]);
      }
      phases[node.phase].push(node.sliceId);
    }
    return phases;
  }

  /**
   * Find write-set overlaps among a set of slice IDs.
   * Returns file paths that appear in multiple slices' write-sets.
   */
  private findWriteSetOverlaps(
    sliceIds: string[],
    slices: Map<string, SliceData>,
  ): string[] {
    const writeMap = new Map<string, string[]>(); // filePath → [sliceIds]

    for (const id of sliceIds) {
      const slice = slices.get(id);
      if (!slice) continue;
      for (const w of slice.writes) {
        if (!writeMap.has(w)) {
          writeMap.set(w, []);
        }
        writeMap.get(w)!.push(id);
      }
    }

    const overlaps: string[] = [];
    for (const [filePath, owners] of writeMap) {
      if (owners.length > 1) {
        overlaps.push(filePath);
      }
    }

    return overlaps.sort();
  }

  /**
   * Detect merge conflicts between two slices' write-sets.
   * Returns the conflicting file paths.
   */
  detectMergeConflicts(
    writesA: string[],
    writesB: string[],
    sliceA: string,
    sliceB: string,
  ): MergeConflict[] {
    const conflicts: MergeConflict[] = [];
    const setB = new Set(writesB);

    for (const w of writesA) {
      if (setB.has(w)) {
        conflicts.push({
          filePath: w,
          between: [sliceA, sliceB],
          description: `File "${w}" is in both "${sliceA}" and "${sliceB}" write-sets`,
        });
      }
    }

    // Also check for path overlap (directory prefix, globs)
    for (const wA of writesA) {
      for (const wB of writesB) {
        if (wA !== wB && pathsOverlap(wA, wB)) {
          conflicts.push({
            filePath: `${wA} ↔ ${wB}`,
            between: [sliceA, sliceB],
            description: `Pattern overlap: "${wA}" (${sliceA}) ↔ "${wB}" (${sliceB})`,
          });
        }
      }
    }

    return conflicts;
  }
}

/**
 * Select the best merge strategy for a set of slices.
 */
export function selectMergeStrategy(
  sliceIds: string[],
  hasDependencies: boolean,
  hasWriteSetOverlap: boolean,
): MergeStrategy {
  if (sliceIds.length <= 1) return 'sequential_ff';
  if (hasWriteSetOverlap) return 'manual';
  if (hasDependencies) return 'sequential_ff';
  return 'merge_commit';
}

/**
 * Format a merge plan as a human-readable string.
 */
export function formatMergePlan(plan: MergePlan): string {
  const lines: string[] = [];
  lines.push(`Merge Plan: ${plan.slices.length} slices`);
  lines.push(`Overall Strategy: ${plan.strategy}`);
  lines.push(`Phases: ${plan.phases.length}`);
  lines.push('');

  for (const phase of plan.phases) {
    lines.push(`  Phase ${phase.phase} (${phase.strategy}):`);
    for (const id of phase.slices) {
      lines.push(`    - ${id}`);
    }
  }

  if (plan.estimatedConflicts.length > 0) {
    lines.push('');
    lines.push(`⚠️  Estimated Conflicts (${plan.estimatedConflicts.length}):`);
    for (const conflict of plan.estimatedConflicts) {
      lines.push(`  - ${conflict}`);
    }
  }

  return lines.join('\n');
}
