// Gate — gate② executor
// See docs/zelto-技术架构.md §6.1

export interface GateCommand {
  name: string;
  run: string;
  /** Per-command timeout in seconds. Falls back to GateConfig.timeoutSec if not set. */
  timeoutSec?: number;
}

export interface GateAcceptanceConfig {
  /**
   * Command template for running the slice's own acceptance tests.
   *
   * The literal `{acceptance}` is replaced by the slice's acceptance path
   * (`slice.acceptance.dir`, resolved against the gate root). When the
   * template has no placeholder, the path is appended as a trailing argument.
   */
  command: string;
  /**
   * Whether the slice must have a runnable acceptance target.
   *
   * - `true` (default): a missing / empty acceptance target fails the gate.
   * - `false`: a missing target is reported as `skipped` instead.
   *
   * This governs *presence*, not outcome — a target that runs and fails
   * always fails the gate.
   */
  required?: boolean;
  /** Per-acceptance timeout in seconds. Falls back to GateConfig.timeoutSec. */
  timeoutSec?: number;
  /**
   * Compile-output directory, relative to the gate root.
   *
   * TypeScript sources cannot be executed by `node --test` directly, so the
   * gate looks for the compiled counterpart here first (ADR-033).
   * Defaults to `dist-test`.
   */
  buildDir?: string;
}

export interface GateConfig {
  commands: GateCommand[];
  /** Named gate profiles keyed by slice type (code, docs, config, refactor) */
  profiles?: Record<string, GateCommand[]>;
  /**
   * Optional slice-level acceptance gate.
   *
   * When absent, the gate only runs the project-wide `commands` and the
   * acceptance step is reported as `skipped` (explicitly, never silently).
   */
  acceptance?: GateAcceptanceConfig;
  timeoutSec: number;
  retry: {
    max: number;
    budgetStepUsd: number;
  };
}

import type { SliceType } from '../slice/kind.js';

/**
 * Slice type classification for gate profile selection.
 *
 * Re-exported for compatibility: the definition now lives in `core/slice/kind.ts`
 * because it classifies a **slice**, not a gate. Gate consumes it to pick the
 * profile; the vocabulary belongs to the slice domain.
 *
 * See docs/adr-031-slice-type-ownership.md.
 */
export type { SliceType };

/**
 * Auto-detect slice type from write-set paths.
 * - All .md files → docs
 * - Config files (.yaml, .json, .toml) → config
 * - Mixed or code files (.ts, .js, .cpp, .hpp, etc.) → code
 */
export function detectSliceType(writes: string[]): SliceType {
  if (writes.length === 0) return 'code';

  const allMd = writes.every((w) => w.endsWith('.md') || w.includes('docs/'));
  if (allMd) return 'docs';

  const allConfig = writes.every((w) =>
    /\.(yaml|yml|json|toml|ini|cfg)$/i.test(w) || w.includes('config'),
  );
  if (allConfig) return 'config';

  const allRefactor = writes.every((w) =>
    /\.(ts|js|tsx|jsx)$/.test(w) && !w.includes('test'),
  );
  if (allRefactor && writes.length <= 3) return 'refactor';

  return 'code';
}

export interface GateResult {
  command: string;
  passed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/**
 * Outcome of the slice-level acceptance step.
 *
 * `skipped` means "there was nothing to run" (no acceptance configured, or
 * the slice has no acceptance target and `required` is false). It is never
 * used for a run that was attempted and failed — that is `failed`.
 */
export interface AcceptanceOutcome {
  status: 'passed' | 'failed' | 'skipped';
  /** The acceptance target that was run (or would have been run). */
  path: string | null;
  /** The command as actually executed (after `{acceptance}` substitution). */
  command: string | null;
  /** Why the step was skipped / failed, when there is something to say. */
  reason?: string;
  /** The concrete test files that were executed (relative to the gate root). */
  files?: string[];
  exitCode?: number | null;
  durationMs?: number;
}

export interface GateReport {
  sliceId: string;
  passed: boolean;
  results: GateResult[];
  retryCount: number;
  totalDurationMs: number;
  /** Result of the slice-level acceptance step, when one was configured. */
  acceptance?: AcceptanceOutcome;
}
