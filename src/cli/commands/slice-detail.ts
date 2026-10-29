// Slice detail command — show single slice details
// Usage: zelto slice <id> [--json]

import { register, store, events, hashSpecFile } from './shared.js';
import { getDefaultFormatter } from '../output-formatter.js';

// ─── slice (detail) ────────────────────────────────────────────────────────

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

// ─── slice set (edit slice fields) ─────────────────────────────────────────

const SLICE_SETTABLE_FIELDS = new Set([
  'title', 'traceWaiver', 'writes', 'acceptance.dir',
  'trace.requirements', 'trace.contracts', 'trace.tests',
  'baseCommit', 'baseline',
]);

register('set', async (args) => {
  const [id] = args;
  const f = getDefaultFormatter();

  if (!id || id === '--help' || id === '-h') {
    f.error('USAGE', 'Usage: zelto set <slice-id> --field <name> --value <val> [--json]');
    f.out('');
    f.out('Settable fields:');
    for (const field of [...SLICE_SETTABLE_FIELDS].sort()) {
      f.out(`  ${field}`);
    }
    return 1;
  }

  const isJson = args.includes('--json');
  const fieldIdx = args.indexOf('--field');
  const valueIdx = args.indexOf('--value');

  if (fieldIdx < 0 || valueIdx < 0) {
    f.error('MISSING_ARGS', 'Both --field and --value are required');
    return 1;
  }

  const field = args[fieldIdx + 1];
  const rawValue = args[valueIdx + 1];

  if (!field || !rawValue) {
    f.error('MISSING_ARGS', 'Both --field and --value require a value');
    return 1;
  }

  if (!SLICE_SETTABLE_FIELDS.has(field)) {
    f.error('INVALID_FIELD', `Unknown field: "${field}". Use --help to list settable fields.`);
    return 1;
  }

  try {
    const slice = await store.read(id);
    const prevState = slice.state;

    // Parse value: comma-separated for array fields, boolean for boolean fields
    if (field === 'writes' || field === 'trace.requirements' || field === 'trace.contracts' || field === 'trace.tests') {
      const values = rawValue.split(',').map((v: string) => v.trim()).filter(Boolean);
      if (field === 'writes') slice.writes = values;
      else if (field === 'trace.requirements') slice.trace.requirements = values;
      else if (field === 'trace.contracts') slice.trace.contracts = values;
      else if (field === 'trace.tests') slice.trace.tests = values;
    } else if (field === 'baseline') {
      slice.baseline = rawValue === 'true' || rawValue === '1';
    } else if (field === 'title') {
      slice.title = rawValue;
    } else if (field === 'traceWaiver') {
      slice.traceWaiver = rawValue || null;
    } else if (field === 'acceptance.dir') {
      slice.acceptance.dir = rawValue;
    } else if (field === 'baseCommit') {
      slice.baseCommit = rawValue || null;
    }

    await store.write(slice);
    await events.append(id, 'spec.drafted', 'cli', {
      sliceId: id, field, fromValue: prevState, action: 'slice.set',
    });

    if (isJson) {
      f.data({ success: true, id, field, value: rawValue });
      return 0;
    }

    f.out(`zelto set ${id} — ✅ Updated ${field}`);
    f.out(`  ${field}: ${rawValue}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    f.error('SET_ERROR', `Error updating slice "${id}": ${msg}`);
    return 1;
  }
  return 0;
});
