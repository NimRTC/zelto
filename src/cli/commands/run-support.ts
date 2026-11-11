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
import { detectSliceType } from '../../core/gate/types.js';
import type { GateCommandSummary } from '../../core/sched/types.js';
import { classifyStall, isAutoResolvable, type StallClass } from '../../core/stall/classifier.js';
import { parseScopePaths } from '../../core/spec/scope.js';
import type { ExecutorAdapter } from '../../core/ports/executor.js';
import { store, events, ZELTO_DIR, loadConfig, worktreeManager } from './shared.js';
import { checkSliceGateGuard, describeGuardKinds } from './arch-guard.js';
import { budgetExhaustedMessage, printOutcome } from './run-messages.js';

/**
 * 求本片实际会跑的门禁命令（ADR-045）。
 *
 * 与 `GateExecutor.selectCommands` 同一口径：按切片类型查 profile，
 * 查不到就用默认命令。这里只**读**，不判定、不执行。
 *
 * 为什么要单独求一遍：门禁在 agent 跑完之后才执行，那时 agent 已经
 * 走了。agent 必须**事先**知道门禁会用哪套命令，才能用同一套验证自己
 * 的产物 —— 否则门禁②会在 agent 留下的现场上失败（CMake 生成器不一致
 * 是最典型的例子），而失败的报错指向「环境不对」，不指向「产物不对」。
 */
export function resolveGateCommands(sliceType: string): GateCommandSummary[] {
  const config = loadConfig();
  const profile = config.gate.profiles?.[sliceType];
  const commands = profile && profile.length > 0 ? profile : config.gate.commands;
  return commands.map((c) => ({ name: c.name, run: c.run }));
}

/** 按切片的写集推出它的类型（与门禁选 profile 的口径一致）。 */
export function gateCommandsForSlice(writes: string[]): GateCommandSummary[] {
  return resolveGateCommands(detectSliceType(writes));
}

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
 * 记一次 agent 会话的用量（ADR-035 §3.3 / §3.4）。
 *
 * 记账的唯一入口。适配器不知道切片 id、也不该知道事件流（C2：依赖单向向下），
 * 所以由 CLI 在 agent 退出后调用 `adapter.getUsage()`，把结果写成事件。
 *
 * 返回本次会话记下的花费（美元），拿不到用量数据时返回 null ——
 * **null 的含义是「没测到」，不是「零」**（两者必须能区分开，
 * 否则又是一道假闸门）。
 *
 * 记不到用量不是错误：适配器可能压根不实现 `getUsage`。
 * 那就什么都不写，让「没测到」这件事在 `run.finished.costUsd = null` 里可见。
 */
