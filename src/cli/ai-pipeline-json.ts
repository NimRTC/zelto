/**
 * ai-pipeline-json.ts — AI pipeline JSON output formatter
 *
 * Provides shared utilities for AI pipeline commands to output
 * structured JSON with { status, message, data } format.
 *
 * C6: This lives in cli/ and is independent of core/.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type JsonStatus = 'ok' | 'validation_error' | 'error';

export interface AiPipelineJsonOutput {
  status: JsonStatus;
  message: string;
  data: unknown;
}

// ─── Require data payload ────────────────────────────────────────────────────

export interface RequireData {
  type: 'require';
  sliceId: string;
  summary: string;
  inputs: string[];
  outputs: string[];
  policies: string[];
}

// ─── Design data payload ─────────────────────────────────────────────────────

export interface DesignFileEntry {
  path: string;
  summary: string;
  actions: Array<'CREATE' | 'MODIFY'>;
}

export interface DesignTestEntry {
  path: string;
  summary: string;
}

export interface DesignData {
  type: 'design';
  sliceId: string;
  summary: string;
  files: DesignFileEntry[];
  tests: DesignTestEntry[];
  promptCount: number;
}

// ─── Plan data payload ───────────────────────────────────────────────────────

export interface PlanCommandEntry {
  prompt: string;
  command: string;
  explanation: string;
}

export interface PlanData {
  type: 'plan';
  sliceId: string;
  summary: string;
  promptCount: number;
  commands: PlanCommandEntry[];
}

// ─── Version data payload ────────────────────────────────────────────────────

export interface VersionPromptEntry {
  version: string;
  prompt: string;
}

export interface VersionData {
  type: 'version';
  sliceId: string;
  version: string;
  summary: string;
  prompts: VersionPromptEntry[];
}

// ─── Output formatting ───────────────────────────────────────────────────────

/**
 * Format an AI pipeline JSON output object.
 *
 * @param status - One of 'ok', 'validation_error', 'error'
 * @param message - Human-readable summary
 * @param data - Command-specific payload (or null for errors)
 * @param pretty - Whether to pretty-print (multi-line) the JSON
 * @returns The JSON string
 */
export function formatAiPipelineJson(
  status: JsonStatus,
  message: string,
  data: unknown,
  pretty: boolean = false,
): string {
  const output: AiPipelineJsonOutput = { status, message, data };
  const space = pretty ? 2 : undefined;
  return JSON.stringify(output, null, space);
}

/**
 * Strip --json and --pretty flags from an args array.
 * Returns the filtered args and the flags found.
 */
export function stripJsonFlags(
  args: string[],
): { cleanArgs: string[]; jsonMode: boolean; pretty: boolean } {
  let jsonMode = false;
  let pretty = false;
  const cleanArgs = args.filter((a) => {
    if (a === '--json') {
      jsonMode = true;
      return false;
    }
    if (a === '--pretty') {
      pretty = true;
      return false;
    }
    return true;
  });
  return { cleanArgs, jsonMode, pretty };
}
