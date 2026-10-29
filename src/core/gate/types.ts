// Gate — gate② executor
// See docs/zelto-技术架构.md §6.1

export interface GateCommand {
  name: string;
  run: string;
  /** Per-command timeout in seconds. Falls back to GateConfig.timeoutSec if not set. */
  timeoutSec?: number;
}

export interface GateConfig {
  commands: GateCommand[];
  /** Named gate profiles keyed by slice type (code, docs, config, refactor) */
  profiles?: Record<string, GateCommand[]>;
  changedLineCoverage: number;
  timeoutSec: number;
  retry: {
    max: number;
    budgetStepUsd: number;
  };
}

/** Slice type classification for gate profile selection */
export type SliceType = 'code' | 'docs' | 'config' | 'refactor';

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

export interface GateReport {
  sliceId: string;
  passed: boolean;
  results: GateResult[];
  retryCount: number;
  totalDurationMs: number;
}
