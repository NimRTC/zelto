/**
 * diff-highlight.ts — `zelto diff-highlight` command
 *
 * Reads a unified diff from stdin and outputs an ANSI-color-highlighted version:
 * - Green background for additions
 * - Red background for deletions
 * - Bold yellow for diff header lines
 * - Cyan for hunk headers (@@)
 *
 * C6: cli/ depends on shared utilities from shared.ts
 * No external dependencies beyond Node built-ins.
 *
 * NOTE: Uses raw ANSI escape codes directly rather than the colors utility
 * from color.ts, because diff-highlight is a pipe-friendly command that must
 * always emit ANSI codes even when stdout is not a TTY (e.g. piped to `less -R`).
 */

import { register } from './shared.js';

// ─── Raw ANSI helpers (always emit, bypass TTY detection) ─────────────────────

const RESET = '\x1b[0m';
const BG_GREEN = '\x1b[42m';
const BG_RED = '\x1b[41m';
const BOLD_YELLOW = '\x1b[1;33m';
const CYAN = '\x1b[36m';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Classification of a single diff line */
type DiffLineKind = 'header' | 'addition' | 'deletion' | 'hunk' | 'context';

/**
 * Classify a single line of unified diff and apply ANSI color codes.
 * Always emits codes (no TTY guard) since this command is meant for piping.
 */
function highlightLine(line: string): string {
  // Header lines
  if (
    line.startsWith('diff --git') ||
    line.startsWith('---') ||
    line.startsWith('+++') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file') ||
    line.startsWith('index ')
  ) {
    return `${BOLD_YELLOW}${line}${RESET}`;
  }

  if (line.startsWith('@@')) {
    return `${CYAN}${line}${RESET}`;
  }

  if (line.startsWith('+')) {
    return `${BG_GREEN}${line}${RESET}`;
  }

  if (line.startsWith('-')) {
    return `${BG_RED}${line}${RESET}`;
  }

  // Context: no highlighting
  return line;
}

/**
 * Pure function: take raw unified-diff text, return ANSI-highlighted text.
 *
 * This follows the same design approach as core/output-formatter.ts:
 * a pure function with no side effects, no external dependencies.
 */
export function highlightDiff(diffText: string): string {
  return diffText.split('\n').map(highlightLine).join('\n');
}

// ─── Command Registration ─────────────────────────────────────────────────────

register('diff-highlight', async () => {
  // Read all of stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  const input = Buffer.concat(chunks).toString('utf-8');

  if (!input.trim()) {
    process.stderr.write('No input provided. Pipe a unified diff to stdin.\n');
    return 1;
  }

  const output = highlightDiff(input);
  process.stdout.write(output + '\n');
  return 0;
});
