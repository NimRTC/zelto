/**
 * output-formatter.ts — v2 Unified CLI OutputFormatter
 *
 * 把 CLI 的输出从分散的 console.log 调用集中到统一的 OutputFormatter 类。
 * 支持终端、JSON、YAML 三种模式，每条输出都经过 schema 校验。
 *
 * C6: This lives in cli/ and depends on core/ schemas for validation.
 */

import { validateWithSchema, SchemaValidationError } from './validate-schema.js';
import { colors } from './color.js';

// ─── Output Format Enum ──────────────────────────────────────────────────────

export enum OutputFormat {
  Terminal = 'terminal',
  JSON = 'json',
  YAML = 'yaml',
}

// ─── Options ─────────────────────────────────────────────────────────────────

export interface OutOptions {
  /** Send to stderr instead of stdout (terminal mode only) */
  stderr?: boolean;
  /** Include ISO timestamp */
  timestamp?: boolean;
}

export interface DataOptions {
  /** Schema name to validate against (default: "output-data") */
  schema?: string;
  /** Optional total count for paginated data */
  total?: number;
  /** Optional showing count */
  showing?: number;
}

export interface SuccessOptions {
  /** Optional data payload */
  data?: unknown;
}

// ─── YAML Serializer (lazy, loaded via initFormatter) ────────────────────────

let _yamlStringify: ((data: unknown) => string) | null = null;

/**
 * Initialize the formatter module — pre-load the YAML serializer.
 * Must be called once before any YAML output (typically at CLI startup).
 */
export async function initFormatter(): Promise<void> {
  if (_yamlStringify) return;
  try {
    const yaml = await import('js-yaml');
    _yamlStringify = (data: unknown) => yaml.dump(data, { indent: 2, noRefs: true, sortKeys: false });
  } catch {
    // Fallback: use JSON as YAML approximation
    _yamlStringify = (data: unknown) => JSON.stringify(data, null, 2);
  }
}

function getYamlStringifySync(): (data: unknown) => string {
  if (!_yamlStringify) {
    // Not initialized yet — use JSON fallback
    return (data: unknown) => JSON.stringify(data, null, 2);
  }
  return _yamlStringify;
}

// ─── Pipe Detection ──────────────────────────────────────────────────────────

/**
 * Detect if stdout is connected to a pipe (not a TTY).
 */
export function isPiped(): boolean {
  return !process.stdout.isTTY;
}

// ─── OutputFormatter Class ───────────────────────────────────────────────────

export class OutputFormatter {
  private format: OutputFormat;
  private readonly _autoJsonFromPipe: boolean;

  constructor(format: OutputFormat = OutputFormat.Terminal) {
    this.format = format;
    this._autoJsonFromPipe = true;
  }

  // ─── Format Accessors ────────────────────────────────────────────────────

  getFormat(): OutputFormat {
    return this.format;
  }

  setFormat(format: OutputFormat): void {
    this.format = format;
  }

  /**
   * Resolve the effective output format, considering pipe detection.
   */
  private resolveFormat(): OutputFormat {
    if (this._autoJsonFromPipe && isPiped() && this.format === OutputFormat.Terminal) {
      return OutputFormat.JSON;
    }
    return this.format;
  }

  // ─── out() ───────────────────────────────────────────────────────────────

  out(message: string, options?: OutOptions): void {
    const fmt = this.resolveFormat();

    if (fmt === OutputFormat.Terminal) {
      const ts = options?.timestamp ? `[${new Date().toISOString()}] ` : '';
      const output = `${ts}${message}\n`;
      if (options?.stderr) {
        process.stderr.write(output);
      } else {
        process.stdout.write(output);
      }
      return;
    }

    // JSON / YAML
    const data: Record<string, unknown> = { message };
    if (options?.timestamp) {
      data.timestamp = new Date().toISOString();
    }

    const errors = validateWithSchema('output-message', data);
    if (errors.length > 0) {
      throw new SchemaValidationError('output-message', errors);
    }

    this.writeStructured(data);
  }

  // ─── data() ──────────────────────────────────────────────────────────────

  data(data: unknown, options?: DataOptions): void {
    const fmt = this.resolveFormat();

    if (fmt === OutputFormat.Terminal) {
      this.writeTerminalData(data);
      return;
    }

    // JSON / YAML: wrap in structured envelope
    const payload: Record<string, unknown> = { data };

    if (options?.total !== undefined) payload.total = options.total;
    if (options?.showing !== undefined) payload.showing = options.showing;

    const schemaName = options?.schema ?? 'output-data';
    const errors = validateWithSchema(schemaName, payload);
    if (errors.length > 0) {
      throw new SchemaValidationError(schemaName, errors);
    }

    this.writeStructured(payload);
  }

  // ─── error() ─────────────────────────────────────────────────────────────

