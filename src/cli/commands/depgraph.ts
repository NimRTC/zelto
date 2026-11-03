// zelto depgraph — view dependency graph for slices
//
// See docs/adr-012-parallel-coordination.md §3.7
// C3: deterministic, no model calls, no network

import { DependencyGraph } from '../../core/sched/depgraph.js';
import { register } from './shared.js';
import { store } from './shared.js';

/**
 * zelto depgraph [<id1> <id2> ...] [--json]
 *
 * Build and display the dependency graph for the given slices.
 * If no IDs given, reads all frozen/completed slices and checks their
 * specs for ## Prerequisites sections (future enhancement — currently
 * reads from CLI or slice trace.requirements).
 *
 * Usage:
 *   zelto depgraph slice-a slice-b slice-c
 *   zelto depgraph slice-a slice-b --depends-on slice-b=slice-a --json
 */
register('depgraph', async (args) => {
  const ids = args.filter((a) => !a.startsWith('--'));
  const asJson = args.includes('--json');

  if (ids.length === 0) {
    console.error('Usage: zelto depgraph <slice-id-1> [slice-id-2 ...] [--depends-on <id>=<dep>] [--json]');
    return 1;
  }

  const graph = new DependencyGraph();

  // Add nodes from --depends-on CLI args
  const { parseDependsOnArgs } = await import('../../core/sched/depgraph.js');
  const cliDeps = parseDependsOnArgs(args);

  // Build the graph
  for (const id of ids) {
    const cliDep = cliDeps.get(id);
    const deps = cliDep ?? [];
    graph.addNode(id, deps);
  }

  // Check for cycles
  const cycle = graph.checkCycles();
  if (cycle) {
    if (asJson) {
      console.log(JSON.stringify({ hasCycle: true, cycle: cycle.cycle, phases: null }, null, 2));
    } else {
      console.log(`❌ Circular dependency detected:`);
      console.log(`   ${cycle.cycle.join(' → ')}`);
    }
    return 1;
  }

  // Get phases
  const phases = graph.phasesFromDeps();
  const sorted = graph.topologicalSort();
  const nodes = sorted.map((n) => ({
    id: n.sliceId,
    dependsOn: graph.getDependencies(n.sliceId),
    phase: n.phase,
  }));

  if (asJson) {
    console.log(JSON.stringify({ hasCycle: false, nodes, phases }, null, 2));
  } else {
    console.log(`Dependency Graph: ${ids.length} slices, ${phases.length} phases`);
    console.log('');
    for (let p = 0; p < phases.length; p++) {
      const phaseSlices = phases[p];
      console.log(`  Phase ${p}: ${phaseSlices.join(', ')}`);
      for (const id of phaseSlices) {
        const deps = graph.getDependencies(id);
        if (deps.length > 0) {
          console.log(`    ${id} depends on: ${deps.join(', ')}`);
        }
      }
      console.log('');
    }

    if (phases.length > 1) {
      console.log(`Execution order: sequential by phase, parallel within phase`);
      console.log(`Merge strategy: sequential_ff (phase-by-phase)`);
    } else if (phases.length === 1) {
      console.log(`All slices in same phase — can run in parallel`);
      console.log(`Merge strategy: merge_commit`);
    }
  }

  return 0;
});
