// Color utilities for CLI output

const IS_TTY = process.stdout.isTTY;

function color(code: number, text: string): string {
  return IS_TTY ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export const colors = {
  red: (s: string) => color(31, s),
  green: (s: string) => color(32, s),
  yellow: (s: string) => color(33, s),
  blue: (s: string) => color(34, s),
  magenta: (s: string) => color(35, s),
  cyan: (s: string) => color(36, s),
  gray: (s: string) => color(90, s),
  bold: (s: string) => color(1, s),
  dim: (s: string) => color(2, s),
  ok: (s: string) => color(32, `✅ ${s}`),
  fail: (s: string) => color(31, `❌ ${s}`),
  warn: (s: string) => color(33, `⚠️  ${s}`),
  info: (s: string) => color(36, `ℹ️  ${s}`),
};

export function formatError(err: Error): string {
  const msg = err.message ?? String(err);
  return colors.red(`Error: ${msg}`);
}

export function formatSuccess(msg: string): string {
  return colors.ok(msg);
}

export function formatWarning(msg: string): string {
  return colors.warn(msg);
}

export function formatSection(title: string): string {
  return `\n  ${colors.bold(colors.cyan(title))}`;
}

export function formatKeyValue(key: string, value: string): string {
  return `  ${colors.dim(key)}: ${value}`;
}
