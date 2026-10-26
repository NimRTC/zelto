// Main coordinator for the trace command (v1 — JSON output path)
// Parses args, fetches trace data, renders output in text or JSON format.

import { parseTraceArgs, printTraceHelp } from './args.js';
import { fetchTraceData } from './data.js';
import { renderJsonTrace } from './json_render.js';
import type { TraceData } from './model.js';
import { register } from '../shared.js';
import { ZELTO_DIR, SLICES_DIR } from '../shared.js';
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
 * Usage: zelto trace <requirement-id> [--json]
 */
export async function traceCommand(args: string[]): Promise<number> {
  const parsed = parseTraceArgs(args);

  if (parsed.help) {
    printTraceHelp();
    return 0;
  }

  const data = await fetchTraceData(parsed.reqId, ZELTO_DIR, SLICES_DIR);

  if (!data) {
    if (parsed.format === 'json') {
      console.log(JSON.stringify({ error: `Requirement "${parsed.reqId}" not found.` }));
    } else {
      console.error(`Requirement "${parsed.reqId}" not found.`);
    }
    return 1;
  }

  if (parsed.format === 'json') {
    console.log(renderJsonTrace(data));
  } else {
    renderTextTrace(data);
  }

  return 0;
}

// ─── Register command ───────────────────────────────────────────────────────

register('trace', traceCommand);
