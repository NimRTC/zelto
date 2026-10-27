// Main coordinator for the trace command (v3 — supports graph and timeline rendering)
// Parses args, fetches trace data, renders output in text, JSON, graph, or timeline format.

import { parseTraceArgs, printTraceHelp } from './args.js';
import { fetchTraceData } from './data.js';
import { renderJsonTrace } from './json_render.js';
import { renderDesignDepGraph } from './graph_render.js';
import { renderTimelineTrace } from './timeline_render.js';
import type { TraceData } from './model.js';
import { register } from '../shared.js';
import { ZELTO_DIR, SLICES_DIR, store } from '../shared.js';
import { colors } from '../../color.js';

// ─── State color map for text output ────────────────────────────────────────

const STATE_COLORS: Record<string, (s: string) => string> = {
  draft: colors.yellow,
  clarifying: colors.blue,
  frozen: colors.magenta,
  running: colors.cyan,
  completed: colors.green,
  abandoned: colors.gray,
};

function stateColor(state: string): string {
  const fn = STATE_COLORS[state] ?? colors.dim;
  return fn(state);
}

function statusIcon(status: string): string {
  return status === 'confirmed' ? '✅' : '📝';
}

// ─── Text rendering ─────────────────────────────────────────────────────────

function renderTextTrace(data: TraceData): void {
  const req = data.requirement;
  console.log(`📋 Trace for: ${req.id}  "${req.title}"  (${req.status})`);
  console.log(`   Acceptance Criteria: ${req.acceptanceCriteria.length}`);
  console.log('');

  if (data.designs.length === 0) {
    console.log('   No designs trace to this requirement.');
    return;
  }

  for (const design of data.designs) {
    console.log(
      `   ${statusIcon(design.status)} Design: ${design.id}  "${design.title}"  (${design.status})`,
    );
    console.log(`      Modules: ${design.modules.map((m) => m.name).join(', ')}`);

    if (design.plans.length === 0) {
      console.log('      └── No plan traces to this design.');
      continue;
    }

    for (const plan of design.plans) {
      console.log(
        `      ${statusIcon(plan.status)} Plan: ${plan.id}  "${plan.title}"  (${plan.status})`,
      );

      for (const v of plan.versions) {
        console.log(`         ${v.version}  (${v.status}):`);

        for (const s of v.slices) {
          console.log(
            `           ${s.id}  (${stateColor(s.state)})  ${s.title}  [module: ${s.module}]`,
          );
        }
      }
    }
  }
}

// ─── Main handler ───────────────────────────────────────────────────────────

/**
 * Main trace command handler.
 * Usage: zelto trace <requirement-id> [--json|--graph|--timeline]
 *        zelto trace <slice-id> --slice   Trace a slice's events and state
 */
export async function traceCommand(args: string[]): Promise<number> {
  const parsed = parseTraceArgs(args);

  if (parsed.help) {
    printTraceHelp();
    return 0;
  }

  // Support: zelto trace <slice-id> --slice — show slice traceability
  if (args.includes('--slice')) {
    return traceSlice(parsed.reqId);
  }

  // Auto-detect: if ID exists as a slice, show slice trace
  const sliceExists = await store.exists(parsed.reqId).catch(() => false);
  if (sliceExists) {
    return traceSlice(parsed.reqId);
  }

  const data = await fetchTraceData(parsed.reqId, ZELTO_DIR, SLICES_DIR);

  if (!data) {
    if (parsed.format === 'json') {
      console.log(JSON.stringify({ error: `Requirement "${parsed.reqId}" not found.` }));
    } else {
      console.error(`Requirement "${parsed.reqId}" not found.`);
      console.error(`Tip: Use "zelto trace <slice-id> --slice" to trace a slice.`);
    }
    return 1;
  }

  switch (parsed.format) {
    case 'json':
      console.log(renderJsonTrace(data));
      break;
    case 'graph':
      // Map TraceData designs to the format expected by renderDesignDepGraph
      console.log(renderDesignDepGraph(
        data.designs.map((d) => ({
          id: d.id,
          title: d.title,
          status: d.status,
          modules: d.modules.map((m) => ({
            name: m.name,
            description: m.description,
            dependencies: [] as string[],
          })),
        })),
      ));
      break;
    case 'timeline':
      console.log(renderTimelineTrace(data));
      break;
    default:
      renderTextTrace(data);
      break;
  }

  return 0;
}

// ─── Register command ───────────────────────────────────────────────────────

register('trace', traceCommand);

// ─── Slice tracing ──────────────────────────────────────────────────────────

/**
 * Trace a slice: show its state, events, and related requirements/contracts.
 */
async function traceSlice(sliceId: string): Promise<number> {
  try {
    const slice = await store.read(sliceId);
    const evts = await (await import('../shared.js')).events.read(sliceId);

    console.log(`📋 Slice trace: ${sliceId}`);
    console.log(`   Title:       ${slice.title}`);
    console.log(`   State:       ${stateColor(slice.state)}`);
    console.log(`   Created:     ${slice.createdAt.slice(0, 10)}`);
    console.log(`   Updated:     ${slice.updatedAt.slice(0, 10)}`);
    console.log(`   Events:      ${evts.length}`);
    console.log(`   Writes:      ${slice.writes.length > 0 ? slice.writes.join(', ') : '(none)'}`);

    if (slice.trace.requirements.length > 0) {
      console.log(`   Reqs:        ${slice.trace.requirements.join(', ')}`);
    }
    if (slice.trace.contracts.length > 0) {
      console.log(`   Contracts:   ${slice.trace.contracts.join(', ')}`);
    }
    if (slice.trace.tests.length > 0) {
      console.log(`   Tests:       ${slice.trace.tests.join(', ')}`);
    }

    if (slice.stall.class) {
      console.log(`   Stall:       ${slice.stall.class} (resolved: ${slice.stall.autoResolved})`);
    }

    // Show state timeline
    console.log(`\n   State timeline:`);
    const stateEvents = evts.filter((e: { type: string }) => e.type === 'slice.state.changed');
    for (const e of stateEvents.slice(-10)) {
      const payload = e.payload as { from?: string; to?: string } | undefined;
      if (payload?.from && payload?.to) {
        console.log(`     ${stateColor(payload.from)} → ${stateColor(payload.to)}`);
      }
    }

    // Show recent events
    if (evts.length > 0) {
      console.log(`\n   Recent events:`);
      for (const e of evts.slice(-5)) {
        console.log(`     [${e.ts?.slice(0, 19) ?? '?'}] ${e.type} (${e.actor})`);
      }
    }

    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Slice "${sliceId}" not found: ${msg}`);
    return 1;
  }
}
