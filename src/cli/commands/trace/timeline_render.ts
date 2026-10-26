// Timeline view rendering module for the trace command (v3)
// Renders a visual vertical timeline of versions and slices using Unicode
// box-drawing characters. Each version appears as a phase on the timeline,
// with slices listed as items beneath it.
//
// Built on the color utilities from ../../color.js and the badge module.

import { colors } from '../../color.js';
import { getStateColor, getStatusColor, getStatusIcon } from './badge.js';
import type { TraceData } from './model.js';

// ─── Timeline Configuration ───────────────────────────────────────────────────

/** Width reserved for the version label column (padded right) */
const VERSION_LABEL_WIDTH = 6;

/** Width reserved for the state badge column */
const STATE_BADGE_WIDTH = 14;

/** Minimum width for the slice title column */
const SLICE_TITLE_MIN_WIDTH = 30;

// ─── Timeline Segment Types ───────────────────────────────────────────────────

/** A single segment in the timeline — either a version phase or a slice item */
interface TimelineSegment {
  /** The version identifier (e.g. "v1") */
  version: string;
  /** Version description */
  description: string;
  /** Version status (e.g. "planned", "integrated") */
  status: string;
  /** The slices belonging to this version */
  slices: TimelineSliceItem[];
}

/** A slice item within a timeline version segment */
interface TimelineSliceItem {
  /** Slice ID */
  id: string;
  /** Slice title */
  title: string;
  /** Slice module */
  module: string;
  /** Slice state (e.g. "draft", "completed") */
  state: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a flat list of timeline segments from trace data,
 * grouped by plan → version.
 */
function buildTimelineSegments(data: TraceData): TimelineSegment[] {
  const segments: TimelineSegment[] = [];

  for (const design of data.designs) {
    for (const plan of design.plans) {
      for (const v of plan.versions) {
        segments.push({
          version: v.version,
          description: v.description,
          status: v.status,
          slices: v.slices.map((s) => ({
            id: s.id,
            title: s.title,
            module: s.module,
            state: s.state,
          })),
        });
      }
    }
  }

  return segments;
}

// ─── Timeline Bar ─────────────────────────────────────────────────────────────

/**
 * Render a horizontal phase bar for a version.
 *
 * Uses a colored bar proportional to the number of completed slices vs total.
 * The bar is 16 characters wide and colored by completion ratio.
 *
 * @param completed - Number of completed (or abandoned) slices.
 * @param total - Total number of slices in this version.
 * @returns A colored bar string, e.g. `"████████░░░░░░░░"`.
 */
function renderPhaseBar(completed: number, total: number): string {
  const barWidth = 16;
  const ratio = total > 0 ? completed / total : 0;
  const filled = Math.round(ratio * barWidth);
  const empty = barWidth - filled;

  // Color by completion ratio
  let colorFn: (s: string) => string;
  if (ratio >= 1) colorFn = colors.green;
  else if (ratio >= 0.5) colorFn = colors.cyan;
  else if (ratio >= 0.25) colorFn = colors.yellow;
  else colorFn = colors.dim;

  return colorFn('█'.repeat(filled) + '░'.repeat(empty));
}

// ─── Timeline Branch Lines ────────────────────────────────────────────────────

/**
 * Render a single version phase line with its status badge and phase bar.
 *
 * @example
 *   renderVersionPhase('v1', 'Basic auth flow', 'integrated', 2, 2)
 *   // "  v1 ── Basic auth flow ──████████████████ [integrated]"
 */
function renderVersionPhase(
  version: string,
  description: string,
  status: string,
  completed: number,
  total: number,
): string {
  const versionLabel = colors.cyan(version.padEnd(VERSION_LABEL_WIDTH));
  const desc = description ? ` ${colors.dim(description)}` : '';
  const bar = ` ${renderPhaseBar(completed, total)}`;
  const statusBadge = ` ${getStatusColor(status)(`[${status}]`)}`;

  return `  ${versionLabel}──${desc}${bar}${statusBadge}`;
}

/**
 * Render the vertical connector line for a version phase.
 *
 * Shows a branch line that connects the version header to its slices.
 *
 * @example
 *   renderVersionBranch(true) // "  │      │"
 *   renderVersionBranch(false) // "         │"
 */
function renderVersionBranch(isLastVersion: boolean): string {
  const prefix = '  '.padEnd(VERSION_LABEL_WIDTH + 3, ' ');
  if (isLastVersion) {
    return `${prefix}│`;
  }
  return `${prefix}│`;
}

/**
 * Render a single slice item on the timeline branch.
 *
 * @example
 *   renderSliceItem('v1-auth-login', 'completed', 'Login endpoint', 'auth', true)
 *   // "  │      ├── v1-auth-login  [completed]  Login endpoint  [auth]"
 */
function renderSliceItem(
  id: string,
  state: string,
  title: string,
  module: string,
  isLastSlice: boolean,
): string {
  const connector = isLastSlice ? '└──' : '├──';
  const indent = '  '.padEnd(VERSION_LABEL_WIDTH + 3, ' ');
  const stateColorFn = getStateColor(state);
  const stateBadge = stateColorFn(`[${state}]`.padEnd(STATE_BADGE_WIDTH));
  const titleStr = title.padEnd(SLICE_TITLE_MIN_WIDTH);
  const moduleStr = colors.dim(`[${module}]`);

  return `  ${indent}${connector} ${id}  ${stateBadge}  ${titleStr}  ${moduleStr}`;
}

// ─── Main Timeline Render Functions ───────────────────────────────────────────

/**
 * Render a full timeline view for trace data.
 *
 * Shows versions as sequential phases on a vertical timeline, with slices
 * as items branching off each version phase. The timeline uses Unicode
 * box-drawing characters for visual structure.
 *
 * @param data - The trace data to render.
 * @returns A formatted multi-line string ready for console output.
 *
 * @example
 *   renderTimeline(data)
 *   // 📋 Timeline: req-1  "User authentication"
 *   //
 *   //   Auth implementation plan (confirmed)
 *   //
 *   //   v1    ── Basic auth flow ──████████████████ [integrated]
 *   //   │
 *   //   │     ├── v1-auth-login   [completed]  Login endpoint    [auth]
 *   //   │     └── v1-auth-logout  [completed]  Logout endpoint   [auth]
 *   //   │
 *   //   v2    ── OAuth support ──░░░░░░░░░░░░░░░░ [planned]
 *   //   │
 *   //   │     └── v2-auth-oauth   [draft]       OAuth integration [auth]
 */
export function renderTimeline(data: TraceData): string {
  const lines: string[] = [];
  const req = data.requirement;
  const reqIcon = getStatusIcon(req.status);

  // ── Header ────────────────────────────────────────────────────────────────
  lines.push(`${reqIcon} Timeline: ${colors.bold(req.id)}  "${req.title}"  ${getStatusColor(req.status)(`(${req.status})`)}`);
  lines.push('');

  if (data.designs.length === 0) {
    lines.push('   No designs trace to this requirement.');
    return lines.join('\n');
  }

  // ── Per-plan timeline ─────────────────────────────────────────────────────
  for (const design of data.designs) {
    if (design.plans.length === 0) {
      lines.push(`   ${colors.dim('No plan traces to this design.')}`);
      continue;
    }

    for (const plan of design.plans) {
      const planIcon = getStatusIcon(plan.status);
      lines.push(`   ${planIcon} ${colors.bold(plan.title)}  ${getStatusColor(plan.status)(`(${plan.status})`)}`);
      lines.push('');

      const segments = buildTimelineSegments({
        requirement: data.requirement,
        designs: [design],
      });

      // Filter segments to only those under this plan
      const planSegments = segments;

      for (let vi = 0; vi < planSegments.length; vi++) {
        const seg = planSegments[vi];
        const isLastVersion = vi === planSegments.length - 1;
        const completed = seg.slices.filter(
          (s) => s.state === 'completed' || s.state === 'abandoned',
        ).length;
        const total = seg.slices.length;

        // Version phase header
        lines.push(renderVersionPhase(seg.version, seg.description, seg.status, completed, total));

        // Branch line
        if (seg.slices.length > 0) {
          lines.push(renderVersionBranch(isLastVersion));
        }

        // Slice items
        for (let si = 0; si < seg.slices.length; si++) {
          const slice = seg.slices[si];
          const isLastSlice = si === seg.slices.length - 1;
          lines.push(renderSliceItem(slice.id, slice.state, slice.title, slice.module, isLastSlice));
        }

        // Gap between versions (only if not last)
        if (!isLastVersion) {
          lines.push(renderVersionBranch(false));
        }
      }

      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Alias for `renderTimeline` — used by the trace command coordinator (trace.ts).
 *
 * The coordinator imports `renderTimelineTrace` for the `--timeline` format.
 * This alias provides the canonical entry point name expected by the v3
 * coordinator extension.
 */
export const renderTimelineTrace = renderTimeline;

/**
 * Render a compact timeline summary — a single-line-per-version view
 * with a Unicode phase bar.
 *
 * Useful for quick status at a glance without the full slice breakdown.
 *
 * @param data - The trace data to render.
 * @returns A formatted multi-line string.
 *
 * @example
 *   renderTimelineSummary(data)
 *   // Timeline: req-1
 *   //   v1  ████████████████ 100%  integrated  Basic auth flow
 *   //   v2  ░░░░░░░░░░░░░░░░   0%  planned     OAuth support
 */
export function renderTimelineSummary(data: TraceData): string {
  const lines: string[] = [];
  const req = data.requirement;

  lines.push(`Timeline: ${colors.bold(req.id)}`);

  for (const design of data.designs) {
    for (const plan of design.plans) {
      for (const v of plan.versions) {
        const completed = v.slices.filter(
          (s) => s.state === 'completed' || s.state === 'abandoned',
        ).length;
        const total = v.slices.length;
        const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
        const bar = renderPhaseBar(completed, total);
        const versionLabel = colors.cyan(v.version.padEnd(VERSION_LABEL_WIDTH));
        const pctStr = String(pct).padStart(3);
        const statusStr = getStatusColor(v.status)(v.status.padEnd(12));
        const desc = v.description ? `  ${colors.dim(v.description)}` : '';

        lines.push(`  ${versionLabel} ${bar} ${pctStr}%  ${statusStr}${desc}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Render a compact one-line-per-slice timeline for dense output.
 *
 * Useful for viewing all slices across versions in a compact format.
 *
 * @param data - The trace data to render.
 * @returns A formatted multi-line string.
 */
export function renderCompactTimeline(data: TraceData): string {
  const lines: string[] = [];
  const req = data.requirement;

  lines.push(`${getStatusIcon(req.status)} Timeline: ${colors.bold(req.id)}  "${req.title}"`);

  for (const design of data.designs) {
    for (const plan of design.plans) {
      for (const v of plan.versions) {
        const versionLabel = colors.cyan(v.version);
        lines.push(`  ${versionLabel} (${v.status}):`);

        for (const s of v.slices) {
          const stateColorFn = getStateColor(s.state);
          const stateBadge = stateColorFn(`[${s.state}]`);
          const moduleLabel = colors.dim(`[${s.module}]`);
          lines.push(`    ${s.id}  ${stateBadge}  ${s.title}  ${moduleLabel}`);
        }
      }
    }
  }

  return lines.join('\n');
}
