// CLI output module — structured formatting for commands
// Builds on color.ts to provide table, list, result, and JSON-mode output.

import { colors, formatSection, formatKeyValue, formatError, formatSuccess, formatWarning } from './color.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface OutputOptions {
  json?: boolean;
  indent?: number;
}

// ─── Output Mode ────────────────────────────────────────────────────────────

/** Whether JSON mode is active (--json flag or explicit option). */
let _jsonMode = false;

export function setJsonMode(enabled: boolean): void {
  _jsonMode = enabled;
}

export function isJsonMode(): boolean {
  return _jsonMode;
}

// ─── Main Output Dispatcher ────────────────────────────────────────────────

/**
 * Write output in either JSON or human-readable format.
 * In JSON mode, data is serialized; in text mode, the textFn is called.
 */
export function writeOutput(
  data: unknown,
  textFn?: () => string,
  opts?: OutputOptions,
): void {
  const json = opts?.json ?? _jsonMode;
  if (json) {
    console.log(JSON.stringify(data, null, opts?.indent ?? 2));
  } else if (textFn) {
    console.log(textFn());
  }
}

// ─── Table ──────────────────────────────────────────────────────────────────

export interface TableColumn {
  key: string;
  label: string;
  align?: 'left' | 'right';
  width?: number;
}

/**
 * Format rows as a text table with aligned columns.
 * Auto-sizes columns based on header label + content width.
 */
export function formatTable(headers: TableColumn[], rows: Record<string, string>[]): string {
  if (rows.length === 0) return '';

  // Compute column widths
  const widths = headers.map((h) => {
    const headerLen = h.label.length;
    const maxContent = rows.reduce((max, row) => {
      const val = row[h.key] ?? '';
      return Math.max(max, val.length);
    }, 0);
    return Math.max(headerLen, maxContent, h.width ?? 0);
  });

  // Build header line
  const headerLine = headers
    .map((h, i) => {
      const w = widths[i];
      if (h.align === 'right') {
        return colors.bold(h.label.padStart(w));
      }
      return colors.bold(h.label.padEnd(w));
    })
    .join('  ');

  // Build separator
  const sep = widths.map((w) => '─'.repeat(w)).join('──');

  // Build data lines
  const dataLines = rows.map((row) =>
    headers
      .map((h, i) => {
        const val = row[h.key] ?? '';
        const w = widths[i];
        if (h.align === 'right') {
          return val.padStart(w);
        }
        return val.padEnd(w);
      })
      .join('  '),
  );

  return [headerLine, sep, ...dataLines].join('\n');
}

/**
 * Print a formatted table.
 */
export function printTable(headers: TableColumn[], rows: Record<string, string>[]): void {
  const text = formatTable(headers, rows);
  if (text) console.log(text);
}

// ─── Divider ────────────────────────────────────────────────────────────────

/** Print a horizontal divider line. */
export function printDivider(char = '─', width = 48): void {
  console.log(colors.dim(char.repeat(width)));
}

// ─── List ───────────────────────────────────────────────────────────────────

export interface ListItem {
  label: string;
  value?: string;
  state?: string;
}

/**
 * Format a list of items with optional values and state badges.
 */
export function formatList(items: ListItem[], indent = 2): string {
  const pad = ' '.repeat(indent);
  return items
    .map((item) => {
      const parts: string[] = [`${pad}• ${item.label}`];
      if (item.state) {
        const stateFn = item.state === 'ok' || item.state === 'completed' || item.state === 'done'
          ? colors.green
          : item.state === 'error' || item.state === 'fail'
            ? colors.red
            : item.state === 'warn' || item.state === 'pending'
              ? colors.yellow
              : colors.dim;
        parts.push(` ${stateFn(`[${item.state}]`)}`);
      }
      if (item.value) {
        parts.push(` ${colors.dim(item.value)}`);
      }
      return parts.join('');
    })
    .join('\n');
}

/**
 * Print a formatted list.
 */
