// zelto merge — merge orchestration for parallel slice outputs
//
// See docs/adr-012-parallel-coordination.md §3.7
// C3: deterministic, no model calls, no network

import { formatMergePlan } from '../../core/sched/merge.js';
import { parseDependsOnArgs } from '../../core/sched/depgraph.js';
import { register, store, events, resolveSpecDir } from './shared.js';
import { buildMergePlan } from './merge-plan.js';
import { executeMergePlan, type MergeSliceInfo } from './merge-executor.js';

/**
 * zelto merge [<id1> <id2> ...] [--strategy <s>] [--plan] [--dry-run] [--json]
 * zelto merge plan <id1> [id2 ...] [--json]
 *
 * Merge orchestration for completed parallel slices.
 *
 * Subcommands:
 *   plan     Show merge plan without executing
 *   (default) Execute the merge plan
 *
 * Usage:
 *   zelto merge plan slice-a slice-b
 *   zelto merge slice-a slice-b --strategy merge_commit
 *   zelto merge slice-a slice-b --dry-run
 */
register('merge', async (args) => {
  const subCmd = args[0];
  const ids = args.filter((a) => !a.startsWith('--') && a !== 'plan');
  const asJson = args.includes('--json');
  const isDryRun = args.includes('--dry-run');
  const isPlanOnly = subCmd === 'plan';

  // --depends-on parsing for dependency graph
  const cliDeps = parseDependsOnArgs(args);

  // Check for --strategy override
  const strategyIdx = args.indexOf('--strategy');
  let strategyOverride: string | undefined;
  if (strategyIdx >= 0 && strategyIdx + 1 < args.length) {
    strategyOverride = args[strategyIdx + 1];
  }

  if (ids.length === 0) {
    console.error('Usage: zelto merge plan <slice-id-1> [slice-id-2 ...] [--json]');
    console.error('       zelto merge <slice-id-1> [slice-id-2 ...] [--strategy <s>] [--dry-run] [--json]');
    console.error('');
    console.error('Subcommands:');
    console.error('  plan     Show merge plan without executing');
    console.error('');
    console.error('Strategies: sequential_ff, merge_commit, rebase_onto, manual');
    return 1;
  }

  // Read slice data
  const slices = new Map<string, import('../../core/slice/store.js').SliceData>();
  const mergeInfos: MergeSliceInfo[] = [];
  const notFound: string[] = [];

  for (const id of ids) {
    try {
      const slice = await store.read(id);
      if (slice.state !== 'frozen' && slice.state !== 'completed') {
        console.warn(`  ⚠️  ${id}: state is "${slice.state}", expected "frozen" or "completed"`);
      }
      slices.set(id, slice);
      mergeInfos.push({
        id,
        branch: `slice/${id}`,
        baseCommit: slice.baseCommit,
      });
    } catch {
      notFound.push(id);
    }
  }

  if (notFound.length > 0) {
    console.error(`Slice(s) not found: ${notFound.join(', ')}`);
    return 1;
  }

  // Generate merge plan — dependencies come from the spec's "前置切片" section,
  // overridable with --depends-on.
  let plan;
  try {
    plan = await buildMergePlan({
      ids,
      slices,
      specDir: resolveSpecDir(),
      cliDeps,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`❌ ${msg}`);
    return 1;
  }

  // Apply strategy override if specified
  if (strategyOverride) {
    const validStrategies = ['sequential_ff', 'merge_commit', 'rebase_onto', 'manual'];
    if (!validStrategies.includes(strategyOverride)) {
      console.error(`Invalid strategy: "${strategyOverride}". Valid: ${validStrategies.join(', ')}`);
      return 1;
    }
    plan.strategy = strategyOverride as typeof plan.strategy;
    for (const phase of plan.phases) {
      phase.strategy = strategyOverride as typeof phase.strategy;
    }
    // Clear estimated conflicts if strategy overridden to merge_commit
    if (strategyOverride === 'merge_commit' || strategyOverride === 'sequential_ff') {
      plan.estimatedConflicts = [];
    }
  }

  if (asJson) {
    console.log(JSON.stringify(plan, null, 2));
  } else if (isPlanOnly) {
    console.log(formatMergePlan(plan));
  } else {
    console.log(formatMergePlan(plan));

    if (plan.strategy === 'manual') {
      console.log('');
      console.log('⚠️  Manual intervention required:');
      if (plan.estimatedConflicts.length > 0) {
        console.log(`   Write-set conflicts detected:`);
        for (const f of plan.estimatedConflicts) {
          console.log(`     - ${f}`);
        }
      }
      console.log('');
      console.log('   To resolve:');
      console.log('   1. Manually merge the conflicting files');
      console.log('   2. Create a merge commit');
      console.log('   3. Run zelto merge with --strategy merge_commit after resolution');
      return 1;
    }

    if (isDryRun) {
      console.log('');
      console.log('🔍 Dry-run — no changes made.');
      console.log(`   Run without --dry-run to execute the merge.`);
      return 0;
    }

    console.log('');
    console.log(`Executing merge (strategy: ${plan.strategy})...`);

    const result = await executeMergePlan(plan, mergeInfos, {
      events,
      repoRoot: process.cwd(),
      log: (m) => console.log(m),
    });

    if (result.aborted) {
      console.log('');
      console.log(`❌ Merge aborted — ${result.conflicts.length} slice(s) conflicted. The main branch was not modified.`);
      return 1;
    }

    console.log('');
    console.log(`✅ Merge complete (${plan.phases.length} phases, ${result.merged.length} slices)`);
  }

  return 0;
});
