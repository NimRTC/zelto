// Slice detail command — show single slice details
// Usage: zelto slice <id> [--json]

import { register, store, events, hashSpecFile } from './shared.js';
import { getDefaultFormatter } from '../output-formatter.js';

register('slice', async (args) => {
  const [id] = args;
  const f = getDefaultFormatter();

  if (!id || id === '--help' || id === '-h') {
    f.error('USAGE', 'Usage: zelto slice <slice-id> [--json]');
    return 1;
  }

  const isJson = args.includes('--json');

  try {
    const slice = await store.read(id);
    const evts = await events.read(id);

    if (isJson) {
      f.data({
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
      });
      return 0;
    }

    const specHashOk = slice.spec.frozenHash
      ? (hashSpecFile(slice.spec.path) === slice.spec.frozenHash ? '✅' : '⚠️ changed')
      : '⬜ not frozen';

    const stateIcons: Record<string, string> = {
      draft: '📝', clarifying: '❓', frozen: '❄️',
      running: '▶️', completed: '✅', abandoned: '🗑️',
    };

    f.out(`${stateIcons[slice.state] ?? '📄'} ${slice.id}`);
    f.out(`  Title:     ${slice.title}`);
    f.out(`  State:     ${slice.state}`);
    f.out(`  Spec:      ${slice.spec.path} ${specHashOk}`);
    f.out(`  Created:   ${slice.createdAt.slice(0, 10)}`);
    f.out(`  Updated:   ${slice.updatedAt.slice(0, 10)}`);
    f.out(`  Base:      ${slice.baseCommit ?? '(not set)'}`);
    f.out(`  Writes:    ${slice.writes.length > 0 ? slice.writes.join(', ') : '(none)'}`);
    f.out(`  Events:    ${evts.length}`);

    if (slice.trace.requirements.length > 0) {
      f.out(`  Reqs:      ${slice.trace.requirements.join(', ')}`);
    }
    if (slice.trace.contracts.length > 0) {
      f.out(`  Contracts: ${slice.trace.contracts.join(', ')}`);
    }
    if (slice.trace.tests.length > 0) {
      f.out(`  Tests:     ${slice.trace.tests.join(', ')}`);
    }

    if (slice.drift.detected) {
      f.out(`  Drift:     ⚠️ ${slice.drift.reason}`);
    }

    if (slice.stall.class) {
      f.out(`  Stall:     ⚠️ ${slice.stall.class} (auto-resolved: ${slice.stall.autoResolved})`);
    }

    if (slice.runs.length > 0) {
      f.out(`  Runs:      ${slice.runs.length}`);
      for (const run of slice.runs.slice(-3)) {
        f.out(`    - ${run}`);
      }
      if (slice.runs.length > 3) f.out(`    ... (${slice.runs.length - 3} more)`);
    }

    // Show last 5 events
    if (evts.length > 0) {
      f.out(`\n  Recent events:`);
      for (const e of evts.slice(-5)) {
        f.out(`    [${e.ts?.slice(0, 19) ?? '?'}] ${e.type} (${e.actor})`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    f.error('READ_ERROR', `Error reading slice "${id}": ${msg}`);
    return 1;
  }
  return 0;
});