export function printList(items: ListItem[], indent?: number): void {
  console.log(formatList(items, indent));
}

// ─── Result Output ──────────────────────────────────────────────────────────

export interface ResultOutput {
  ok: boolean;
  label: string;
  detail?: string;
  items?: Array<{ label: string; ok: boolean; detail?: string }>;
}

/**
 * Print a structured result (success/error with optional detail and sub-items).
 * In JSON mode, outputs the ResultOutput object.
 */
export function printResult(result: ResultOutput, opts?: OutputOptions): void {
  const json = opts?.json ?? _jsonMode;
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.ok) {
    console.log(formatSuccess(result.label));
  } else {
    console.log(formatError(new Error(result.label)));
  }

  if (result.detail) {
    console.log(`  ${colors.dim(result.detail)}`);
  }

  if (result.items && result.items.length > 0) {
    for (const item of result.items) {
      const bullet = item.ok ? '✅' : '❌';
      const line = `  ${bullet} ${item.label}`;
      console.log(line);
      if (item.detail) {
        console.log(`    ${colors.dim(item.detail)}`);
      }
    }
  }
}

// ─── Section Output ─────────────────────────────────────────────────────────

/**
 * Print a titled section with a list of key-value pairs.
 */
export function printSection(title: string, kvps: Record<string, string>, opts?: OutputOptions): void {
  const json = opts?.json ?? _jsonMode;
  if (json) {
    console.log(JSON.stringify({ [title]: kvps }, null, 2));
    return;
  }

  console.log(formatSection(title));
  for (const [key, value] of Object.entries(kvps)) {
    console.log(formatKeyValue(key, value));
  }
}

// ─── Progress / Spinner ─────────────────────────────────────────────────────

let _spinnerTimer: ReturnType<typeof setInterval> | null = null;
let _spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let _spinnerIdx = 0;
let _spinnerMessage = '';

/**
 * Start a simple spinner with a message (TTY only).
 */
export function startSpinner(message: string): void {
  if (!process.stdout.isTTY) {
    console.log(`${colors.dim('...')} ${message}`);
    return;
  }

  _spinnerMessage = message;
  _spinnerIdx = 0;
  if (_spinnerTimer) clearInterval(_spinnerTimer);
  _spinnerTimer = setInterval(() => {
    const frame = _spinnerFrames[_spinnerIdx % _spinnerFrames.length];
    process.stdout.write(`\r${colors.cyan(frame)} ${_spinnerMessage}`);
    _spinnerIdx++;
  }, 80);
}

/**
 * Stop the spinner and print a final message.
 */
export function stopSpinner(message?: string): void {
  if (_spinnerTimer) {
    clearInterval(_spinnerTimer);
    _spinnerTimer = null;
  }
  if (process.stdout.isTTY) {
    process.stdout.write('\r\x1b[K');
  }
  if (message) {
    console.log(message);
  }
}

// ─── Help / Usage ───────────────────────────────────────────────────────────

/**
 * Print a usage line for a command.
 */
export function printUsage(usage: string): void {
  console.log(`\n${colors.cyan('Usage:')}`);
  console.log(`  ${usage}\n`);
}

/**
 * Print a command group section in help output.
 */
export function printCommandGroup(title: string, commands: Array<{ cmd: string; desc: string }>): void {
  console.log(`\n${colors.bold(title)}`);
  const maxCmdLen = Math.max(...commands.map((c) => c.cmd.length));
  for (const { cmd, desc } of commands) {
    console.log(`  ${colors.cyan(cmd.padEnd(maxCmdLen + 2))}${desc}`);
  }
}

// ─── Error Output ───────────────────────────────────────────────────────────

/**
 * Print an error message and return an exit code.
 */
export function fail(message: string, exitCode = 1): number {
  console.error(formatWarning(message));
  return exitCode;
}

// ─── Re-export common formatters from color.ts for convenience ─────────────

export { colors, formatSection, formatKeyValue, formatError, formatSuccess, formatWarning };
