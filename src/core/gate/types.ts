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
  changedLineCoverage: number;
  timeoutSec: number;
  retry: {
    max: number;
    budgetStepUsd: number;
  };
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
