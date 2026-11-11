// Gate executor — runs configured commands and records results
// See docs/zelto-技术架构.md §6.1
// C3: deterministic only — no model calls, no network

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GateConfig, GateCommand, GateResult, GateReport, SliceType, AcceptanceOutcome } from './types.js';
import { detectSliceType } from './types.js';
import {
  DEFAULT_ACCEPTANCE_BUILD_DIR,
  DEFAULT_ACCEPTANCE_COMMAND,
  buildAcceptanceCommand,
  missingTargetOutcome,
  parseTestRunnerStats,
  resolveAcceptance,
  verifyAcceptanceRanTests,
} from './acceptance.js';
import type { SliceData, SliceStore } from '../slice/store.js';
import type { EventStream, EventType } from '../events/stream.js';

/**
 * 跑一条命令。
 *
 * `stripTestContext` 用来防止「假绿」：当这段代码自己跑在 `node --test`
 * 里面时，`NODE_TEST_CONTEXT=child-v8` 会被子进程继承。子进程看到它就认为
 * 「我已经是测试子进程了」，于是**跳过所有用例直接 exit 0** ——
 * 门禁于是把「一个测试都没跑」当成「测试全过」（ADR-033）。
 *
 * 验收命令必须真跑，所以这个变量要摘掉。
 */
function runCommand(
  cmd: GateCommand,
  timeoutSec: number,
  cwd: string,
  options: { stripTestContext?: boolean } = {},
): Promise<GateResult> {
  return new Promise((resolvePromise) => {
    const start = performance.now();
    // Use shell: true with the full command as a single string
    // to avoid the deprecation warning about args with shell
    const ac = new AbortController();
    const env = { ...process.env };
    if (options.stripTestContext) {
      delete env.NODE_TEST_CONTEXT;
    }
    const child = spawn(cmd.run || cmd.name, [], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      signal: ac.signal,
      env,
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

    // Select gate commands based on slice type
    const sliceType: SliceType = slice.type ?? detectSliceType(slice.writes);
    // 本片专属命令优先（ADR-051）：不同模块的测试目标名不同，
    // 项目级命令去构建别的模块的目标，既不验本片产物又白等一次构建。
    const sliceCommands = slice.spec?.gateCommands;
    const commands = sliceCommands && sliceCommands.length > 0
      ? sliceCommands
      : this.selectCommands(sliceType);

    // Log profile selection
    await this.appendEvent(sliceId, 'gate.executed', actor, {
      sliceId,
      sliceType,
      commandCount: commands.length,
      profile: sliceCommands && sliceCommands.length > 0
        ? 'slice-specific'
        : commands === this.config.commands ? 'default' : sliceType,
    });

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

    for (const cmd of commands) {
      const { result, retries } = await this.runWithRetry(cmd, slice, actor);
      results.push(result);
      totalRetries += retries;
      if (!result.passed) {
        passed = false;
      }
    }

    // ── 切片级验收（ADR-033）────────────────────────────────────────
    // 这一步回答的是「这片东西自己有没有被验证过」，与全项目命令是两件事。
    // 没配 gate.acceptance 时显式记为 skipped（不是静默跳过）。
    // 配了之后 fail closed：跑不起来就是 failed，不是 skipped
    // （除非显式声明 required:false）。
    const acceptance = await this.runAcceptance(slice, actor);
    if (acceptance.status === 'failed') {
      passed = false;
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
      acceptance,
    });

    return {
      sliceId,
      passed,
      results,
      retryCount: totalRetries,
      totalDurationMs,
      acceptance,
    };
  }

  /**
   * 跑本片的验收测试（ADR-033）。
   *
   * 判定完全确定：只看「目标找没找到」「命令跑没跑成功」，不看内容语义。
   *
   * 三种结论：
   * - `skipped`：没配 `gate.acceptance`（人还没决定要用切片级验收），
   *   或者配了但声明 `required: false` 且本片没有验收目标；
   * - `failed`：配了验收但没有验收目标、命令跑不起来、命令跑了但失败；
   * - `passed`：命令跑成功。
   *
   * 「没配」不等于「没问题」—— 所以它会被显式记下来，不会静默跳过。
   */
  private async runAcceptance(slice: SliceData, actor: string): Promise<AcceptanceOutcome> {
    const cfg = this.config.acceptance;

    // 没配切片级验收：显式记 skipped，不影响门禁结论。
    if (!cfg) {
      return {
        status: 'skipped',
        path: null,
        command: null,
        reason: '未配置切片级验收（config.yaml 的 gate.acceptance 段）',
        exitCode: null,
        durationMs: 0,
      };
    }

    const commandTemplate = cfg.command.trim() || DEFAULT_ACCEPTANCE_COMMAND;
    const required = cfg.required ?? true;
    const buildDir = cfg.buildDir ?? DEFAULT_ACCEPTANCE_BUILD_DIR;

    const resolution = resolveAcceptance(slice.acceptance?.dir, this.projectRoot, buildDir);

    if (!resolution.target) {
      const reason = resolution.reason ?? '本片没有登记验收目标';
      const outcome = missingTargetOutcome(required, reason, commandTemplate);
      await this.appendEvent(slice.id, 'gate.result', actor, {
        sliceId: slice.id,
        passed: false,
        acceptance: outcome,
        note: '切片级验收未执行',
      });
      return outcome;
    }

    const target = resolution.target;
    const command = buildAcceptanceCommand(commandTemplate, target.files);
    const timeoutSec = cfg?.timeoutSec ?? this.config.timeoutSec;
    const result = await runCommand(
      { name: 'acceptance', run: command },
      timeoutSec,
      this.projectRoot,
      // 验收命令必须是一个**真正跑测试**的进程，不能继承测试运行器的环境标记。
      // `NODE_TEST_CONTEXT=child-v8` 会被 node --test 继承成「我是测试子进程」，
      // 于是它跳过所有用例直接 exit 0 —— 门禁于是「假绿」（ADR-033）。
      { stripTestContext: true },
    );

    const outcome: AcceptanceOutcome = {
      status: result.passed ? 'passed' : 'failed',
      path: target.path,
      command,
      ...(result.passed ? {} : { reason: result.stderr.slice(0, 2000) || result.stdout.slice(0, 2000) || '验收命令失败' }),
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      files: target.files,
    };

    // 退出码 0 不等于「验收通过」：全是 todo/skip 的验收文件也会退出 0
    // （ADR-034 的验收骨架就是这么写的）。这里补一层「真跑过用例」的判定。
    if (outcome.status === 'passed') {
      const stats = parseTestRunnerStats(`${result.stdout}\n${result.stderr}`);
      const verdict = verifyAcceptanceRanTests(stats);
      if (!verdict.ok && verdict.reason) {
        outcome.status = 'failed';
        outcome.reason = verdict.reason;
      }
    }

    await this.appendEvent(slice.id, 'gate.result', actor, {
      sliceId: slice.id,
      passed: outcome.status === 'passed',
      acceptance: outcome,
      ...(outcome.reason ? { stderr: outcome.reason.slice(0, 2000) } : {}),
    });

    return outcome;
  }

  /**
   * Select gate commands based on slice type.
   * Looks up the type in config.profiles, falls back to default commands.
   */
  private selectCommands(sliceType: SliceType): GateCommand[] {
    if (this.config.profiles && this.config.profiles[sliceType]) {
      return this.config.profiles[sliceType];
    }
    return this.config.commands;
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
