// Run support helpers — 执行期共用的判定与门禁辅助
//
// 这些函数原先住在 core-slice.ts 里，但并行执行器（parallel-executor.ts）
// 也要用。把它们独立出来，避免两个模块互相 import 形成环。
//
// C1: 状态仍只落在文件里（切片文件 + 事件流）
// C4: 每个动作写 append-only 事件

import { readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { BudgetCollector } from '../../core/budget/collector.js';
import { GateExecutor } from '../../core/gate/executor.js';
import { SignManager } from '../../core/gate/sign.js';
import type { GateConfig } from '../../core/gate/types.js';
import { classifyStall, isAutoResolvable } from '../../core/stall/classifier.js';
import { parseScopePaths } from '../../core/spec/scope.js';
import { store, events, ZELTO_DIR, loadConfig, worktreeManager } from './shared.js';
import { checkSliceGateGuard, describeGuardKinds } from './arch-guard.js';

/**
 * Detect common source directories for default write-set.
 * Scans the project root for typical source directory names.
 */
export function detectDefaultWrites(): string[] {
  const candidates = ['src', 'lib', 'app', 'tools', 'scripts', 'tests', 'docs', 'include', 'assets', 'public', 'components', 'pages'];
  const found: string[] = [];
  try {
    const entries = readdirSync(process.cwd());
    for (const entry of entries) {
      if (candidates.includes(entry)) {
        try {
          if (statSync(join(process.cwd(), entry)).isDirectory()) {
            found.push(`${entry}/**`);
          }
        } catch { /* skip */ }
      }
      // Also detect root-level config files
      if (entry === 'CMakeLists.txt' || entry === 'Makefile' || entry === 'package.json' || entry === 'Cargo.toml' || entry === 'go.mod') {
        if (!found.includes(entry)) found.push(entry);
      }
    }
  } catch { /* cannot read cwd */ }
  return found;
}

/**
 * Resolve the effective write-set for a slice.
 *
 * Fallback chain:
 *   1. `slice.writes` (already set) — use as-is
 *   2. spec 「范围」 section — parse backticked paths, write back to slice file
 *   3. `detectDefaultWrites()` — last-resort default
 *
 * C1: resolved write-set is persisted back into `.zelto/slices/<id>.json`.
 *
 * @param persist false 时只算不写 —— 只读命令（zelto batch）用这个口径，
 *                免得「只查不跑」的命令把状态改了。
 * @returns the resolved write-set, and whether it was changed
 */
export async function resolveWriteSet(
  sliceId: string,
  persist: boolean = true,
): Promise<{ writes: string[]; changed: boolean; source: 'slice' | 'spec' | 'default' }> {
  const slice = await store.read(sliceId);

  if (slice.writes.length > 0) {
    return { writes: slice.writes, changed: false, source: 'slice' };
  }

  // 2. Parse the spec 「范围」 section
  let specWrites: string[] = [];
  try {
    const specContent = await readFile(slice.spec.path, 'utf-8');
    specWrites = parseScopePaths(specContent);
  } catch {
    specWrites = [];
  }

  if (specWrites.length > 0) {
    if (persist) {
      slice.writes = specWrites;
      await store.write(slice);
    }
    return { writes: specWrites, changed: true, source: 'spec' };
  }

  // 3. Fall back to directory detection
  const detected = detectDefaultWrites();
  if (detected.length > 0) {
    if (persist) {
      slice.writes = detected;
      await store.write(slice);
    }
    return { writes: detected, changed: true, source: 'default' };
  }

  return { writes: [], changed: false, source: 'slice' };
}

/**
 * Check if a slice has exceeded its budget limit.
 * Returns true if budget is OK, false if exhausted.
 */
export async function checkBudget(id: string): Promise<boolean> {
  try {
    const budget = new BudgetCollector(events, ZELTO_DIR);
    const exhausted = await budget.isExhausted(id);
    if (exhausted) {
      const [spent, limit] = await Promise.all([budget.getSpent(id), budget.getLimit(id)]);
      console.error(`  ⛔ Budget exhausted: $${spent.toFixed(2)} spent of $${limit.toFixed(2)} limit`);
      await events.append(id, 'stall.classified', 'zelto', {
        sliceId: id, class: 'budget_exhausted', spent, limit,
      });
      return false;
    }
    return true;
  } catch (err) {
    // Budget check failure is non-fatal — proceed without enforcement
    return true;
  }
}

/**
 * Run gate② for a finished slice and file a sign request.
 *
 * The gate executes inside the slice's worktree so it validates the agent's
 * actual output, not the main worktree.
 */
export async function autoGateAfterRun(id: string): Promise<void> {
  const config = loadConfig();
  const gateConfig: GateConfig = {
    commands: config.gate.commands.map((c) => ({ name: c.name, run: c.run })),
    profiles: config.gate.profiles,
    changedLineCoverage: 0.8,
    timeoutSec: config.gate.timeoutSec,
    retry: { max: config.gate.retry.max, budgetStepUsd: 0.05 },
  };

  // Gate runs inside the slice's worktree so it validates the agent's actual output
  const manager = worktreeManager();
  const gateRoot = manager.exists(id) ? manager.pathFor(id) : process.cwd();

  // ── 架构护栏（切片级，ADR-027 Q2）────────────────────────────────
  // 与 `zelto gate` 同一口径：只看与本片写集相关的偏离，无设计时跳过。
  // 拦下时不进门禁、不改状态 —— 等人修好或改 policy 后重跑。
  try {
    const slice = await store.read(id);
    const sliceGuard = await checkSliceGateGuard(slice.writes, { scanRoot: gateRoot });
    if (sliceGuard?.verdict.blocked) {
      console.log(`  Arch:     ❌ 架构护栏拦截：${describeGuardKinds(sliceGuard.verdict, 'blocked')}`);
      console.log(`  Design:   ${sliceGuard.designId}`);
      console.log('  修好偏离或改 policy.yaml 的 arch 段后重跑门禁。');
      return;
    }
    if (sliceGuard?.verdict.needsConfirm) {
      console.log(`  Arch:     ⚠️  待确认（不拦）：${describeGuardKinds(sliceGuard.verdict, 'pending')}`);
    }
  } catch {
    // 读不到切片或扫不到图就不拦 —— 门禁自己的命令会给出结论
  }

  const executor = new GateExecutor(store, events, gateConfig, gateRoot);
  console.log(`\n  Auto-running gate②...`);
  console.log(`  CWD: ${gateRoot}`);
  const report = await executor.execute(id);

  console.log(`  Gate commands: ${report.results.length}`);
  for (const r of report.results) {
    const icon = r.passed ? '✅' : '❌';
    console.log(`    ${icon} ${r.command} (${r.durationMs.toFixed(0)}ms, exit ${r.exitCode ?? 'signal'})`);
    if (!r.passed && r.stderr) {
      const stderrLines = r.stderr.split('\n').filter((l) => l.trim()).slice(0, 5);
      for (const line of stderrLines) {
        console.log(`       ${line.slice(0, 200)}`);
      }
    }
  }

  if (report.passed) {
    console.log(`  Gate: ✅ Passed (${report.totalDurationMs.toFixed(0)}ms)`);
    await store.transit(id, 'GATE_PASS');
    await events.append(id, 'slice.state.changed', 'zelto', {
      sliceId: id, from: 'frozen', to: 'completed', event: 'GATE_PASS',
    });

    const signManager = new SignManager(ZELTO_DIR, events, store);
    const signReq = await signManager.request(id, 'zelto');
    console.log(`  Sign: 📋 Request created (${signReq.id})`);
    console.log(`  Next: zelto sign ${id} --approve`);
  } else {
    console.log(`  Gate: ❌ Failed (${report.totalDurationMs.toFixed(0)}ms)`);
    if (report.retryCount > 0) {
      console.log(`  Retries: ${report.retryCount}`);
    }
    console.log(`  Run: zelto gate ${id} to retry`);
  }
}

/**
 * Handle a failed agent execution. For auto-resolvable stalls (permission_prompt,
 * environment_failure, context_exhaustion), automatically retry up to maxRetries.
 * For non-auto-resolvable stalls, write stall info and return 'stall'.
 *
 * @returns 'retry' if auto-retry is happening, 'stall' if the slice should stall
 */
export async function handleAgentFailure(
  id: string,
  exitCode: number | null,
  options?: { maxRetries?: number },
): Promise<{ action: 'retry' | 'stall'; retryCount?: number }> {
  const stallClass = classifyStall({
    type: exitCode === null ? 'build_failure' : 'test_failure',
    message: `Agent exited with code ${exitCode ?? 'signal'}`,
    attempts: 1,
  });

  const maxRetries = options?.maxRetries ?? 2;

  // Check if this stall class is auto-resolvable
  if (isAutoResolvable(stallClass)) {
    try {
      const slice = await store.read(id);
      const currentRetries = slice.stall.autoResolved ?? 0;

      if (currentRetries < maxRetries) {
        // Auto-retry: increment counter, log, return retry signal
        slice.stall.autoResolved = currentRetries + 1;
        // Don't set stall.class — slice is not stalled, just retrying
        await store.write(slice);

        await events.append(id, 'stall.classified', 'zelto', {
          sliceId: id, class: stallClass, exitCode,
          runAborted: true, autoRetry: true,
          retryCount: currentRetries + 1, maxRetries,
        });

        console.log(`  🔄 Auto-retrying (${currentRetries + 1}/${maxRetries})...`);
        return { action: 'retry', retryCount: currentRetries + 1 };
      }

      // Max retries exhausted — fall through to stall
      console.log(`  ⚠️ Auto-retry exhausted (${maxRetries}/${maxRetries}) — stalling`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ⚠️ Could not check retry state: ${msg}`);
      // Fall through to stall
    }
  }

  // Non-auto-resolvable or retries exhausted: write stall info
  try {
    const slice = await store.read(id);
    slice.stall.class = stallClass;
    slice.stall.gateRetries = 0;
    await store.write(slice);

    await events.append(id, 'stall.classified', 'zelto', {
      sliceId: id, class: stallClass, exitCode, runAborted: true,
    });

    // Prominent stall notification
    const border = '═'.repeat(46);
    console.log(`\n  ╔${border}╗`);
    console.log(`  ║  ⚠️  SLICE STALLED: ${id.padEnd(28)}║`);
    console.log(`  ║  Class: ${stallClass.padEnd(36)}║`);
    console.log(`  ║  Action: zelto resume ${id.padEnd(22)}║`);
    console.log(`  ╚${border}╝\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ⚠️ Could not write stall info: ${msg}`);
  }

  return { action: 'stall' };
}