  error(code: string, message: string, extra?: Record<string, unknown>): void {
    const fmt = this.resolveFormat();

    if (fmt === OutputFormat.Terminal) {
      const extraStr = extra && Object.keys(extra).length > 0
        ? ` ${JSON.stringify(extra)}`
        : '';
      process.stderr.write(`${colors.red(`✘ Error: ${message}`)}${extraStr}\n`);
      return;
    }

    // JSON / YAML
    const data: Record<string, unknown> = { error: { code, message, ...extra } };

    const errors = validateWithSchema('output-error', data);
    if (errors.length > 0) {
      // Fallback to plain error object
      this.writeStructured({ error: { code, message, ...extra } });
      return;
    }

    this.writeStructured(data);
  }

  // ─── success() ───────────────────────────────────────────────────────────

  success(message: string, options?: SuccessOptions): void {
    const fmt = this.resolveFormat();

    if (fmt === OutputFormat.Terminal) {
      process.stdout.write(`${colors.green(`✔ ${message}`)}\n`);
      if (options?.data !== undefined) {
        this.data(options.data);
      }
      return;
    }

    // JSON / YAML
    const data: Record<string, unknown> = { success: true, message };
    if (options?.data !== undefined) {
      data.data = options.data;
    }

    const errors = validateWithSchema('output-success', data);
    if (errors.length > 0) {
      throw new SchemaValidationError('output-success', errors);
    }

    this.writeStructured(data);
  }

  // ─── warn() ──────────────────────────────────────────────────────────────

  warn(message: string, extra?: Record<string, unknown>): void {
    const fmt = this.resolveFormat();

    if (fmt === OutputFormat.Terminal) {
      const extraStr = extra && Object.keys(extra).length > 0
        ? ` ${JSON.stringify(extra)}`
        : '';
      process.stdout.write(`${colors.yellow(`⚠ ${message}`)}${extraStr}\n`);
      return;
    }

    // JSON / YAML
    const data: Record<string, unknown> = { warning: message, ...extra };

    const errors = validateWithSchema('output-warning', data);
    if (errors.length > 0) {
      this.writeStructured({ warning: message, ...extra });
      return;
    }

    this.writeStructured(data);
  }

  // ─── Structured Write (JSON / YAML) ─────────────────────────────────────

  private writeStructured(data: unknown): void {
    const fmt = this.resolveFormat();

    if (fmt === OutputFormat.JSON) {
      process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    } else if (fmt === OutputFormat.YAML) {
      const stringify = getYamlStringifySync();
      process.stdout.write(`${stringify(data)}\n`);
    }
  }

  // ─── Terminal Data Formatting ───────────────────────────────────────────

  private writeTerminalData(data: unknown): void {
    if (data === null || data === undefined) {
      process.stdout.write('(empty)\n');
      return;
    }

    if (Array.isArray(data)) {
      if (data.length === 0) {
        process.stdout.write('(empty)\n');
        return;
      }

      for (let i = 0; i < data.length; i++) {
        const item = data[i];
        if (typeof item === 'object' && item !== null) {
          const obj = item as Record<string, unknown>;
          const keys = Object.keys(obj);
          if (keys.length <= 4) {
            const parts = keys.map((k) => `${colors.dim(k)}: ${formatValue(obj[k])}`);
            process.stdout.write(`  ${i + 1}. ${parts.join(', ')}\n`);
          } else {
            process.stdout.write(`  ${i + 1}. ${keys.map((k) => `${k}: ${formatValue(obj[k])}`).join(' | ')}\n`);
          }
        } else {
          process.stdout.write(`  ${i + 1}. ${formatValue(item)}\n`);
        }
      }
    } else if (typeof data === 'object' && data !== null) {
      const obj = data as Record<string, unknown>;
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          process.stdout.write(`  ${colors.bold(key)}:\n`);
          for (const [sk, sv] of Object.entries(value as Record<string, unknown>)) {
            process.stdout.write(`    ${colors.dim(sk)}: ${formatValue(sv)}\n`);
          }
        } else if (Array.isArray(value)) {
          process.stdout.write(`  ${colors.bold(key)}: [${value.map(formatValue).join(', ')}]\n`);
        } else {
          process.stdout.write(`  ${colors.dim(key)}: ${formatValue(value)}\n`);
        }
      }
    } else {
      process.stdout.write(`${formatValue(data)}\n`);
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return colors.dim('(none)');
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(formatValue).join(', ')}]`;
  return JSON.stringify(value);
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let _defaultFormatter: OutputFormatter | null = null;

/**
 * Get or create the default OutputFormatter instance.
 */
export function getDefaultFormatter(): OutputFormatter {
  if (!_defaultFormatter) {
    _defaultFormatter = new OutputFormatter();
  }
  return _defaultFormatter;
}

/**
 * Set the default OutputFormatter instance (e.g., from CLI initialization).
 */
export function setDefaultFormatter(formatter: OutputFormatter): void {
  _defaultFormatter = formatter;
}
