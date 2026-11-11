// Slice status command — show status of slices (read-only, no mutations)
// Usage: zelto slice-status [slice-id] [--json]
//   or:  zelto ss [slice-id] [--json]

import { register, store, events } from './shared.js';
import { getDefaultFormatter } from '../output-formatter.js';
import { colors } from '../color.js';

register('slice-status', async (args) => {
  const f = getDefaultFormatter();
  const [id] = args;
  const isJson = args.includes('--json');

  if (id === '--help' || id === '-h') {
    f.error('USAGE', 'Usage: zelto slice-status [slice-id] [--json]');
    return 1;
  }

  if (id) {
    return showSingleSliceStatus(id, isJson, f);
  }
  return showAllSlicesStatus(isJson, f);
});

// Alias: ss
register('ss', async (args) => {
  const f = getDefaultFormatter();
  const [id] = args;
  const isJson = args.includes('--json');

  if (id === '--help' || id === '-h') {
    f.error('USAGE', 'Usage: zelto ss [slice-id] [--json]');
    return 1;
  }

  if (id) {
    return showSingleSliceStatus(id, isJson, f);
  }
  return showAllSlicesStatus(isJson, f);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STATE_ICONS: Record<string, string> = {
  draft: '📝',
  clarifying: '❓',
  frozen: '❄️',
  running: '▶️',
  completed: '✅',
  abandoned: '🗑️',
};

const STATE_ORDER: Record<string, number> = {
  running: 0,
  frozen: 1,
  clarifying: 2,
  draft: 3,
  completed: 4,
  abandoned: 5,
};

const DAY_MS = 86400000;

function formatAge(dateStr: string): string {
  const age = Date.now() - new Date(dateStr).getTime();
  if (age < 0) return '0h';
  if (age < DAY_MS) {
    const h = Math.floor(age / 3600000);
    return h <= 0 ? '<1h' : `${h}h`;
  }
  return `${Math.floor(age / DAY_MS)}d`;
}

function statePriority(state: string): number {
  return STATE_ORDER[state] ?? 99;
}

// ─── Show All Slices ──────────────────────────────────────────────────────────

async function showAllSlicesStatus(isJson: boolean, f: ReturnType<typeof getDefaultFormatter>): Promise<number> {
  const ids = await store.list();

  if (isJson) {
    const slices = await Promise.all(
      ids.map(async (id) => {
        try {
          const s = await store.read(id);
          const evts = await events.read(id);
          return {
            id: s.id,
            title: s.title,
            state: s.state,
            eventCount: evts.length,
            hasDrift: s.drift.detected,
            isStalled: s.stall.class !== null,
            age: formatAge(s.updatedAt ?? s.createdAt),
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
          };
        } catch {
          return null;
        }
      }),
    );
    f.data({ slices: slices.filter(Boolean), total: ids.length });
    return 0;
  }

  if (ids.length === 0) {
    f.out('No slices found.');
    return 0;
  }

  // Read all slices
  const allSlices: Array<{ id: string; title: string; state: string; age: string; evtCount: number; drift: boolean; stalled: boolean }> = [];
  for (const id of ids) {
    try {
      const s = await store.read(id);
      const evts = await events.read(id);
      allSlices.push({
        id: s.id,
        title: s.title,
        state: s.state,
        age: formatAge(s.updatedAt ?? s.createdAt),
        evtCount: evts.length,
        drift: s.drift.detected,
        stalled: s.stall.class !== null,
      });
    } catch {
      // Skip unreadable slices
    }
  }

  // Sort by state priority
  allSlices.sort((a, b) => statePriority(a.state) - statePriority(b.state));

  const activeCount = allSlices.filter((s) => s.state !== 'completed' && s.state !== 'abandoned').length;
  const stalledCount = allSlices.filter((s) => s.stalled).length;
  const driftCount = allSlices.filter((s) => s.drift).length;

  f.out(`  ${colors.bold(`Slice Status (${allSlices.length})`)}`);
  f.out('');

  if (allSlices.length === 0) {
    f.out('  No slices found.');
    return 0;
  }

  for (const s of allSlices) {
    const icon = STATE_ICONS[s.state] ?? '📄';
    const title = s.title ? ` — ${s.title}` : '';
    const badge = s.stalled
      ? ` ${colors.red('⚠ STALLED')}`
      : s.drift
        ? ` ${colors.yellow('⚠ drift')}`
        : '';
    f.out(`  ${icon} [${s.id}] ${s.state} (${s.age})${badge}${title}`);
  }

  f.out('');
  f.out(`  ${colors.dim(`${activeCount} active · ${allSlices.length - activeCount} archived`)}`);
  if (stalledCount > 0) f.out(`  ${colors.red(`⚠ ${stalledCount} stalled`)}`);
  if (driftCount > 0) f.out(`  ${colors.yellow(`⚠ ${driftCount} with drift`)}`);

  return 0;
}

// ─── Show Single Slice Status ─────────────────────────────────────────────────

async function showSingleSliceStatus(id: string, isJson: boolean, f: ReturnType<typeof getDefaultFormatter>): Promise<number> {
  try {
    const s = await store.read(id);
    const evts = await events.read(id);

    // Compute counts from events
    const stateChanges = evts.filter((e) => e.type === 'slice.state.changed');
    const gateResults = evts.filter((e) => e.type === 'gate.result');
    const gatePasses = gateResults.filter((e) => e.payload?.passed === true);
    const gateFails = gateResults.filter((e) => e.payload?.passed === false);
    const stalls = evts.filter((e) => e.type === 'stall.classified');
    const driftEvents = evts.filter((e) => e.type === 'slice.drift_detected');
    const runEvents = evts.filter((e) => e.type.startsWith('run.'));
    const signEvents = evts.filter((e) => e.type.startsWith('sign.'));

    const gatePassRate = gateResults.length > 0
      ? `${Math.round((gatePasses.length / gateResults.length) * 100)}%`
      : 'N/A';

    if (isJson) {
      f.data({
        id: s.id,
        title: s.title,
        state: s.state,
        spec: s.spec,
        acceptance: s.acceptance,
        baseCommit: s.baseCommit,
        drift: s.drift,
        stall: s.stall,
        trace: s.trace,
        writes: s.writes,
        runs: s.runs,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        eventCount: evts.length,
        metrics: {
          stateChanges: stateChanges.length,
          gateRuns: gateResults.length,
          gatePasses: gatePasses.length,
          gateFails: gateFails.length,
          gatePassRate,
          stalls: stalls.length,
          driftEvents: driftEvents.length,
          runEvents: runEvents.length,
          signEvents: signEvents.length,
        },
      });
      return 0;
    }

    const icon = STATE_ICONS[s.state] ?? '📄';
    const age = formatAge(s.updatedAt ?? s.createdAt);

    f.out(`  ${icon} ${colors.bold(s.id)}`);
    f.out(`    Title:     ${s.title}`);
    f.out(`    State:     ${s.state} (${age})`);
    f.out(`    Events:    ${evts.length}`);

    if (s.stall.class) {
      f.out(`    Stall:     ${colors.red(s.stall.class)} (auto-resolved: ${s.stall.autoResolved})`);
    }
    if (s.drift.detected) {
      f.out(`    Drift:     ${colors.yellow(s.drift.reason ?? 'detected')}`);
    }

    f.out('');
    f.out(`  ${colors.dim('Metrics:')}`);
    f.out(`    State changes:  ${stateChanges.length}`);
    f.out(`    Gate runs:      ${gateResults.length} (${gatePasses.length} passed, ${gateFails.length} failed, ${gatePassRate} pass rate)`);
    f.out(`    Stalls:         ${stalls.length}`);
    f.out(`    Run events:     ${runEvents.length}`);
    f.out(`    Sign events:    ${signEvents.length}`);

    f.out('');
    f.out(`  ${colors.dim('Spec:')}`);
    f.out(`    Path:      ${s.spec.path}`);
    f.out(`    Frozen:    ${s.spec.frozenAt ? s.spec.frozenAt.slice(0, 10) : 'not frozen'}`);
    f.out(`    Base:      ${s.baseCommit ?? '(not set)'}`);
    f.out(`    Writes:    ${s.writes.length > 0 ? s.writes.join(', ') : '(none)'}`);

    if (s.runs.length > 0) {
      f.out('');
      f.out(`  ${colors.dim('Recent runs:')}`);
      for (const run of s.runs.slice(-3)) {
        f.out(`    - ${run.at.slice(0, 19).replace('T', ' ')}  ${run.ok ? '✔ ok' : '✘ failed'}${run.exitCode !== null ? ` (exit ${run.exitCode})` : ''}`);
      }
      if (s.runs.length > 3) f.out(`    ... (${s.runs.length - 3} more)`);
    }

    // Show last events
    if (evts.length > 0) {
      f.out('');
      f.out(`  ${colors.dim('Recent events:')}`);
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
}
