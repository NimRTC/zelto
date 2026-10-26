// Status badge rendering module for the trace command
// Provides colored badge strings for slice states, status values, and status icons.
// Built on the color utilities from ../../color.js with project-wide state mappings.

import { colors } from '../../color.js';

// ─── State Color Map ───────────────────────────────────────────────────────
// Maps each known slice state (from core/slice/state.ts) to a color function.

const STATE_COLORS: Record<string, (s: string) => string> = {
  draft: colors.yellow,
  clarifying: colors.blue,
  frozen: colors.magenta,
  running: colors.cyan,
  completed: colors.green,
  abandoned: colors.gray,
};

// ─── Status Color Map ─────────────────────────────────────────────────────
// Maps each known status value (used across requirements, designs, plans)
// to a color function.

const STATUS_COLORS: Record<string, (s: string) => string> = {
  draft: colors.yellow,
  confirmed: colors.green,
  superseded: colors.gray,
  planned: colors.blue,
  in_progress: colors.cyan,
  integrated: colors.magenta,
  delivered: colors.green,
};

// ─── Status Icon Map ──────────────────────────────────────────────────────
// Maps each known status to a Unicode icon/emoji.

const STATUS_ICONS: Record<string, string> = {
  draft: '📝',
  confirmed: '✅',
  superseded: '🔄',
  planned: '📋',
  in_progress: '🔄',
  integrated: '🔗',
  delivered: '🚀',
};

// ─── Public Helpers ───────────────────────────────────────────────────────

/**
 * Get the color function for a given slice state.
 * Falls back to `colors.dim` for unknown states.
 */
export function getStateColor(state: string): (s: string) => string {
  return STATE_COLORS[state] ?? colors.dim;
}

/**
 * Get the color function for a given status value.
 * Falls back to `colors.dim` for unknown statuses.
 */
export function getStatusColor(status: string): (s: string) => string {
  return STATUS_COLORS[status] ?? colors.dim;
}

/**
 * Get the status icon for a given status value.
 * Falls back to `'○'` for unknown statuses.
 */
export function getStatusIcon(status: string): string {
  return STATUS_ICONS[status] ?? '○';
}

// ─── Badge Rendering ──────────────────────────────────────────────────────

/**
 * Render a state badge — the state string in its designated color.
 *
 * @example
 *   renderStateBadge('completed') // returns green "completed"
 *   renderStateBadge('draft')     // returns yellow "draft"
 */
export function renderStateBadge(state: string): string {
  const fn = getStateColor(state);
  return fn(state);
}

/**
 * Render a status badge — icon + colored status string.
 *
 * @example
 *   renderStatusBadge('confirmed') // returns "✅ confirmed" (green)
 *   renderStatusBadge('draft')     // returns "📝 draft" (yellow)
 */
export function renderStatusBadge(status: string): string {
  const icon = getStatusIcon(status);
  const fn = getStatusColor(status);
  return `${icon} ${fn(status)}`;
}

/**
 * Render a bracketed state badge — `[state]` in the state's color.
 *
 * @example
 *   renderBracketedBadge('completed') // returns "[completed]" in green
 *   renderBracketedBadge('draft')     // returns "[draft]" in yellow
 */
export function renderBracketedBadge(state: string): string {
  const fn = getStateColor(state);
  return fn(`[${state}]`);
}
