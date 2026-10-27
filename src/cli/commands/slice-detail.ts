// Slice detail command — show single slice details
// Usage: zelto slice <id> [--json]

import { register, store, events, hashSpecFile } from './shared.js';

register('slice', async (args) => {
  const [id] = args;
  if (!id || id === '--help' || id === '-h') {
    console.error('Usage: zelto slice <slice-id> [--json]');
    return 1;
  }

  const isJson = args.includes('--json');

  try {
    const slice = await store.read(id);
    const evts = await events.read(id);

    if (isJson) {
      console.log(JSON.stringify({
        id: slice.id,
        title: slice.title,
        state: slice.state,
        spec: slice.spec,
        acceptance: slice.acceptance,
        baseCommit: slice.baseCommit,
        drift: slice.drift,
        trace: slice.trace,
        writes: slice.writes,
        runs: slice.runs,
        stall: slice.stall,
        createdAt: slice.createdAt,
        updatedAt: slice.updatedAt,
        eventCount: evts.length,
      }, null, 2));
      return 0;
    }

    const specHashOk = slice.spec.frozenHash
      ? (hashSpecFile(slice.spec.path) === slice.spec.frozenHash ? '✅' : '⚠️ changed')
      : '⬜ not frozen';

    const stateIcons: Record<string, string> = {
      draft: '📝', clarifying: '❓', frozen: '❄️',
      running: '▶️', completed: '✅', abandoned: '🗑️',
    };

    console.log(`${stateIcons[slice.state] ?? '📄'} ${slice.id}`);
    console.log(`  Title:     ${slice.title}`);
    console.log(`  State:     ${slice.state}`);
    console.log(`  Spec:      ${slice.spec.path} ${specHashOk}`);
    console.log(`  Created:   ${slice.createdAt.slice(0, 10)}`);
    console.log(`  Updated:   ${slice.updatedAt.slice(0, 10)}`);
    console.log(`  Base:      ${slice.baseCommit ?? '(not set)'}`);
    console.log(`  Writes:    ${slice.writes.length > 0 ? slice.writes.join(', ') : '(none)'}`);
    console.log(`  Events:    ${evts.length}`);

    if (slice.trace.requirements.length > 0) {
      console.log(`  Reqs:      ${slice.trace.requirements.join(', ')}`);
    }
    if (slice.trace.contracts.length > 0) {
      console.log(`  Contracts: ${slice.trace.contracts.join(', ')}`);
    }
    if (slice.trace.tests.length > 0) {
      console.log(`  Tests:     ${slice.trace.tests.join(', ')}`);
    }

    if (slice.drift.detected) {
      console.log(`  Drift:     ⚠️ ${slice.drift.reason}`);
    }

    if (slice.stall.class) {
      console.log(`  Stall:     ⚠️ ${slice.stall.class} (auto-resolved: ${slice.stall.autoResolved})`);
    }

    if (slice.runs.length > 0) {
      console.log(`  Runs:      ${slice.runs.length}`);
      for (const run of slice.runs.slice(-3)) {
        console.log(`    - ${run}`);
      }
      if (slice.runs.length > 3) console.log(`    ... (${slice.runs.length - 3} more)`);
    }

    // Show last 5 events
    if (evts.length > 0) {
      console.log(`\n  Recent events:`);
      for (const e of evts.slice(-5)) {
        console.log(`    [${e.ts?.slice(0, 19) ?? '?'}] ${e.type} (${e.actor})`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error reading slice "${id}": ${msg}`);
    return 1;
  }
  return 0;
});