export async function recordAdapterUsage(
  sliceId: string,
  adapter: ExecutorAdapter,
  sessionId: string,
): Promise<number | null> {
  if (typeof adapter.getUsage !== 'function') return null;

  let usage;
  try {
    usage = adapter.getUsage(sessionId);
  } catch {
    // 适配器取数失败不是致命的 —— 记成「没测到」，不阻断流程
    return null;
  }
  if (!usage) return null;

  const payload: Record<string, unknown> = {
    amount: usage.costUsd,
    source: 'agent',
    adapter: adapter.name,
    sessionId,
  };
  if (usage.model !== undefined) payload.model = usage.model;
  if (usage.inputTokens !== undefined) payload.inputTokens = usage.inputTokens;
  if (usage.outputTokens !== undefined) payload.outputTokens = usage.outputTokens;

  try {
    await events.append(sliceId, 'budget.spent', 'zelto', payload);
  } catch (err) {
    // 写事件失败不是致命的 —— 账单漏记不该让整个 run 崩掉。
    // 但这件事必须让人看得见，所以打印一行警告。
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ⚠️  Could not record usage: ${msg}`);
  }
  return usage.costUsd;
}

/** 一次运行的花费结算结果。 */
export interface RunCostSettlement {
  /** 本次会话花费（美元）；null = 没测到（不是零） */
  costUsd: number | null;
  /** 是否已超预算。超了就已经写下 `stall.classified` 停机事件 */
  exhausted: boolean;
  /** 累计已花费 */
  spent: number;
  /** 上限（Infinity = 不限） */
  limit: number;
}

/**
 * 一次 agent 会话结束后的花费结算（ADR-035 §3.4 / §3.5）。
 *
 * 做两件事，顺序不能换：
 * 1. **先记账** —— 把本次会话的真实花费写成 `budget.spent` 事件；
 * 2. **再复判预算** —— 记账之后才知道总额，超预算的切片不许进 gate。
 *
 * 「适配器没报用量」按「未测到」处理：**不判定超支**（没有数据不等于超支），
 * 但 `costUsd = null` 让「没测到」这件事在事件流里可见 —— 否则又是一道假闸门。
 *
 * 上限为「不限」时永远不算超支（`limit` 是 Infinity）。
 */
export async function settleRunCost(
  sliceId: string,
  adapter: ExecutorAdapter,
  sessionId: string,
): Promise<RunCostSettlement> {
  const costUsd = await recordAdapterUsage(sliceId, adapter, sessionId);

  let spent = 0;
  let limit = Number.POSITIVE_INFINITY;
  try {
    const budget = new BudgetCollector(events, ZELTO_DIR);
    [spent, limit] = await Promise.all([budget.getSpent(sliceId), budget.getLimit(sliceId)]);
  } catch {
    // 读不到账本就不判定超支 —— 闸门打不开不该由一次读取失败决定
    return { costUsd, exhausted: false, spent, limit };
  }

  const exhausted = Number.isFinite(limit) && spent >= limit;
  if (exhausted) {
    // 停机事件只在这里写一次 —— 判定与写事件绑在一起，
    // 免得「判定」和「留痕」两处实现漂移。
    await events.append(sliceId, 'stall.classified', 'zelto', {
      sliceId, class: 'budget_exhausted', spent, limit,
    });
  }

  return { costUsd, exhausted, spent, limit };
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
      // 措辞与 run-messages 共用 —— 起跑前超预算与跑完超预算是同一件事，
      // 只是发生时机不同，不该让人以为是两种错误。
      printOutcome(budgetExhaustedMessage({ sliceId: id }, spent, limit));
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
    ...(config.gate.acceptance ? { acceptance: config.gate.acceptance } : {}),
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
 * 标记一片「停机」：退回 `frozen` + 写停机分类 + 留痕。
 *
 * 这是**停机的唯一落点** —— 前台跑、并行跑、后台跑三条路径的失败都走这里，
 * 免得三处各写各的、行为漂移（ADR-047）。
 *
 * 三件事，顺序不能换：
 *
 * 1. **退回 `frozen`**（`RUN_FINISH`）—— 状态机里 `running --RUN_FINISH--> frozen`
 *    正是这条退路（frozen 可再次 `RUN_START`）。不退回的话切片卡在 `running`，
 *    准入只认 frozen / completed，于是 `run` / `merge` / `resume` 全堵死，
 *    唯一出路是 `abandon` —— 整个切片作废，规格得重写。
 *    「agent 挂一次，切片就废了」不是设计意图：失败通常重跑就能过。
 *
 * 2. **写停机分类** —— 让它出现在 `zelto stall` / `zelto next` 里，
 *    人被交还控制权，就得看得见哪些切片等着他处理。
 *
 * 3. **写 append-only 事件** —— 停机是追溯链上的一环（C4）。
 *
 * @returns 是否真的退了状态（`false` 表示切片本来就不在 running）
 */
export async function markSliceStalled(
  id: string,
  stallClass: StallClass,
  options?: { exitCode?: number | null; reason?: string; actor?: string },
): Promise<{ reverted: boolean; from: string | null; to: string | null }> {
  const actor = options?.actor ?? 'zelto';
  const exitCode = options?.exitCode ?? null;

  // 先退状态：哪怕后面写分类失败，切片也已经是可重跑的 frozen，
  // 而不是卡死的 running。
  const rollback = await rollbackStalledSlice(id, { reason: options?.reason, actor });

  try {
    const slice = await store.read(id);
    slice.stall.class = stallClass;
    slice.stall.gateRetries = 0;
    await store.write(slice);

    await events.append(id, 'stall.classified', actor, {
      sliceId: id, class: stallClass, exitCode, runAborted: true,
      stateFrom: rollback.from, stateTo: rollback.to,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ⚠️ Could not write stall info: ${msg}`);
  }

  return rollback;
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
  let budgetExhausted = false;
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
      budgetExhausted = true;
      console.log(`  ⚠️ Auto-retry exhausted (${currentRetries}/${maxRetries}) — stalling`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ⚠️ Could not check retry state: ${msg}`);
      // Fall through to stall
    }
  }

  // Non-auto-resolvable or retries exhausted: 停机 = 退 frozen + 写分类。
  const rollback = await markSliceStalled(id, stallClass, {
    exitCode,
    reason: `agent failed: ${exitCode ?? 'signal'}`,
  });

  // Prominent stall notification
  const border = '═'.repeat(46);
  console.log(`\n  ╔${border}╗`);
  console.log(`  ║  ⚠️  SLICE STALLED: ${id.padEnd(28)}║`);
  console.log(`  ║  Class: ${stallClass.padEnd(36)}║`);
  console.log(`  ║  Action: zelto resume ${id.padEnd(22)}║`);
  console.log(`  ╚${border}╝\n`);
  if (rollback.reverted) {
    console.log(`  切片已退回 frozen —— 修好问题后直接重跑: zelto run ${id}\n`);
  }
  // 预算耗尽要说清 —— 不说，人重跑后才发现「第一次失败就停机」，
  // 而那时候已经白跑了一轮 agent（ADR-052）
  if (budgetExhausted) {
    console.log(
      `  ⚠️ 自动重试预算已用尽（${maxRetries}/${maxRetries}）—— 不重置预算的话，` +
        `下次失败会直接停机`,
    );
    console.log(`     恢复自动重试: zelto resume ${id} --reset-retry\n`);
  }

  return { action: 'stall' };
}

/**
 * 把「跑挂了」的切片退回 `frozen`（ADR-047）。
 *
 * 为什么必须退状态，而不是只写停机分类：
 *
 * 切片卡在 `running` 时，四条路全堵死：
 *   - `zelto run` 拒绝跑（准入只认 frozen / completed）
 *   - `zelto merge` 不收它（没签字）
 *   - `zelto resume` 说它没停机 —— 或者反过来：清了停机却仍是 running
 *   - 唯一出路是 `zelto abandon` —— 整个切片作废，规格得重写
 *
 * 也就是「agent 挂一次，切片就废了」。这不是设计意图：agent 失败通常意味着
 * **重跑就能过**（环境抖动、上下文超限、边界划窄），人看一眼就能重跑。
 *
 * 状态机里 `running --RUN_FINISH--> frozen` 正是这条退路（frozen 可再次
 * RUN_START），所以这里用 `RUN_FINISH` 事件退回 frozen —— 与 ADR-037 的
 * 越界回退同一条路径、同一个语义：「这一轮跑完了，但不算数」。
 *
 * 不自动重试：agent 失败不该由 zelto 替人决定「再试一次」——
 * 重试预算由 `handleAgentFailure` 的自动重试逻辑管（那是配置里写明的），
 * 退到 frozen 是把控制权交还给人。
 *
 * C1: 状态只落在文件里；C4: 留痕写 append-only 事件
 */
export async function rollbackStalledSlice(
  id: string,
  options?: { reason?: string; actor?: string },
): Promise<{ reverted: boolean; from: string | null; to: string | null }> {
  const actor = options?.actor ?? 'zelto';

  let slice;
  try {
    slice = await store.read(id);
  } catch {
    return { reverted: false, from: null, to: null };
  }

  const from = slice.state;
  if (from !== 'running') {
    // 不是 running 就不用退 —— frozen / completed 本来就能再跑，
    // 硬转会撞「Invalid transition」。
    return { reverted: false, from, to: from };
  }

  try {
    await store.transit(id, 'RUN_FINISH', actor);
    await events.append(id, 'slice.state.changed', actor, {
      sliceId: id, from, to: 'frozen', event: 'RUN_FINISH',
    });
    return { reverted: true, from, to: 'frozen' };
  } catch {
    // 状态被别处改过（比如人手工改过）—— 不强改，停机分类照写。
    return { reverted: false, from, to: from };
  }
}

/**
 * 处置「写集越界」的切片：退回 `frozen` 并留痕。
 *
 * 为什么必须退回 `frozen`（而不是把切片留在 `running`）：
 *
 * 越界之后 agent 已经跑完了，但这一轮**不算数** —— 门禁没跑、签字没发。
 * 如果状态留在 `running`，人就再也动不了这个切片：
 *   - `zelto run` 拒绝跑（状态必须是 frozen 或 completed）
 *   - `zelto merge` 不收它（没签字）
 *   - `zelto resume` 说它没停机
 *   - 唯一出路是 `zelto abandon` —— 整个切片作废，规格得重写
 *
 * 也就是「越界一次，切片就废了」。这不是设计意图：越界通常意味着**写集
 * 划窄了**（agent 需要动一个没写进写集的文件），人扩一下写集重跑就行。
 *
 * 状态机里 `running --RUN_FINISH--> frozen` 正是这条退路（frozen 可再次
 * RUN_START）。所以这里用 `RUN_FINISH` 事件退回 frozen：
 *   - 可重跑：人扩写集后 `zelto run` 直接能跑
 *   - 不自动重试：越界不是 agent 的错，是边界划错了，重试还是越界
 *   - 不进 gate、不发签字请求 —— 与 ADR-014 §5 一致
 *
 * C1: 状态只落在文件里；C4: 留痕写 append-only 事件
 */
export async function handleWriteSetViolation(
  id: string,
  options?: { violations?: string[]; tampered?: string[]; reason?: string },
): Promise<void> {
  const violations = options?.violations ?? [];
  const tampered = options?.tampered ?? [];
  const reason = options?.reason ?? 'write-set violation';

  try {
    // 退回 frozen，让切片可以重跑。状态机不认这个转换时也不阻断后续留痕。
    await store.transit(id, 'RUN_FINISH');
  } catch {
    // 状态已经在 frozen 或别的态 —— 留痕照样要写。
  }

  await events.append(id, 'run.aborted', 'zelto', {
    sliceId: id,
    exitCode: null,
    reason,
    violations,
    tampered,
  });
}
