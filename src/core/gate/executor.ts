// Gate executor — runs configured commands and records results
// See docs/zelto-技术架构.md §6.1
// C3: deterministic only — no model calls, no network

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GateConfig, GateCommand, GateResult, GateReport } from './types.js';
import type { SliceData, SliceStore } from '../slice/store.js';
import type { EventStream, EventType } from '../events/stream.js';

function runCommand(cmd: GateCommand, timeoutSec: number, cwd: string): Promise<GateResult> {
  return new Promise((resolvePromise) => {
    const start = performance.now();
    // Use shell: true with the full command as a single string
    // to avoid the deprecation warning about args with shell
    const ac = new AbortController();
    const child = spawn(cmd.run || cmd.name, [], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      signal: ac.signal,
    });

    const timer = setTimeout(() => {
      ac.abort();
      child.kill();
    }, timeoutSec * 1000);

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      const durationMs = performance.now() - start;
      resolvePromise({
        command: cmd.name,
        passed: exitCode === 0,
        exitCode,
        stdout,
        stderr,
        durationMs,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      const durationMs = performance.now() - start;
      resolvePromise({
        command: cmd.name,
        passed: false,
        exitCode: null,
        stdout,
        stderr: err.message,
        durationMs,
      });
    });
  });
}

export class GateExecutor {
  private readonly store: SliceStore;
  private readonly events: EventStream;
  private readonly config: GateConfig;
  private readonly projectRoot: string;

  constructor(
    store: SliceStore,
    events: EventStream,
    config: GateConfig,
    projectRoot: string = process.cwd(),
  ) {
    this.store = store;
    this.events = events;
    this.config = config;
    this.projectRoot = projectRoot;
  }

  async execute(sliceId: string, actor: string = 'zelto'): Promise<GateReport> {
    const slice = await this.store.read(sliceId);
    const totalStart = performance.now();
    const results: GateResult[] = [];
    let passed = true;
    let totalRetries = 0;

    // Check for uninitialized git submodules before running commands
    const submoduleIssue = await this.checkSubmodules();
    if (submoduleIssue) {
      // Log as gate failure with a synthetic result
      results.push({
        command: 'submodule-check',
        passed: false,
        exitCode: 1,
        stdout: '',
        stderr: submoduleIssue,
        durationMs: 0,
      });
      passed = false;

      await this.appendEvent(sliceId, 'gate.result', actor, {
        sliceId,
        passed: false,
        results: [{ command: 'submodule-check', passed: false, exitCode: 1, stderr: submoduleIssue }],
        retryCount: 0,
        totalDurationMs: 0,
      });

      return {
        sliceId,
        passed: false,
        results,
        retryCount: 0,
        totalDurationMs: 0,
      };
    }

    await this.appendEvent(sliceId, 'gate.executed', actor, {
      sliceId,
      commandCount: this.config.commands.length,
    });

    for (const cmd of this.config.commands) {
      const { result, retries } = await this.runWithRetry(cmd, slice, actor);
      results.push(result);
      totalRetries += retries;
      if (!result.passed) {
        passed = false;
      }
    }

    const totalDurationMs = performance.now() - totalStart;

    await this.appendEvent(sliceId, 'gate.result', actor, {
      sliceId,
      passed,
      results: results.map((r) => ({
        command: r.command,
        passed: r.passed,
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        stderr: r.stderr ? r.stderr.slice(0, 2000) : null, // Include stderr (truncated) for failure detail
        stdout: r.stdout ? r.stdout.slice(0, 500) : null,   // Include stdout head for context
      })),
      retryCount: totalRetries,
      totalDurationMs,
    });

    return {
      sliceId,
      passed,
      results,
      retryCount: totalRetries,
      totalDurationMs,
    };
  }

  private async runWithRetry(
    cmd: GateCommand,
    slice: SliceData,
    actor: string,
  ): Promise<{ result: GateResult; retries: number }> {
    const timeoutSec = cmd.timeoutSec ?? this.config.timeoutSec;
    let result = await runCommand(cmd, timeoutSec, this.projectRoot);
    let attempts = 0;

    while (!result.passed && attempts < this.config.retry.max) {
      attempts++;
      await this.appendEvent(slice.id, 'gate.retry', actor, {
        command: cmd.name,
        attempt: attempts,
        maxRetries: this.config.retry.max,
        previousExitCode: result.exitCode,
        timeoutSec,
      });

      // Re-read slice before writing to avoid overwriting concurrent modifications
      try {
        const fresh = await this.store.read(slice.id);
        fresh.stall.gateRetries++;
        fresh.stall.class = 'gate_retry';
        await this.store.write(fresh);
      } catch {
        // Fallback to stale slice if read fails
        slice.stall.gateRetries++;
        slice.stall.class = 'gate_retry';
        await this.store.write(slice);
      }

      result = await runCommand(cmd, timeoutSec, this.projectRoot);
    }

    return { result, retries: attempts };
  }

  private async appendEvent(
    sliceId: string,
    type: EventType,
    actor: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.events.append(sliceId, type, actor, payload);
    } catch {
      // Event stream failure is non-fatal for gate execution
    }
  }

  /**
   * Check for uninitialized git submodules that could cause build failures.
   * Returns null if OK, or an error message string if issues are found.
   * Skips check if .gitmodules doesn't exist.
   */
  private async checkSubmodules(): Promise<string | null> {
    const gitmodulesPath = join(this.projectRoot, '.gitmodules');
    if (!existsSync(gitmodulesPath)) return null; // No submodules configured

    try {
      // Read .gitmodules to find expected submodule paths
      const content = await readFile(gitmodulesPath, 'utf-8');
      const submodulePaths: string[] = [];
      for (const line of content.split('\n')) {
        const match = line.match(/^\s*path\s*=\s*(.+)$/);
        if (match) {
          submodulePaths.push(match[1].trim());
        }
      }

      if (submodulePaths.length === 0) return null;

      // Check each submodule path exists and is non-empty
      const missingPaths: string[] = [];
      const emptyPaths: string[] = [];

      for (const subPath of submodulePaths) {
        const fullPath = join(this.projectRoot, subPath);
        if (!existsSync(fullPath)) {
          missingPaths.push(subPath);
          continue;
        }
        // Check if directory is empty (submodule not initialized)
        const entries = readdirSync(fullPath);
        if (entries.length === 0) {
          emptyPaths.push(subPath);
        }
      }

      if (missingPaths.length > 0 || emptyPaths.length > 0) {
        const parts: string[] = [];
        if (missingPaths.length > 0) parts.push(`missing: ${missingPaths.join(', ')}`);
        if (emptyPaths.length > 0) parts.push(`empty: ${emptyPaths.join(', ')}`);
        return `Uninitialized git submodules found (${parts.join('; ')}). Run "git submodule update --init --recursive" first.`;
      }

      return null;
    } catch {
      return null; // Non-fatal: skip check if we can't read .gitmodules
    }
  }
}
