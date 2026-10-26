// Progress indicator rendering module for the trace command (v2)
// Computes and renders progress bars for versions and overall trace chain.
// Built on the color utilities from ../../color.js and the badge module.

import { colors } from '../../color.js';
import { getStateColor } from './badge.js';
import type { TraceData } from './model.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Progress statistics for a single version */
export interface VersionProgress {
  /** Version identifier (e.g. "v1", "v2") */
  version: string;
  /** Human-readable description of this version */
  description: string;
  /** Version status (e.g. "planned", "in_progress", "integrated") */
  status: string;
  /** Total number of slices in this version */
  totalSlices: number;
  /** Number of completed (or abandoned) slices */
  completedSlices: number;
  /** Completion percentage (0–100) */
  percentage: number;
}

/** Aggregate progress statistics for a full trace chain */
export interface TraceProgress {
  /** Per-version progress entries */
  versions: VersionProgress[];
  /** Total slices across all versions */
  overallTotal: number;
  /** Total completed slices across all versions */
  overallCompleted: number;
  /** Overall completion percentage (0–100) */
  overallPercentage: number;
}

// ─── Progress Computation ────────────────────────────────────────────────────

/**
 * Compute progress statistics from trace data.
 *
 * Counts `completed` and `abandoned` slices as "done" for progress purposes,
 * matching the convention established in `core/report/report-analyzer.ts`.
 *
 * @param data - The trace data to compute progress for.
 * @returns Aggregate and per-version progress statistics.
 */
export function computeProgress(data: TraceData): TraceProgress {
  const versions: VersionProgress[] = [];
  let overallTotal = 0;
  let overallCompleted = 0;

  for (const design of data.designs) {
    for (const plan of design.plans) {
      for (const v of plan.versions) {
        const total = v.slices.length;
        const completed = v.slices.filter(
          (s) => s.state === 'completed' || s.state === 'abandoned',
        ).length;
        overallTotal += total;
        overallCompleted += completed;
        versions.push({
          version: v.version,
          description: v.description,
          status: v.status,
          totalSlices: total,
          completedSlices: completed,
          percentage: total > 0 ? Math.round((completed / total) * 100) : 0,
        });
      }
    }
  }

  return {
    versions,
    overallTotal,
    overallCompleted,
    overallPercentage:
      overallTotal > 0
        ? Math.round((overallCompleted / overallTotal) * 100)
        : 0,
  };
}

// ─── Progress Bar Rendering ──────────────────────────────────────────────────

/** Width of the progress bar in characters */
const BAR_WIDTH = 20;

/** Fill character for the completed portion of the bar */
const BAR_FILL = '█';

/** Empty character for the remaining portion of the bar */
const BAR_EMPTY = '░';

/**
 * Choose a color function based on completion percentage.
 *
 * - 100%  → green (all done)
 * - ≥50%  → cyan (well underway)
 * - ≥25%  → yellow (started)
 * - <25%  → dim (barely started)
 */
function barColor(percentage: number): (s: string) => string {
  if (percentage >= 100) return colors.green;
  if (percentage >= 50) return colors.cyan;
  if (percentage >= 25) return colors.yellow;
  return colors.dim;
}

/**
 * Render a single progress bar string.
 *
 * Produces a 20-character Unicode bar with a percentage label, colored
 * according to the completion level.
 *
 * @param percentage - Completion percentage (0–100).
 * @returns A colored progress bar string, e.g. `"██████████░░░░░░░░░░ 50%"`.
 *
 * @example
 *   renderProgressBar(75) // returns cyan "███████████████░░░░░ 75%"
 *   renderProgressBar(100) // returns green "████████████████████ 100%"
 *   renderProgressBar(0) // returns dim "░░░░░░░░░░░░░░░░░░░░ 0%"
 */
export function renderProgressBar(percentage: number): string {
  const clamped = Math.max(0, Math.min(100, percentage));
  const filled = Math.round((clamped / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  const bar = BAR_FILL.repeat(filled) + BAR_EMPTY.repeat(empty);
  const colorFn = barColor(clamped);
  return `${colorFn(bar)} ${colors.bold(String(clamped))}%`;
}

/**
 * Render progress for a single version entry.
 *
 * @param vp - Version progress data.
 * @returns A formatted string with version label, progress bar, and slice count.
 *
 * @example
 *   renderVersionLine({ version: 'v1', percentage: 100, ... })
 *   // "v1  Basic auth flow"
 *   // "  ████████████████████ 100%  2/2 slices"
 */
export function renderVersionLine(vp: VersionProgress): string {
  const versionLabel = `${colors.cyan(vp.version)}`;
  const desc = vp.description ? `  ${colors.dim(vp.description)}` : '';
  const bar = renderProgressBar(vp.percentage);
  return (
    `   ${versionLabel}${desc}\n` +
    `     ${bar}  ${vp.completedSlices}/${vp.totalSlices} slices`
  );
}

// ─── Full Progress Overview ─────────────────────────────────────────────────-

/**
 * Render a full progress overview for trace data.
 *
 * Shows per-version progress bars with descriptions, and an overall summary
 * when multiple versions are present.
 *
 * @param data - The trace data to render progress for.
 * @returns A formatted multi-line string ready for console output.
 *
 * @example
 *   renderProgress(data)
 *   // 📊 Progress Overview
 *   //
 *   //   v1  Basic auth flow
 *   //     ████████████████████ 100%  2/2 slices
 *   //
 *   //   v2  OAuth support
 *   //     ░░░░░░░░░░░░░░░░░░░░ 0%  0/1 slices
 *   //
 *   //   Overall
 *   //     ██████████████░░░░░░ 67%  2/3 slices
 */
export function renderProgress(data: TraceData): string {
  const progress = computeProgress(data);
  const lines: string[] = [];

  lines.push(colors.bold('📊 Progress Overview'));
  lines.push('');

  if (progress.versions.length === 0) {
    lines.push('   No versions found.');
    return lines.join('\n');
  }

  for (const v of progress.versions) {
    lines.push(renderVersionLine(v));
    lines.push('');
  }

  // Overall summary — shown when there are multiple versions
  if (progress.versions.length > 1) {
    lines.push(colors.bold('   Overall'));
    lines.push(
      `     ${renderProgressBar(progress.overallPercentage)}  ${progress.overallCompleted}/${progress.overallTotal} slices`,
    );
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Render a per-slice state breakdown for each version.
 *
 * Shows each slice's ID, colored state badge, and title — useful alongside
 * the progress overview to see which specific slices remain.
 *
 * @param data - The trace data to render.
 * @returns A formatted multi-line string with per-slice state details.
 *
 * @example
 *   renderSliceBreakdown(data)
 *   // v1 slice states:
 *   //   v1-auth-login  [completed]  Login endpoint
 *   //   v1-auth-logout [completed]  Logout endpoint
 *   // v2 slice states:
 *   //   v2-auth-oauth  [draft]      OAuth integration
 */
export function renderSliceBreakdown(data: TraceData): string {
  const lines: string[] = [];

  for (const design of data.designs) {
    for (const plan of design.plans) {
      for (const v of plan.versions) {
        lines.push(`   ${colors.cyan(v.version)} slice states:`);
        for (const s of v.slices) {
          const colorFn = getStateColor(s.state);
          lines.push(
            `     ${s.id}  ${colorFn(`[${s.state}]`)}  ${s.title}  [module: ${s.module}]`,
          );
        }
      }
    }
  }

  return lines.join('\n');
}
