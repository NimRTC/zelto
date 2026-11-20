// Core slice lifecycle commands: slices, create, check, clarify, abandon, freeze, run, admit

import { createInterface } from 'node:readline';
import { writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Extract the value of a named flag from args, stopping at the next flag.
 * Returns undefined if the flag is not found or has no value.
 * E.g. extractFlagValue(['--title', 'hello', '--writes', 'x'], '--title') → 'hello'
 */
function extractFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const parts: string[] = [];
  for (let i = idx + 1; i < args.length; i++) {
    if (args[i].startsWith('--')) break;
    parts.push(args[i]);
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/**
 * Extract every occurrence of a repeatable flag.
 * Each occurrence takes exactly one value (the next argument).
 * E.g. extractFlagValues(['--requirement', 'R1', '--requirement', 'R2'], '--requirement')
 * → ['R1', 'R2']
 *
 * 为什么需要它：需求追溯引用可以有多条（一片往往追溯到多条需求），
 * 而 extractFlagValue 会把多条值拼成一个字符串——追溯引用要能一条一条列出来。
 */
function extractFlagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== flag) continue;
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) continue;
    const trimmed = value.trim();
    if (trimmed) values.push(trimmed);
  }
  return values;
}
import { ClarifyEngine, type LlmQuestionGenerator } from '../../core/clarify/engine.js';
import { Scheduler } from '../../core/sched/engine.js';
import type { SliceData } from '../../core/slice/store.js';
import { checkSliceId } from '../../core/slice/store.js';
import { GateExecutor } from '../../core/gate/executor.js';
import { SignManager } from '../../core/gate/sign.js';
import type { GateConfig } from '../../core/gate/types.js';
import { detectSliceType } from '../../core/gate/types.js';
import { classifyStall, isAutoResolvable } from '../../core/stall/classifier.js';
import {
  classifyLiveness,
  classifyLivenessAsync,
  formatIdle,
  lastActivityOf,
  readSessionLiveness,
  readSliceLivenessRecord,
  readSliceLivenessRecords,
  decideRecovery,
  readRecoveries,
  recordRecovery,
  recordEscalation,
  MAX_AUTO_RECOVERIES,
} from '../../core/activity/index.js';
import { isProcessAlive, isProcessTreeAlive } from '../../core/sched/index.js';
import {
  decideRunWatchdog,
  type RunWatchdogAction,
} from '../../core/sched/index.js';
import { type WorktreeInfo } from '../../core/worktree/index.js';
import { parseScopePaths, parseAcceptanceCriteria, parseMentionedPaths } from '../../core/spec/scope.js';
import { parseReferencedPaths } from '../../core/spec/reference.js';
import { evaluateWriteSet, evaluateWriteSetCoverage } from '../../core/spec/write-set.js';
import { judgeTrace, traceCountsOf, blockingViolations, advisoryViolations } from '../../core/trace/index.js';
import { validateDeterministic } from '../../core/spec/deterministic/validator.js';
import { analyzeSemantic } from '../../core/spec/semantic/analyzer.js';
import { materializeRequirements, evaluateFreezeTrace } from '../../core/spec/trace-extract.js';
// ADR-086：冻结编排下沉到 core —— CLI 与 Web 调同一份（C3：判定不许分叉）
import { freezeSlice, computeBoundaryHash } from '../../core/lifecycle/freeze.js';
import { register } from './shared.js';
import type { ExecutorAdapter } from '../../core/ports/executor.js';
import { HaltStore, rollbackHaltedSlice } from '../../core/halt/index.js';
import { store, events, ZELTO_DIR, loadPolicyConfig, hashSpecFile, loadConfig, createLlmFromConfig, createExecutorAdapter, harnessForAdapter, resolveAgentCommand, worktreeManager, ensureWorktree, removeWorktree, optionValue, optionValueStrict } from './shared.js';
import { executeSlicesByPhase, printParallelSummary, zeltoOwnedPaths } from './parallel-executor.js';
import { buildExecutionPlan, printExecutionPlan } from './execution-plan.js';
import { generateClarifyQuestions } from '../../llm/generators/clarify.js';
import { detectQuestion, suspendSliceForQuestion } from './question.js';
import {
  agentFailedMessage,
  budgetExhaustedMessage,
  printOutcome,
  writeSetOutcomeLines,
} from './run-messages.js';
import { resolveWriteSet, checkBudget, autoGateAfterRun, handleAgentFailure, detectDefaultWrites, settleRunCost, gateCommandsForSlice, markSliceStalled, precheckWriteSetAgainstPolicy, revertRunAbortedBeforeStart } from './run-support.js';
import {
  type RuntimeGuard,
  enforceWriteSet,
  installRuntimeGuard,
  releaseGuards,
} from './runtime-guard.js';
import {
  spawnSupervisor,
  supervisorEntryPath,
  supervisorLogPath,
} from './supervisor.js';
import { finishRun } from './run-finish.js';
import { SliceProgressProbe } from './progress-probe.js';
import { collectSliceProgress } from './progress-collect.js';
import { loadTask, mergeSessionLiveness, patchTask, saveTask, tasksDir, type TaskInfo } from './task-store.js';

// 供其它命令复用（ai-pipeline.ts / question.ts）
export { autoGateAfterRun, handleAgentFailure } from './run-support.js';

// ─── Write-set resolution ──────────────────────────────────────────────────────
//
// resolveWriteSet / checkBudget / autoGateAfterRun / handleAgentFailure 已经移到
// ./run-support.ts — 并行执行器也要用它们，独立出来可以避免两个模块互相 import。

// ─── Worktree helpers ─────────────────────────────────────────────────────────

// `ensureWorktree` / `worktreeManager` / `removeWorktree` live in ./shared.ts so that
// gate, diff and sign commands can reuse the same worktree convention.

/**
 * 重试时**接着上一次跑**，而不是从头再来（ADR-055）。
 *
 * 为什么这件事值得单独做：
 *
 * agent 跑超时被杀掉时，它已经做掉的工作都留在 worktree 里了 —— 代码改了一半、
 * 测试跑了一半、上下文摸清了一半。从头再跑一遍等于把这些工作重做一遍，
 * 还把 agent 的上下文清零，让它重新摸索已经摸清的东西。
 *
 * 实测（2026-11-11，nimrtc-zelto 的 v1-remb-parse-and-trust）：agent 跑了
 * 34 分钟被杀，zelto 从头重跑，第二个 agent 又跑了 20 分钟 —— 而第一个 agent
 * 的成果（一份全部通过的报告）被丢掉了。
 *
 * 所以：**能续就续**。同一个 agent 会话（`--resume`），提示它「继续」。
 * 续不了（适配器不支持 resume / 没有 agent 会话 id）才退回从头跑。
 *
 * @returns 续跑得到的新 session id；续不了返回 null（调用方从头跑）。
 */
async function resumeForRetry(
  adapter: ExecutorAdapter,
  previousSessionId: string,
  sliceId: string,
  bundlePath: string,
): Promise<string | null> {
  if (!adapter.metadata.capabilities.resume) return null;
  if (typeof adapter.continueSession !== 'function') return null;

  try {
    const { sessionId } = await adapter.continueSession(
      previousSessionId,
      '继续完成这个切片。上一次运行超时被中止了，' +
      '工作区里已经有你之前做出的改动 —— 先检查当前状态，' +
      '补完没做完的部分，不要从头重做已经做完的事。',
    );
    console.log(`  ↻ Continuing the same agent session (${sliceId})`);
    return sessionId;
  } catch {
    // 续不上就退回从头跑 —— 不是致命错误，只是多花点时间。
    return null;
  }
}

/**
 * zelto 自己写进 worktree 的文件（相对 worktree 的路径）。
 * 规格副本、验收目录副本、约束包镜像 —— 这些是 zelto 放进去的，不是 agent 写的。
 * 审计时它们不能算成「agent 越界写入」（否则每次运行都会被自己的文件拦下）；
 * 但内容被改动就是篡改：改了规格副本等于自动改规格（AGENTS.md 禁区）。
 *
 * 实现在 ./parallel-executor.ts —— 单切片运行与并行执行器共用同一份定义。
 */

/**
 * 活进程看门狗（ADR-074）—— 每一轮的起跑时刻。
 *
 * 为什么需要它：`waitForExit` 的 Promise 只在**本进程内**有效。
 * 会话文件里的运行记录没有「世代」字段，而上一代被收走（reap）的记录
 * 还留在盘上、status 仍是 running。看门狗要靠「起跑时刻」把两者分开 ——
 * 这一轮开跑之前的记录一律不算本轮的现场（见 core/sched/watchdog-policy）。
 *
 * 重试（续跑 / 从头跑）会开新的一轮，所以每次重新 start 都覆盖它。
 */
const runGenStartedAt = new Map<string, string>();

/** 看门狗的轮询间隔（毫秒）。 */
const RUN_WATCHDOG_INTERVAL_MS = 5_000;

/**
 * 本轮 agent 的进程是否还活着（**直接问进程表**，不看会话文件）。
 *
 * 为什么不能只看会话文件（实测于 nimrtc-zelto v2-input-binder，2026-11-17）：
 *
 *   会话文件的 `status` 在超时时被写成 `timeout`（不是 `running`），
 *   而 `readSliceLivenessRecords` 只收 `status === 'running'` 的记录 →
 *   这份被滤掉；剩下上一代的记录 `startedAt` 早于本轮起跑 → 也被滤掉。
 *   结果：records 为空 → 看门狗判「从没真正开跑」→ **收走一个活着的 agent**。
 *
 *   那个 agent 毫不知情：它继续改文件、继续发 `policy.decision`，
 *   直到自己跑完。而 zelto 已经在同一 worktree 上重试 —— 两个 agent 抢同一批文件。
 *
 * 判据：会话文件里记的 `agentPid`（按 `--session-id` 反查拿到的 agent 本人 pid）
 * 或包装 `pid`，**或其任一后代**还活着 → 就算活着。
 *
 * 拿不到进程表时返回 `true`（fail safe）：宁可多等，也不误杀正在干活的 agent。
 */
function agentProcessAlive(sessionId: string): boolean {
  const rec = readSessionLiveness(process.cwd(), sessionId);
  if (!rec) return false;
  const pids = [rec.agentPid, rec.pid].filter(
    (p): p is number => typeof p === 'number' && p > 0,
  );
  if (pids.length === 0) return false;
  for (const pid of pids) {
    if (isProcessAlive(pid)) return true;
  }
  return false;
}

/**
 * 一次「等 agent 结束」，期间由活进程看门狗盯着现场。
 *
 * 两种情况任一先到即返回：
 *   - `waitForExit` 正常返回（agent 退出，正常路径接手停机判定）
 *   - 看门狗判定本轮没有进程在管（`reap`）→ 就地停机并返回 exitCode=null，
 *     不再傻等一个永远不会 resolve 的 Promise
 *
 * 为什么必须有看门狗（实测于 nimrtc-zelto）：
 * 停机判定原先只在 `waitForExit` 之后执行。CLI 进程先死时，这一行从没
 * 被执行到 —— 切片停在 running、预约锁不释放，准入永久挡。
 * 看门狗把「进程死了」变成「当场退 frozen」，而不是等人几小时后想起来 `--reap`。
 */
/**
 * 看门狗收走时，采集「这一轮做成了什么」（D-56）。
 *
 * 为什么看门狗路径要单独采集：看门狗收走时**不走 `finishRun`** ——
 * 它自己写停机、写分类、写 `run.aborted`（这一轮已经被收走了，
 * 再走一遍收尾流水线会重复退状态）。
 *
 * 于是「做成了什么」在这个路径上会漏掉 —— 而这恰恰是最需要它的时候：
 *
 * 实测（nimrtc-zelto v3-chrome-waterfall，2026-11-18）：
 * agent 跑了 30 分钟被超时收走，zelto 判成 `environment_failure` 退 frozen。
 * 但那 30 分钟里它**把活儿全做完了** —— 6 条验收标准全部通过、
 * 4 个文件都改好了。只报「超时收走」，人看到的还是「又跑废了」。
 *
 * 与 D-55（进展探针）是两件事：
 *   - D-55 回答「它还在推进吗」→ 决定**要不要收走**；
 *   - D-56（本模块）回答「它做成了什么」→ 收走之后**告诉人留下了什么**。
 * D-55 解决了「别砍掉还在推进的 agent」，
 * D-56 解决了「真被砍掉时，别让人以为白砍了」。
 *
 * 采集失败不阻断处置：附加信息是补充，不是判据。
 */
async function collectWatchdogProgress(
  sliceId: string,
): Promise<Record<string, unknown>> {
  try {
    const manager = worktreeManager();
    const worktree = manager.exists(sliceId) ? manager.pathFor(sliceId) : null;

    // 与前台收尾**共用**一份采集实现（`progress-collect.ts`）——
    // 两处各写一份必然漂移，而漂移的方向恰好是「漏掉一条路径」。
    const progress = await collectSliceProgress({
      sliceId,
      worktree,
      // 看门狗收走时门禁不会跑 —— 「哪几条断言过了」只有这里能拿到。
      runAcceptance: true,
    });

    if (!progress) return {};

    // 人也要看得见 —— 事件是追溯，输出是当场。
    console.error(`\n  📊 这一轮的进展：${progress.summary}`);
    if (progress.passedNames.length > 0) {
      console.error(`     ✅ 已验证 ${progress.passedNames.length} 条验收标准`);
    }
    if (progress.failedNames.length > 0) {
      console.error(`     ❌ ${progress.failedNames.length} 条断言不成立`);
    }
    if (progress.todo > 0) {
      console.error(`     ⬜ ${progress.todo} 条还没写断言`);
    }

    return { progress };
  } catch {
    return {};
  }
}

/**
 * 等 agent 结束 —— 同时盯着活进程看门狗与拉闸请求。
 *
 * 导出是为了可测：拉闸「在等 agent 的时候生效」这件事，
 * 只有真的挂着一个假 adapter 才能验（源码 grep 只能证明代码在，
 * 不能证明它真的会让等待方停下来）。
 */
export async function waitForExitWithWatchdog(opts: {
  sliceId: string;
  sessionId: string;
  adapter: ExecutorAdapter;
  runStartedAt: string;
  maxRetries: number;
  /**
   * 拉闸通道（测试注入用）。
   *
   * 默认按 `.zelto/halts/` 读 —— 传进来是为了让测试能指向临时目录，
   * 免得真去动项目根下的暂停请求。
   */
  haltStore?: HaltStore;
  /** 拉闸作用域（默认用切片 id） */
  haltScope?: string;
}): Promise<{ exitCode: number | null; watchdogReaped: boolean; halted?: boolean; haltReason?: string }> {
  const { sliceId, sessionId, adapter, runStartedAt, maxRetries } = opts;
  const exitPromise = adapter.waitForExit(sessionId).then((code) => ({ exitCode: code, watchdogReaped: false }));

  // 拉闸通道（单片前台路径）—— 见下面 setInterval 里的说明。
  // 作用域：单片运行没有批次键，用切片 id 当自己的作用域；
  // `scope='all'` 的全局拉闸对它同样生效（HaltStore.isHalted 的语义）。
  const haltStore = opts.haltStore ?? new HaltStore(ZELTO_DIR);
  const haltScope = opts.haltScope ?? sliceId;

  // D-55：进展探针 —— agent 每调用一次工具，hook 就往事件流写一条。
  // 有新事件 = 它还在推进 → 告诉适配器「倒计时重新开始」。
  //
  // 这一条是必需的：Claude Code 跑 `--output-format json`，
  // stdout 直到最后才有内容 —— 只看输出会把「正在连续调用工具的 agent」
  // 误判成卡住，然后被空转超时砍掉（D-55 的病灶）。
  const progress = new SliceProgressProbe(process.cwd(), sliceId);

  let timer: ReturnType<typeof setInterval> | null = null;
  const watchdogPromise = new Promise<{ exitCode: number | null; watchdogReaped: boolean; halted?: boolean; haltReason?: string }>((resolve) => {
    timer = setInterval(async () => {
      // 进展探针先行 —— 它只读文件大小，不会因失败阻断看门狗。
      try {
        if (progress.poll()) adapter.markProgress?.(sessionId);
      } catch { /* 探针失败不影响看门狗判定 */ }

      // ── 拉闸（halt）—— 单片前台路径也要听 ──────────────────────────
      //
      // 病灶（实测 nimrtc-v14 v1-n5-turn-server，2026-11-20）：
      //   人跑 `zelto halt --reason "..."` 想让跑偏的 agent 停下，
      //   命令回了「已拉闸」，**但 agent 照跑不误** ——
      //   因为只有 `parallel-executor`（`run --parallel`）那条路径
      //   调了 `haltStore.isHalted()`，单片 `zelto run <id>` 压根没读过
      //   `.zelto/halts/`。
      //
      //   人以为喊停了，其实没喊停 —— 这比「喊了停不了」更糟：
      //   人会带着「已经停了」的错觉去处理现场（比如改文件），
      //   而 agent 还在同时改同一批文件。
      //
      // 修法：单片路径同样在等 agent 的间隙听拉闸。收到就停掉 agent，
      // 现场保留（worktree / 预约都不动），切片退回 frozen。
      const haltReq = await haltStore.isHalted(haltScope).catch(() => null);
      if (haltReq) {
        // **先 resolve 再 stop** —— 顺序反了的话：
        //   `adapter.stop()` 会让 `waitForExit` 的 promise resolve，
        //   `Promise.race` 于是抢在 watchdogPromise 之前返回 ——
        //   拿到的就是「agent 退出了」那个结果（没有 halted 字段），
        //   拉闸信息整个丢掉。
        resolve({
          exitCode: null,
          watchdogReaped: false,
          halted: true,
          haltReason: haltReq.reason,
        });
        try {
          await adapter.stop(sessionId);
        } catch {
          // agent 已经退了 —— 停不到也没关系
        }
        return;
      }

      let action: RunWatchdogAction;
      try {
        const slice = await store.read(sliceId);
        action = decideRunWatchdog({
          sliceId,
          sliceState: slice.state,
          stallClass: slice.stall.class,
          runStartedAt,
          // 只拿「本轮起跑之后」落盘的运行记录 —— 上一代的尸体不算现场
          records: readSliceLivenessRecords(process.cwd(), sliceId, runStartedAt),
          recoveries: readRecoveries(process.cwd(), sliceId).count,
          isProcessAlive,
          // 「没有记录」不等于「没有进程」—— reap 之前先问一次进程表。
          // 实测（nimrtc-zelto v2-input-binder，2026-11-17）：看门狗把一个
          // 正在改文件的 agent 判成「从没开跑」，退成 frozen，而 agent 毫不知情
          // 地继续跑 —— 现场是两个 agent 抢同一批文件。
          isAgentAlive: () => agentProcessAlive(sessionId),
        });
      } catch {
        return; // 读盘失败不改变判定 —— 下一轮再试
      }
      if (action.action === 'none') return;

      // 处置：退 frozen + 写分类 + 留痕（与 agent 失败同一条落点，ADR-047）
      const internal = sessionId;
      let transitioned: Awaited<ReturnType<typeof markSliceStalled>> | null = null;
      try {
        transitioned = await markSliceStalled(sliceId, classifyStall({
          type: 'build_failure',
          message: action.reason,
          attempts: 1,
        }), { exitCode: null, reason: `live-process watchdog: ${action.reason}` });
      } catch { /* 状态被别处改过：事件照样留 */ }

      await events.append(sliceId, 'run.aborted', 'watchdog', {
        sliceId,
        exitCode: null,
        reason: action.reason,
        watchdog: true,
        action: action.action,
        sessionId: internal,
        // 「做成了什么」—— 看门狗收走恰恰是最需要它的时候。
        //
        // 实测（nimrtc-zelto v3-chrome-waterfall，2026-11-18）：
        // agent 跑了 30 分钟被超时收走，zelto 判成 environment_failure 退 frozen。
        // 但那 30 分钟里它**把活儿全做完了** —— 6 条验收标准全部通过。
        // 只报「超时收走」，人看到的还是「又跑废了」。
        ...(await collectWatchdogProgress(sliceId)),
      });
      // 记账：这一轮同样是一次运行（ADR-041 §3.1 / ADR-092）。
      // 看门狗收走的这一轮**由这里记、且只记一次** —— 主循环看到
      // watchdogRecorded 后不再补记。
      try {
        await store.recordRun(sliceId, { ok: false, exitCode: null, phase: 'watchdog' });
      } catch { /* 记账失败不阻断处置 */ }

      const stateNote = transitioned?.reverted ? '（已退回 frozen，修好环境后直接重跑）' : '';      console.error(`\n  🐕 活进程看门狗：${action.reason}${stateNote}`);
      if (action.action === 'escalate') {
        console.error('     看门狗自动恢复次数已达上限 —— 请人看现场后 zelto resume ' + sliceId);
      }
      resolve({ exitCode: null, watchdogReaped: true });
    }, RUN_WATCHDOG_INTERVAL_MS);
  });
  // 看门狗定时器不能让进程退不出去
  (timer as unknown as { unref?: () => void } | null)?.unref?.();

  try {
    return await Promise.race([exitPromise, watchdogPromise]);
  } finally {
    if (timer) clearInterval(timer);
  }
}

// ─── slices ──────────────────────────────────────────────────────────────────

register('slices', async (args) => {
  const doPrune = args.includes('--prune');

  if (doPrune) {
    return await pruneSlices();
  }

  const list = await store.list();
  if (list.length === 0) {
    console.log('No slices found.');
    return 0;
  }

  console.log('Slices:');
  for (const id of list) {
    try {
      const s = await store.read(id);
      console.log(`  ${id.padEnd(20)} ${s.state.padEnd(15)} ${s.title}`);
    } catch {
      console.log(`  ${id} (error reading)`);
    }
  }
  return 0;
});

/**
 * Remove abandoned slices and their events from disk.
 */
async function pruneSlices(): Promise<number> {
  const { rmSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const list = await store.list();
  let removed = 0;

  for (const id of list) {
    try {
      const s = await store.read(id);
      if (s.state !== 'abandoned') continue;

      // Remove slice file
      const slicePath = join('.zelto', 'slices', `${id}.json`);
      if (existsSync(slicePath)) {
        rmSync(slicePath, { force: true });
      }

      // Remove events directory
      const eventsDir = join('.zelto', 'events', id);
      if (existsSync(eventsDir)) {
        rmSync(eventsDir, { recursive: true, force: true });
      }

      // Remove bundle if exists
      const bundlePath = join('.zelto', `${id}-bundle.json`);
      if (existsSync(bundlePath)) {
        rmSync(bundlePath, { force: true });
      }

      console.log(`  🗑️  Removed abandoned slice: ${id}`);
      removed++;
    } catch {
      // Skip problematic slices
    }
  }

  if (removed === 0) {
    console.log('No abandoned slices to remove.');
  } else {
    console.log(`\n✅ Removed ${removed} abandoned slice(s).`);
  }
  return 0;
}

// ─── create ──────────────────────────────────────────────────────────────────

register('create', async (args) => {
  let [id] = args;

  // Show usage for --help
  if (id === '--help' || id === '-h') {
    console.error('Usage: zelto create <slice-id> [--title <title>] [--writes <path1,path2,...>] [--requirement <ref>]... [--from-spec]');
    console.error('');
    console.error('  --from-spec    Parse spec markdown (specs/slices/<id>.md) to auto-populate');
    console.error('                 writes, requirements, baseline, and acceptance test fields.');
    console.error('                 Also detects v0- prefix as baseline slice.');
    console.error('  --requirement  Declare a requirement reference (repeatable). Required unless the');
    console.error('                 spec has acceptance criteria — the freeze gate refuses slices');
    console.error('                 with no traceable origin (ADR-032).');
    return 0;
  }

  // Interactive mode: prompt for values if not provided.
  // Only when stdin is a TTY — in scripts/CI there is nobody to answer, and
  // waiting for input would hang forever.
  if ((!id || id.startsWith('--')) && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    const ask = (q: string): Promise<string> => new Promise((r) => rl.question(q, r));

    console.log('Creating a new slice (interactive mode)');
    console.log('');

    id = (await ask('  Slice ID (e.g. "my-feature"): ')).trim();
    if (!id) {
      console.error('Error: Slice ID is required.');
      rl.close();
      return 1;
    }

    const titleInput = await ask('  Title (optional, defaults to ID): ');
    const writesInput = await ask('  Write-set (comma-separated paths, optional): ');

    rl.close();

    args = [id];
    if (titleInput) {
      args.push('--title', titleInput);
    }
    if (writesInput) {
      args.push('--writes', ...writesInput.split(',').map((w) => w.trim()).filter(Boolean));
    }
  }

  // Re-parse after potential interactive input
  id = args[0];
  if (!id || id.startsWith('--')) {
    console.error('Usage: zelto create <slice-id> [--title <title>] [--writes <path1,path2,...>]');
    return 1;
  }

  const title = extractFlagValue(args, '--title') ?? id;

  const writesRaw = extractFlagValue(args, '--writes');
  const writes = writesRaw ? writesRaw.split(',').map((w: string) => w.trim()).filter(Boolean) : [];

  const isJson = args.includes('--json');
  const fromSpec = args.includes('--from-spec');
  // 需求追溯引用（人批准的出处）：可以给多条。
  // 没有规格可解析时，这是人唯一能声明「这段代码为什么存在」的入口（ADR-032 §3.3）。
  const declaredRequirements = extractFlagValues(args, '--requirement');

  // id 白名单只有一份定义（core/slice/store.ts 的 `checkSliceId`）——
  // 「什么算合法 id」不该有多个口径。
  const idCheck = checkSliceId(id);
  if (!idCheck.valid) {
    if (isJson) {
      console.log(JSON.stringify({ success: false, error: idCheck.reason }));
    } else {
      console.error(idCheck.reason);
    }
    return 1;
  }

  if (await store.exists(id)) {
    if (isJson) {
      console.log(JSON.stringify({ success: false, error: `Slice "${id}" already exists.` }));
    } else {
      console.error(`Slice "${id}" already exists.`);
    }
    return 1;
  }

  // If --from-spec, parse the spec markdown to populate slice fields
  if (fromSpec) {
    return await createSliceFromSpec(id, title, writes, isJson, declaredRequirements);
  }

  const slice = store.create(id, title, {
    writes,
    trace: { requirements: declaredRequirements, contracts: [], tests: [] },
  });
  await store.write(slice);
  await events.append(id, 'spec.drafted', 'cli', { sliceId: id, title, specPath: slice.spec.path });

  if (isJson) {
    console.log(JSON.stringify({
      success: true, id, title, state: slice.state,
      writes, spec: slice.spec.path,
    }));
    return 0;
  }

  console.log(`zelto create ${id} — ✅ Created`);
  console.log(`  ID:     ${id}`);
  console.log(`  Title:  ${title}`);
  console.log(`  State:  ${slice.state}`);
  console.log(`  Writes: ${writes.length > 0 ? writes.join(', ') : '(none)'}`);
  console.log(`  Spec:   ${slice.spec.path}`);
  console.log(`  Reqs:   ${declaredRequirements.length > 0 ? declaredRequirements.join('; ') : '(none — 没有规格章节可物化，冻结准入会拦住它)'}`);
  console.log(`  Next:   zelto check ${id} && zelto freeze ${id}`);
  return 0;
});

// ─── create from spec (helper for --from-spec) ────────────────────────────

/**
 * Create a slice from a spec markdown file.
 * Parses ## 范围 for writes, ## 验收标准 for requirements.
 * Detects v0- prefix as baseline slices.
 */
async function createSliceFromSpec(
  id: string,
  title: string,
  cliWrites: string[],
  isJson: boolean,
  declaredRequirements: string[] = [],
): Promise<number> {
  const specPath = `specs/slices/${id}.md`;

  let content: string;
  try {
    content = await readFile(specPath, 'utf-8');
  } catch {
    if (isJson) {
      console.log(JSON.stringify({ success: false, error: `Spec file not found: ${specPath}` }));
    } else {
      console.error(`Spec file not found: ${specPath}`);
    }
    return 1;
  }

  const lines = content.split('\n');

  // Parse title from # Slice: <id> heading
  let parsedTitle = title;
  for (const line of lines) {
    const sliceMatch = line.match(/^#\s*Slice:\s*(.+)$/i);
    if (sliceMatch) {
      parsedTitle = sliceMatch[1].trim();
      break;
    }
  }

  // 写集与验收标准都用**共享解析器**（ADR-049）：
  // 这里原来自己写了一份只认反引号的行内正则，人按自然写法写规格
  // （`- src/foo.hpp`，不带反引号）时写集就是空的 —— 与 scope.ts 的行为分叉。
  const cliWritesProvided = cliWrites.length > 0;
  const writes: string[] = cliWritesProvided ? [] : parseScopePaths(content);
  const requirements: string[] = parseAcceptanceCriteria(content);

  // Detect baseline slices (v0- prefix)
  const isBaseline = id.startsWith('v0-');

  // Auto-detect traceWaiver for non-TypeScript projects
  const hasTypeScriptFiles = writes.some((w) => w.endsWith('.ts') || w.endsWith('.tsx') || w.includes('.ts'));
  const traceWaiver = isBaseline && !hasTypeScriptFiles ? '基线切片 — 不修改代码，无需契约追踪' : null;

  // 自动探测验收目标（ADR-049）：两种形态都真实存在过 ——
  //   - 目录：`tests/acceptance/<id>/acceptance.test.cjs`（zelto 骨架的形态）
  //   - 文件：`tests/acceptance/<id>.test.ts`（人自己写的形态）
  // 原来只认后者，于是目录形态的切片 trace.tests 恒为空，追溯门禁无从校验。
  const acceptanceCandidates = [
    `tests/acceptance/${id}/acceptance.test.cjs`,
    `tests/acceptance/${id}.test.ts`,
    `tests/acceptance/${id}.test.cjs`,
  ];
  const acceptanceTestPath = acceptanceCandidates.find((p) => existsSync(p));
  const acceptanceTests = acceptanceTestPath ? [acceptanceTestPath] : [];

  const finalWrites = cliWritesProvided ? cliWrites : writes;

  // Auto-detect slice type from write-set
  const sliceType = detectSliceType(finalWrites);

  // 已声明的需求追溯优先于从规格里读出来的（ADR-032 §3.1：声明优先，规格是兜底）
  const finalRequirements = declaredRequirements.length > 0 ? declaredRequirements : requirements;

  const slice = store.create(id, parsedTitle, {
    writes: finalWrites,
    type: sliceType,
    trace: { requirements: finalRequirements, contracts: [], tests: acceptanceTests },
    traceWaiver,
    baseline: isBaseline,
  });

  // Update acceptance.dir if test file detected
  if (acceptanceTestPath) {
    slice.acceptance.dir = acceptanceTestPath;
  }
  await store.write(slice);
  await events.append(id, 'spec.drafted', 'cli', { sliceId: id, title: parsedTitle, specPath, fromSpec: true });

  if (isJson) {
    console.log(JSON.stringify({
      success: true, id, title: parsedTitle, state: slice.state,
      writes: finalWrites, spec: slice.spec.path,
      baseline: isBaseline, traceWaiver,
      requirements: requirements.length,
      acceptanceTest: acceptanceTestPath ?? null,
    }));
    return 0;
  }

  console.log(`zelto create ${id} — ✅ Created from spec (${specPath})`);
  console.log(`  ID:       ${id}`);
  console.log(`  Title:    ${parsedTitle}`);
  console.log(`  State:    ${slice.state}`);
  console.log(`  Baseline: ${isBaseline ? '✅ (v0- prefix detected)' : 'no'}`);
  console.log(`  Writes:   ${finalWrites.length > 0 ? finalWrites.join(', ') : '(none — add with --writes)'}`);
  console.log(`  Reqs:     ${finalRequirements.length} ${declaredRequirements.length > 0 ? 'declared' : 'parsed from spec'}`);
  if (acceptanceTestPath) console.log(`  Accept:   ✅ ${acceptanceTestPath}`);
  if (traceWaiver) console.log(`  Waiver:   ${traceWaiver}`);
  console.log(`  Spec:     ${slice.spec.path}`);
  console.log(`  Next:     zelto check ${id} && zelto freeze ${id}`);
  return 0;
}

// ─── check ───────────────────────────────────────────────────────────────────

register('check', async (args) => {
  const [id] = args;
  if (!id) {
    console.error('Usage: zelto check <slice-id>');
    return 1;
  }

  const isJson = args.includes('--json');

  try {
    const slice = await store.read(id);

    // For completed/abandoned slices, just show state without warnings
    if (slice.state === 'completed' || slice.state === 'abandoned') {
      if (isJson) {
        console.log(JSON.stringify({
          sliceId: id, state: slice.state, passed: true,
          issues: [], message: `Slice is ${slice.state} — no checks needed`,
        }));
      } else {
        console.log(`zelto check ${id} — ✅ Slice is ${slice.state}, no checks needed.`);
        console.log(`  Use --retry with gate to re-run, or "zelto slice ${id}" for details.`);
      }
      return 0;
    }

    console.log(`zelto check ${id} — running gate① checks...`);
    console.log(`  Slice:   ${slice.title}`);
    console.log(`  State:   ${slice.state}`);
    console.log(`  Spec:    ${slice.spec.path}`);
    const waiverNote = slice.traceWaiver ? ` (waived: ${slice.traceWaiver})` : '';

    // 追溯判据要与 `freeze` 同源（ADR-032 §3.3）。
    // freeze 会先从规格的「验收标准」/「需求」物化需求追溯再判定；check 若
    // 直接拿未物化的 slice.trace 判，就会报出 freeze 根本不拦的假阻断
    // （规格里明明写了编号验收标准，check 仍说「No requirements traced」）。
    let specContent = '';
    try {
      specContent = await readFile(slice.spec.path, 'utf-8');
    } catch {
      specContent = '';
    }
    const freezeGate = evaluateFreezeTrace(slice, specContent);

    console.log(`  Traces:  ${freezeGate.requirements.length} reqs, ${slice.trace.contracts.length} contracts${waiverNote}, ${slice.trace.tests.length} tests`);
    if (freezeGate.requirements.length > slice.trace.requirements.length) {
      console.log(`          (${freezeGate.requirements.length} reqs materialized from spec — written on freeze)`);
    }

    const issues: string[] = [];
    const advisories: string[] = [];
    // 追溯判据唯一真源：core/trace/judgment.ts —— 这里只做呈现翻译
    // 阻断项（blocking）决定退出码；提示项（advisory）只提示，不阻断（ADR-032 §3.2）
    const traceJudgment = judgeTrace({
      trace: traceCountsOf({ ...slice.trace, requirements: freezeGate.requirements }),
      waiver: slice.traceWaiver,
    });
    for (const v of freezeGate.blocking) issues.push(v.short);
    for (const v of advisoryViolations(traceJudgment)) advisories.push(v.short);
    if (slice.drift.detected) issues.push(`Drift detected: ${slice.drift.reason}`);

    // 写集判定（ADR-042 §3.1）：
    //   - 写集写进保护域 / 逃出项目根 → 阻断（跑之前就注定跑不起来）
    //   - 写集路径还不存在 → 提示（那是 agent 要**新建**的文件，
    //     不是错误；原来这里直接阻断，导致「新建文件型切片」永远过不了门禁①）
    if (slice.writes.length > 0) {
      const writeSetResult = evaluateWriteSet({
        writes: slice.writes,
        projectRoot: process.cwd(),
      });
      for (const issue of writeSetResult.issues) issues.push(issue);
      for (const advisory of writeSetResult.advisories) advisories.push(advisory);
      if (writeSetResult.toCreate.length > 0) {
        console.log(
          `  New files: ${writeSetResult.toCreate.length} path(s) will be created by the agent`,
        );
      }
      for (const nm of writeSetResult.nearMisses) {
        console.log(
          `  ⚠️  Write-set path "${nm.path}" does not exist; same-name file(s) at: ${nm.candidates.join(', ')}`,
        );
      }

      // 写集 × 策略的交集判定（实测于 nimrtc-zelto v2-ai-decision）：
      //   写集声明的路径如果完全不在 policy.yaml 的允许规则覆盖范围内，
      //   agent 第一次写文件就会被 hook 按 default 拒绝 —— 这片**注定跑不起来**。
      //   门禁①存在的意义正是「跑之前就确定跑不起来就别跑」，所以这是阻断项。
      //
      // 用**有效写集**（解析后的），不是 slice.writes —— 写集有三级来源
      // （slice.writes → 规格「范围」章节 → 目录探测），只看 slice.writes
      // 会让「写集由规格推导出来」的正常切片漏判。与 run / freeze 同口径。
      const effectiveWrites = await resolveWriteSet(id, false).then(
        (r) => r.writes,
        () => slice.writes,
      );
      const policyVerdict = await precheckWriteSetAgainstPolicy(id, effectiveWrites);
      for (const d of policyVerdict.details) issues.push(d);
      for (const a of policyVerdict.advisories) advisories.push(a);
    }

    // Validate acceptance test path exists
    // 提示级而不是阻断级：验收测试跑不跑得通是门禁②的事（ADR-032 §3.2），
    // 门禁①只管「追溯到没追溯」与「规格写没写清楚」。
    if (slice.acceptance.dir && !slice.acceptance.dir.includes('*') && slice.state !== 'draft') {
      const acceptPath = slice.acceptance.dir.endsWith('/')
        ? slice.acceptance.dir.slice(0, -1)
        : slice.acceptance.dir;
      if (!existsSync(acceptPath) && !existsSync(`${acceptPath}.test.ts`)) {
        advisories.push(`Acceptance test path not found: ${slice.acceptance.dir}`);
      }
    }

    // 规格引擎接线（ADR-032 §3.4）：
    //   - 确定性判据（validateDeterministic）：error 阻断、warning 提示
    //   - 语义启发式（analyzeSemantic）：只提示、不阻断（C7：语义分析不参与判定）
    // 「追溯」与「哈希」两类由上面的追溯判定与哈希比对负责，这里跳过避免重复报。
    // specContent 已在上面读过（追溯物化要用它）。
    if (specContent) {
      for (const issue of validateDeterministic(slice, specContent).issues) {
        if (issue.category === 'trace' || issue.category === 'hash') continue;
        const line = `${issue.message} — ${issue.suggestion ?? ''}`.trim();
        if (issue.severity === 'error') issues.push(line);
        else advisories.push(line);
      }
      for (const issue of analyzeSemantic(slice, specContent).issues) {
        advisories.push(`${issue.message} — ${issue.suggestion ?? ''}`.trim());
      }
    }

    if (slice.spec.frozenHash) {
      const currentHash = hashSpecFile(slice.spec.path);
      if (currentHash && currentHash !== slice.spec.frozenHash) {
        issues.push('Spec file has changed since freeze (hash mismatch)');
        await events.append(id, 'slice.drift_detected', 'cli', {
          sliceId: id, expectedHash: slice.spec.frozenHash, actualHash: currentHash,
          reason: 'Spec file hash mismatch after freeze',
        });
      } else if (!currentHash) {
        issues.push('Spec file not found');
      } else {
        console.log(`  Spec hash: ✅ ${slice.spec.frozenHash.slice(0, 12)}...`);
      }
    }

    await events.append(id, 'spec.checked', 'cli', {
      sliceId: id, issues: issues.length, passed: issues.length === 0, details: issues,
    });

    if (isJson) {
      console.log(JSON.stringify({
        sliceId: id, state: slice.state, passed: issues.length === 0,
        issues, traces: slice.trace, advisories,
      }));
      return issues.length === 0 ? 0 : 1;
    }

    for (const a of advisories) {
      console.log(`  Warn:    ${a}`);
    }

    if (issues.length === 0) {
      console.log('  Result:  ✅ All checks passed');
    } else if (slice.state === 'frozen') {
      console.log(`  Issues:  ${issues.join(', ')}`);
      console.log('  Result:  ❌ Fix issues before gate');
    } else {
      console.log(`  Issues:  ${issues.join(', ')}`);
      console.log('  Result:  ❌ Fix issues before freezing');
    }
    // 门禁①的退出码：有问题 = 1（ADR-032 §3.2）。
    // 文本模式以前永远返回 0，脚本与 hook 串不起来——那是 bug，不是语义。
    return issues.length === 0 ? 0 : 1;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isJson) {
      console.log(JSON.stringify({ sliceId: id, error: msg }));
    } else {
      console.error(`Error reading slice "${id}": ${msg}`);
    }
    return 1;
  }
  return 0;
});

// ─── clarify ─────────────────────────────────────────────────────────────────

register('clarify', async (args) => {
  const [id] = args;
  if (!id || id.startsWith('--')) {
    console.error('Usage: zelto clarify <slice-id> [--auto] [--dry-run]');
    return 1;
  }

  const isAuto = args.includes('--auto');
  const isDryRun = args.includes('--dry-run');

  try {
    const slice = await store.read(id);
    if (slice.state !== 'draft' && slice.state !== 'clarifying') {
      console.error(`Slice "${id}" is in state "${slice.state}". Only draft/clarifying slices can be clarified.`);
      return 1;
    }

    // Create LLM-powered question generator if LLM is configured
    const llm = createLlmFromConfig('clarify', 'cli');
    const llmGenerator: LlmQuestionGenerator | null = llm
      ? async (s, round) => {
          const questions = await generateClarifyQuestions(llm, {
            id: s.id,
            title: s.title,
            writes: s.writes,
            requirements: s.trace.requirements,
            contracts: s.trace.contracts,
            tests: s.trace.tests,
            acceptanceDir: s.acceptance.dir,
            oracleSrc: s.acceptance.oracleSrc,
          }, round);
          if (questions.length === 0) return null;
          return questions.map((q) => ({
            ...q,
            selfAnswered: false,
          }));
        }
      : null;

    const engine = new ClarifyEngine(events, llmGenerator);

    if (slice.state === 'draft') {
      if (!isDryRun) {
        await store.transit(id, 'CLARIFY_START');
        await events.append(id, 'slice.state.changed', 'cli', {
          sliceId: id, from: 'draft', to: 'clarifying', event: 'CLARIFY_START',
        });
        console.log(`zelto clarify ${id} — entering clarification...`);
      } else {
        console.log(`zelto clarify ${id} — dry-run (no changes made)...`);
      }
    } else {
      console.log(`zelto clarify ${id} — continuing clarification...`);
    }

    const current = isDryRun ? slice : await store.read(id);
    // 澄清轮次（ADR-041 §3.1）：轮次号会进澄清问题 ID（`<slice>-<category>-<round>`），
    // 必须单调递增。之前这里读的是 `runs.length` —— 那是「跑过几次」，
    // 和澄清轮次根本不是一回事，于是轮次永远停在第 1 轮，
    // 人澄清了三轮，zelto 还在问第一轮的问题。
    const round = isDryRun
      ? (current.clarifyRounds ?? 0) + 1
      : await store.nextClarifyRound(id);
    // 记住新轮次：下面的 `store.write(current)` 会把整份快照写回去，
    // 不带上这个值就等于把刚记上的轮次抹掉。
    current.clarifyRounds = round;

    if (isAuto || isDryRun) {
      const result = await engine.generateQuestions(current, round);

      if (result.converged) {
        console.log('  ✅ No open questions — slice is already complete.');
        return 0;
      }

      console.log(`  Questions: ${result.questions.length}`);
      for (const q of result.questions) {
        console.log(`    [${q.id}] ${q.text}`);
        console.log(`           Default: ${q.default}`);
      }

      if (isDryRun) {
        console.log(`\n  Run without --dry-run to auto-answer with defaults.`);
        return 0;
      }

      for (const q of result.questions) {
        const answer = { questionId: q.id, answer: q.default, answeredBy: 'zelto' };
        engine.applyAnswers(current, [answer]);
        await events.append(id, 'clarify.answer', 'zelto', {
          questionId: q.id, answer: q.default, selfAnswered: true,
        });
      }

      await store.write(current);
      console.log(`  ✅ All questions auto-answered.`);

      await store.transit(id, 'CLARIFY_CONVERGED');
      await events.append(id, 'slice.state.changed', 'cli', {
        sliceId: id, from: 'clarifying', to: 'draft', event: 'CLARIFY_CONVERGED',
      });
      const afterConverge = await store.read(id);

      const specHash = hashSpecFile(afterConverge.spec.path);
      afterConverge.spec.frozenHash = specHash ?? `sha256:${Date.now()}`;
      afterConverge.spec.frozenAt = new Date().toISOString();
      afterConverge.spec.boundaryHash = computeBoundaryHash(afterConverge);
      await store.write(afterConverge);
      await store.transit(id, 'FREEZE');
      await events.append(id, 'spec.frozen', 'zelto', {
        sliceId: id, frozenHash: afterConverge.spec.frozenHash, boundaryHash: afterConverge.spec.boundaryHash, frozenAt: afterConverge.spec.frozenAt,
      });

      console.log(`  ✅ Slice frozen at ${afterConverge.spec.frozenAt}`);
      console.log(`  Next: zelto run ${id} --dry-run`);
      return 0;
    }

    // Interactive mode
    const result = await engine.generateQuestions(current, round);

    if (result.converged) {
        console.log('  ✅ No open questions — slice is already complete.');
      return 0;
    }

    console.log('');
    const answers: Array<{ questionId: string; answer: string; answeredBy: string }> = [];

    for (let i = 0; i < result.questions.length; i++) {
      const q = result.questions[i];
      console.log(`  ${i + 1}/${result.questions.length}: ${q.text}`);
      console.log(`    Candidates: ${q.candidates.join(', ')}`);
      console.log(`    Default: ${q.default}`);
      console.log(`    Impact: ${q.impact}, Reversibility: ${q.reversibility}`);

      if (!process.stdout.isTTY) {
        console.log(`    → Using default (non-TTY): ${q.default}`);
        answers.push({ questionId: q.id, answer: q.default, answeredBy: 'zelto' });
      } else {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const input = await new Promise<string>((resolve) => {
          rl.question('    > ', resolve);
        });
        rl.close();
        const chosen = input.trim() || q.default;
        answers.push({ questionId: q.id, answer: chosen, answeredBy: 'human' });
      }
      console.log('');
    }

    engine.applyAnswers(current, answers);
    await store.write(current);

    for (const a of answers) {
      await events.append(id, 'clarify.answer', a.answeredBy, {
        questionId: a.questionId, answer: a.answer,
      });
    }

    console.log(`  ✅ All questions answered.`);

    await store.transit(id, 'CLARIFY_CONVERGED');
    const afterConverge = await store.read(id);

    const specHash = hashSpecFile(afterConverge.spec.path);
    afterConverge.spec.frozenHash = specHash ?? `sha256:${Date.now()}`;
    afterConverge.spec.frozenAt = new Date().toISOString();
    afterConverge.spec.boundaryHash = computeBoundaryHash(afterConverge);
    await store.write(afterConverge);
    await store.transit(id, 'FREEZE');
    await events.append(id, 'spec.frozen', 'human', {
      sliceId: id, frozenHash: afterConverge.spec.frozenHash, boundaryHash: afterConverge.spec.boundaryHash, frozenAt: afterConverge.spec.frozenAt,
    });

      console.log(`  ✅ Slice frozen at ${afterConverge.spec.frozenAt}`);
    console.log(`  Next: zelto run ${id} --dry-run`);
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error clarifying slice "${id}": ${msg}`);
    return 1;
  }
});

// ─── abandon ─────────────────────────────────────────────────────────────────

register('abandon', async (args) => {
  const [id] = args;
  if (!id || id.startsWith('--')) {
    console.error('Usage: zelto abandon <slice-id>');
    return 1;
  }

  try {
    const slice = await store.read(id);
    if (slice.state === 'abandoned') {
      console.error(`Slice "${id}" is already abandoned.`);
      return 1;
    }

    const prevState = slice.state;
    await store.transit(id, 'ABANDON');

    await events.append(id, 'slice.state.changed', 'cli', {
      sliceId: id, from: prevState, to: 'abandoned', event: 'ABANDON',
    });

    // Remove the isolated worktree (if any) — failures are reported, not swallowed
    if (worktreeManager().exists(id)) {
      try {
        await removeWorktree(id, { force: true });
        console.log(`  Worktree:   removed (${worktreeManager().relativePathFor(id)})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ??  Worktree removal failed: ${msg}`);
        // ZD-016：补救命令必须**真的能删掉目录**（详见 merge-runner.ts 里的说明）。
        console.error(`     If git still tracks it:  git worktree remove --force ${worktreeManager().pathFor(id)}`);
        console.error(`     Or delete the directory:  rmdir /s /q "${worktreeManager().pathFor(id)}"`);
      }
    }

    console.log(`zelto abandon ${id} — ✅ Slice abandoned`);
    console.log(`  Previous state: ${prevState}`);
    console.log(`  Now:            abandoned`);
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error abandoning slice "${id}": ${msg}`);
    return 1;
  }
});

// ─── freeze ──────────────────────────────────────────────────────────────────

register('freeze', async (args) => {
  const [id] = args;
  if (!id) {
    console.error('Usage: zelto freeze <slice-id> [--refreeze]');
    return 1;
  }

  const isJson = args.includes('--json');
  // --refreeze：允许对已冻结的切片重新冻结。
  //
  // 为什么需要：规格冻结之后人可能还要改它——最常见的是**写集越界之后
  // 扩写集**（写集写在规格的「范围」章节里，改规格 = 改哈希）。
  // 没有这条路径，那个切片就永久卡住：check 报 hash mismatch，
  // freeze 又说「已经是 frozen，不能 freeze」。
  const isRefreeze = args.includes('--refreeze');

  try {
    // ADR-086：冻结编排下沉到 core/lifecycle/freeze.ts ——
    // Web 端与 CLI 端调**同一份**编排（判定不许分叉，C3）。
    //
    // 注意这里**不再**先跑 `resolveWriteSet(id)`（旧 CLI 会把从规格
    // 解析出的写集**写回切片文件**）。那个写回是有害的：
    //
    //   首次 freeze  → 写集被固化成 `['src/a.js']` 落进 slice 文件
    //   改规格扩写集 → 再 freeze 时 `slice.writes.length > 0`，
    //                   解析链直接短路，**新写的路径看不见了**
    //   结果          → 409「规格与写集不一致」，切片永久卡住
    //
    // 编排层里的 `resolveEffectiveWrites` 按**同一口径**三级取值
    // （slice.writes → 规格「范围」→ 目录探测），但**不落盘** ——
    // 「有效写集」是判定输入，不该在判定途中把状态改了（C1）。
    const outcome = await freezeSlice(
      {
        repoRoot: process.cwd(),
        store,
        events,
        actor: 'cli',
        via: 'cli',
      },
      id,
      { refreeze: isRefreeze },
    );

    if (!outcome.ok) {
      if (isJson) {
        console.log(JSON.stringify({
          sliceId: id, success: false,
          error: outcome.reason,
          issues: outcome.details,
        }));
      } else {
        console.error(`zelto freeze ${id} — ❌ ${outcome.reason}`);
        for (const d of outcome.details) console.error(`  - ${d}`);
        if (outcome.details.length > 0) console.error('');
        // 提示项也要打出来 —— 「已冻结，需 --refreeze」这类修法
        // 就住在 advisories 里（details 只装阻断项）。
        // 不打出来 = 人只看到「不行」，不知道下一步该敲什么。
        for (const a of outcome.advisories) console.error(`  ⚠ ${a}`);
        // 逐类阻断给出**可操作的修法** —— 只说「不行」等于把人赶走。
        if (outcome.reason.includes('\u7b56\u7565')) {
          console.error('  \u51bb\u7ed3\u4e00\u4e2a\u6ce8\u5b9a\u8dd1\u4e0d\u8d77\u6765\u7684\u57fa\u7ebf\u6ca1\u6709\u610f\u4e49 \u2014\u2014 \u540e\u9762\u6bcf\u4e00\u6761\u4e8b\u4ef6\u90fd\u4f1a\u6307\u5411\u5b83\u3002');
          console.error('  \u4fee\u6cd5\u4e8c\u9009\u4e00\uff1a');
          console.error('    - \u628a\u8be5\u8def\u5f84\u52a0\u8fdb policy.yaml \u7684 allow \u89c4\u5219\uff08\u4e4b\u540e\u8dd1 zelto policy lock --update \u66f4\u65b0\u951a\u70b9\uff09');
          console.error(`    - \u6216\u6539\u5199\u96c6\uff1a zelto set ${id} --field writes --value "<\u8def\u5f84>"`);
        } else if (outcome.reason.includes('\u5199\u96c6')) {
          console.error(`  \u628a\u8fd9\u4e9b\u6587\u4ef6\u52a0\u8fdb\u5199\u96c6\uff1a zelto set ${id} --field writes --value "<\u8def\u5f84>"`);
          console.error('  \u6216\u6539\u89c4\u683c\uff1a\u4e0d\u8981\u63d0\u8fd9\u4e9b\u6587\u4ef6\uff08\u6216\u5728\u300c\u8303\u56f4\u300d\u7ae0\u8282\u58f0\u660e\u5b83\u4eec\uff09');
        } else if (outcome.reason.includes('\u8ffd\u6eaf')) {
          console.error('  \u5728\u89c4\u683c\u91cc\u5199\u300c## \u9a8c\u6536\u6807\u51c6\u300d\uff08\u7f16\u53f7\u6761\u76ee\uff09\u2192 zelto \u4f1a\u81ea\u52a8\u7269\u5316\u6210\u9700\u6c42\u8ffd\u6eaf');
          console.error('  \u6216\u663e\u5f0f\u58f0\u660e\u9700\u6c42\u8ffd\u6eaf\uff1a zelto set <id> --field trace.requirements --value "<\u9700\u6c42\u5f15\u7528>"');
          console.error('  \u6216\u5199\u660e\u8c41\u514d\u7406\u7531\uff1a zelto set <id> --field traceWaiver --value "<\u7406\u7531>"');
        }
      }
      return 1;
    }

    const facts = (outcome.facts ?? {}) as {
      frozenHash?: string;
      frozenAt?: string;
    };
    if (isJson) {
      console.log(JSON.stringify({
        sliceId: id, success: true, state: 'frozen',
        frozenHash: facts.frozenHash, frozenAt: facts.frozenAt,
      }));
    } else {
      console.log(`zelto freeze ${id} — \u2705 Slice frozen at ${facts.frozenAt}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isJson) {
      console.log(JSON.stringify({ sliceId: id, success: false, error: msg }));
    } else {
      console.error(`Error freezing slice "${id}": ${msg}`);
    }
    return 1;
  }
  return 0;
});

// ─── run ─────────────────────────────────────────────────────────────────────

register('run', async (args) => {
  // `--help` 只读说明，不能进执行 —— 不拦住的话 `--help` 会被当成切片 id 去跑
  if (args.includes('--help') || args.includes('-h')) {
    console.error('Usage: zelto run <slice-id> [--agent <name>] [--adapter <type>] [--dry-run]');
    console.error('       --adapter: claude-agent (默认) | claude-agent-sdk | cursor-agent');
    console.error('       zelto run --parallel <id1> [id2 ...] [--agent <name>]');
    console.error('       zelto run --hotfix <slice-id> [--agent <name>]');
    console.error('       zelto run <slice-id> --detach [--json]');
    return 0;
  }
  // Dispatch to parallel runner if --parallel flag is present
  if (args.includes('--parallel')) {
    return runParallel(args);
  }

  const [id] = args;
  if (!id) {
    console.error('Usage: zelto run <slice-id> [--agent <name>] [--adapter <type>] [--dry-run]');
    console.error('       --adapter: claude-agent (默认) | claude-agent-sdk | cursor-agent');
    console.error('       zelto run --parallel <id1> [id2 ...] [--agent <name>]');
    console.error('       zelto run --hotfix <slice-id> [--agent <name>]');
    return 1;
  }

  const isHotfix = args.includes('--hotfix');
  const isDetach = args.includes('--detach');

  const isJson = args.includes('--json');

  // hotfix 跳过门禁② —— 等于放弃「签字前必须过门禁」这条约束。
  // 所以必须显式确认（ADR-015 §3.1）：--hotfix 必须配 --yes。
  if (isHotfix && !args.includes('--yes') && !args.includes('-y')) {
    if (isJson) {
      console.log(JSON.stringify({
        sliceId: id,
        error: 'hotfix requires --yes',
        message: 'zelto run <slice-id> --hotfix --yes',
      }));
    } else {
      console.error('zelto run --hotfix 会跳过门禁②（验收测试），并把切片直接置为已签字。');
      console.error('        这等于放弃「签字前必须过门禁」这条约束，所以必须显式确认：');
      console.error('        zelto run <slice-id> --hotfix --yes');
    }
    return 1;
  }

  // 运行时守卫（C9）：预约 + 钩子。离开这个命令时必须释放 ——
  // 除非是 detach 模式，那时由后台监视器接管。
  let guard: RuntimeGuard | null = null;
  let guardTransferred = false;

  try {
    const scheduler = new Scheduler(store, events, loadPolicyConfig());

    // ── 写集 × 策略的预检（最先做的一道）──────────────────────────────────
    //
    // 放在 `admit` **之前**，不是之后 —— 顺序有讲究：
    //   admit 管的是「状态对不对 / 有没有别人在跑同一片」，
    //   写集策略管的是「这片写不进任何文件」，
    //   后者更根本：一个 draft 的切片和一个 frozen 但注定写不起来的切片，
    //   **后者的信息量更大**（它已经被人批准过了，却被策略挡住）。
    //   便宜的判定在前，人才知道真正该修什么。
    //
    // 为什么 run 也要查（check 里早有了，但 check 只是个命令）：
    //   病灶（nimrtc-zelto v2-ai-decision，2026-11-17）：写集不在 policy
    //   允许范围内 → agent 第一次写文件就被 hook 拒 → 换路径再试 → 再被拒
    //   → 30 分钟超时耗尽，worktree 里一个字节都没留下。
    //   `zelto check` 早就报出了这句话，但没人跑 check 就等于没有闸门。
    //   **判定有、闸门没接上** —— 这里把闸门接上。
    const preResolved = await resolveWriteSet(id);
    {
      const verdict = await precheckWriteSetAgainstPolicy(id, preResolved.writes);
      for (const a of verdict.advisories) console.warn(`  ⚠️  ${a}`);
      if (!verdict.ok) {
        if (isJson) {
          console.log(JSON.stringify({
            sliceId: id,
            decision: 'blocked',
            reason: '写集与策略互相矛盾 —— 这片注定跑不起来',
            blockedBy: ['write-set-policy'],
            details: verdict.details,
          }));
        } else {
          console.error(`zelto run ${id} — ❌ 写集与策略互相矛盾，拒绝开跑`);
          for (const d of verdict.details) console.error(`  - ${d}`);
          console.error('');
          console.error('  这片跑不起来：agent 第一次写文件就会被 hook 按 default 拒绝，');
          console.error('  反复重试只会烧 token 直到超时。');
          console.error('');
          console.error('  修法二选一：');
          console.error(`    - 把该路径加进 policy.yaml 的 allow 规则： zelto policy add <rule-id> --path "<路径>" --operation write --action allow --basis "<依据>"`);
          console.error(`    - 或改写集： zelto set ${id} --field writes --value "<路径>"`);
          console.error(`  改完跑 zelto policy lock --update 更新锚点，再 zelto check ${id} 确认。`);
        }
        return 1;
      }
    }

    const result = await scheduler.admit(id);
    if (result.decision !== 'admitted') {
      if (isJson) {
        console.log(JSON.stringify({ sliceId: id, decision: 'blocked', reason: result.reason, blockedBy: result.blockedBy }));
      } else {
        console.error(`zelto run ${id} — ❌ Cannot run: ${result.reason}`);
        if (result.blockedBy.length > 0) {
          console.error(`  Blocked by: ${result.blockedBy.join(', ')}`);
        }
      }
      return 1;
    }

    // Resolve write-set: slice.writes → spec 「范围」 → detectDefaultWrites()
    const resolved = preResolved;
    if (resolved.changed) {
      console.log(
        resolved.source === 'spec'
          ? `  Write-set (from spec):  ${resolved.writes.join(', ')}`
          : `  Auto-detected write-set: ${resolved.writes.join(', ')}`,
      );
    }
    if (resolved.writes.length === 0) {
        console.warn('  ⚠️  No write-set detected — agent will have no files to modify');
    }

    // Re-read so the constraint bundle carries the resolved write-set
    const slice = await store.read(id);

    // Check budget before starting run
    // `checkBudget` 内部已经打印统一措辞（并写 stall.classified 事件）
    const budgetOk = await checkBudget(id);
    if (!budgetOk) {
      return 1;
    }

    const isDryRun = args.includes('--dry-run');

    if (isDryRun) {
      const bundle = scheduler.buildConstraints(
        slice,
        null,
        gateCommandsForSlice(slice),
        await scheduler.readFeedbackFor(id),
      );
      if (isJson) {
        console.log(JSON.stringify({
          sliceId: id, decision: 'admitted', dryRun: true,
          spec: bundle.specPath, frozenHash: bundle.frozenHash,
          writes: bundle.writes, policyRules: bundle.policyRules.length,
        }));
      } else {
        console.log(`zelto run ${id} — ✅ Would admit (dry-run)`);
        console.log(`  Spec:          ${bundle.specPath}`);
        console.log(`  Frozen hash:   ${bundle.frozenHash}`);
        console.log(`  Write-set:     ${bundle.writes.join(', ') || '(none)'}`);
        console.log(`  Policy rules:  ${bundle.policyRules.length}`);
        console.log(`  Instructions:  ${bundle.instructions.split('\n').length} lines`);
      }
      return 0;
    }

    await scheduler.startRun(id);

    // ── 重复 agent 守卫 ──────────────────────────────────────────────────
    // 这片之前已经有 agent 在跑 → 拒绝再起一个。
    //
    // 病灶（实测于 nimrtc-zelto v2-input-binder，2026-11-17）：
    //   活性判定按外层 `cmd.exe` 的 pid 判进程死活，而真正的 agent
    //   （claude.exe）是它的孙进程。外层退出后 agent 还活着，
    //   判定却说是「死了」→ 重跑 → **同一个 worktree 上起了第二个 agent**，
    //   两个 agent 互相覆盖产出，谁的成果都留不下。
    //
    // 判据：查会话文件里最新的那条，用「整棵进程树」判活。
    // 树还活着 → 拒绝并说清是谁在跑。
    {
      const rec = readSliceLivenessRecord(process.cwd(), id);
      if (rec) {
        const live = await classifyLivenessAsync(rec, { isProcessAlive, isProcessTreeAlive });
        if (live.state === 'active' || live.state === 'stale') {
          const msg =
            `切片 "${id}" 已经有一个 agent 在运行（${live.reason}）—— ` +
            `拒绝再起一个（两个 agent 会抢同一个 worktree）。` +
            `先确认它是否真的还活着：zelto status`;
          if (isJson) {
            console.log(JSON.stringify({ sliceId: id, decision: 'blocked', reason: msg }));
          } else {
            console.error(`zelto run ${id} — ❌ ${msg}`);
          }
          // 守卫拒绝时 agent **一个都没起** —— 切片必须退回 `frozen`（D-64/D-65）。
          //
          // 病灶（实测于 nimrtc-v14 v1-n5-turn-server，2026-11-20）：
          //   `startRun` 把切片推到 `running` → 重复 agent 守卫命中（上一轮
          //   的遗留会话记录还在）→ 直接 `return 1`，**没退状态**。
          //   于是这片卡在 `running`，而四条路全堵死：
          //     - `run` 拒绝跑（准入只认 frozen / completed）
          //     - `merge` 不收它（没签字）
          //     - `stall --reap` 看不见它（这一轮**有**会话文件，
          //       所以不是「一条记录都没有」的空壳；但那条记录的 status
          //       已是 `completed` → 活性判定 `finished` → 也不算 stale/dead）
          //     - `resume` 说它没停机（stall.class 是 null）
          //   唯一出路是 `abandon` —— 整个切片作废，规格得重写。
          //
          // 也就是说「撞上一个假活记录」= 切片作废。这不是设计意图。
          await revertRunAbortedBeforeStart(id, { reason: `重复 agent 守卫拒绝：${live.reason}` });
          return 1;
        }
      }
    }

    // 上一轮的失败证据（ZD-013）：重跑时 agent 必须知道上次错在哪，
    // 否则它只能从头摸，而且可能把已经做对的东西改错。
    const gateFeedback = await scheduler.readFeedbackFor(id);

    const bundle = scheduler.buildConstraints(slice, null, gateCommandsForSlice(slice), gateFeedback);
    console.log(`zelto run ${id} — ✅ Admitted and starting execution...`);
    console.log(`  Write-set:     ${bundle.writes.join(', ') || '(none)'}`);
    console.log(`  Protected:     ${bundle.protectedPaths.join(', ')}`);
    console.log(`  Policy rules:  ${bundle.policyRules.length}`);
    if (gateFeedback.length > 0) {
      console.log(`  Last failure:  ${gateFeedback.length} item(s) — passing the evidence to the agent`);
    }

    const bundlePath = join(ZELTO_DIR, `${id}-bundle.json`);
    writeFileSync(bundlePath, JSON.stringify(bundle, null, 2), 'utf-8');

    // Isolated worktree for this slice — the main working tree is never touched.
    // Not inside a git repo → no isolation possible, degrade to the current directory.
    let worktree: WorktreeInfo | null = null;
    try {
      worktree = await ensureWorktree(id);
      if (worktree) {
        console.log(`  Worktree:      ${worktree.relativePath}`);
        console.log(`  Branch:        ${worktree.branch}`);

        // Mirror the bundle into the worktree so the agent sees it under its own cwd
        const wtBundleDir = join(worktree.path, ZELTO_DIR);
        if (!existsSync(wtBundleDir)) mkdirSync(wtBundleDir, { recursive: true });
        writeFileSync(join(wtBundleDir, `${id}-bundle.json`), JSON.stringify(bundle, null, 2), 'utf-8');

        // submodule 没同步上 —— 必须**说出来**。
        //
        // 为什么不能静默：同步失败原本被 `catch {}` 吞掉，于是「worktree 里
        // 少了 12 个 vendor」完全不显形 —— 等到门禁报「找不到 googletest」，
        // 人看到的是源码缺失，跟「隔离目录没同步 vendor」毫无关系
        // （ADR-044 记的就是这个病灶）。现在把原因直接摆出来。
        const failures = worktreeManager().submoduleFailures;
        if (failures.length > 0) {
          console.error(`  ⚠️  ${failures.length} 个 submodule 没能同步到 worktree：`);
          for (const f of failures.slice(0, 8)) {
            console.error(`     · ${f.path}：${f.reason}`);
          }
          if (failures.length > 8) {
            console.error(`     … 还有 ${failures.length - 8} 个`);
          }
          console.error('     这些依赖在 worktree 里可能是空的 —— 门禁可能会因此失败。');
        }
      } else {
        console.log(`  Worktree:      (none — not a git repository, running in current directory)`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ❌ 无法创建隔离 worktree: ${msg}`);
      // 切片已经在 `startRun` 时被推到 `running` —— 但 agent 还没起。
      // 不退回 `frozen` 的话，这片就**没人能救**：
      //   - `zelto run` 拒绝跑（准入只认 frozen / completed）
      //   - `zelto merge` 不收它（没签字）
      //   - `zelto stall --reap` 看不见它（连会话文件都没写，
      //     `classifyLiveness(null)` 返回 finished → 不算空壳）
      //   - 唯一出路是 `zelto abandon` —— 整个切片作废，规格得重写
      //
      // 也就是「环境抖一下，切片就废了」（D-64 同款病灶）。
      // 这里退回 frozen：这一轮不算数，但可以再跑。
      await revertRunAbortedBeforeStart(id, { reason: `无法创建隔离 worktree: ${msg}` });
      return 1;
    }

    const cfg = loadConfig();
    const adapterType = optionValueStrict(args, '--adapter');
    const agentCmd = cfg.agent.command;

    // D-2：`--agent` 没给值时回退到配置里的默认 agent，
    // 而不是把 undefined 当成「用户指定的值」传下去。
    //
    // **adapter 决定默认命令**：Cursor 侧的默认命令是 `cursor-agent`，
    // 不是配置里那个 `npx claude-code` —— 复用它会起一个 claude 进程，
    // 表面上「跑的是 Cursor」，实际跑的是 Claude。
    const agentName = optionValue(
      args,
      '--agent',
      resolveAgentCommand(adapterType ?? cfg.agent.adapter, undefined, cfg),
    );

    console.log(`  Agent:         ${agentName}`);
    console.log(`  Bundle:        ${bundlePath}`);
    console.log('');

    // Check agent availability before starting
    //
    // 用**与 adapter 无关**的检查（ADR-086 抽出来的 agent-command.ts）：
    // Claude、Cursor、Codex 查的都是同一件事 —— 这条命令找不找得到。
    // 之前这里用的是 Claude 适配器的静态方法，
    // 对 Cursor 拿 `cursor-agent` 去问「claude 在吗」，答案永远是「不在」。
    try {
      const { checkAgentAvailable } = await import('../../adapters/agent-command.js');
      const agentError = await checkAgentAvailable(agentName, agentCmd);
      if (agentError) {
        console.error(`  ❌ ${agentError}`);
        // agent 命令都找不到 → 这一轮一定跑不成。切片已被 `startRun`
        // 推到 `running`，退回 `frozen`（D-64 同款病灶）。
        await revertRunAbortedBeforeStart(id, { reason: agentError });
        return 1;
      }
    } catch {
      // 检查本身失败不该拦住运行 —— 起了就知道了。
    }

    // Show progress spinner during execution
    let startTime = Date.now();
    let progressTimer: ReturnType<typeof setInterval> | null = null;

    const sliceData = await store.read(id);
    const agentTimeout = sliceData.agentTimeout;
    const workDir = worktree?.path ?? process.cwd();

    // ── Detach mode: 把整个运行交给独立进程 ────────────────────────────
    //
    // D-50：**监视器必须是独立进程**，而且不只是「等 agent 结束」那一段。
    //
    // 原来的做法是「主进程里一个没 await 的 Promise」——
    // 主进程 `process.exit()` 时它跟着死，于是：
    //   - agent 变孤儿（还在改文件、还在烧 token）；
    //   - 没人跑写集审计 → 越界写入不会被发现；
    //   - 没人跑门禁 → 没有签字请求 → 切片永远卡在 frozen；
    //   - 没人释放写集预约 → 下一片撞写集冲突；
    //   - 适配器住在主进程里 → agent 退出时**没人记录退出码**。
    //
    // 人看到的是「切片在跑」，实际是**一个没人管的孤儿 agent**。
    //
    // 所以 detach 模式下，主进程只做**准入与准备**（解析写集、建 worktree、
    // 拉起监督进程），**不起 agent、不装守卫** —— 那些都在监督进程里做。
    // 谁装守卫谁放守卫，才不会漏（C9）。
    if (isDetach) {
      const taskId = `task-${id}-${Date.now()}`;
      const taskInfo: TaskInfo = {
        taskId,
        sliceId: id,
        // 监督进程会起自己的会话 —— 这里先占位，等监督进程写回
        sessionId: '',
        agentName,
        startedAt: new Date().toISOString(),
        status: 'running' as const,
      };

      // 任务文件**先写后拉**监督进程：
      //
      // 顺序很重要（D-53）：监督进程起 agent 后会立刻往任务文件写 sessionId。
      // 如果主进程在监督进程之后才 `saveTask`（整份覆盖），它手里那份
      // 「sessionId: ''」的旧快照会把监督进程刚写的真会话 id 冲掉。
      // 所以顺序是：写任务文件 → 拉监督进程 → 只**补**两个字段（不覆盖别的）。
      taskInfo.supervisorLog = supervisorLogPath(process.cwd(), taskId);
      taskInfo.lastActivityAt = taskInfo.startedAt;
      saveTask(taskInfo);

      // 拉起独立监督进程
      //
      // D-53：`spawnSupervisor` 现在**做启动存活确认** —— 监督进程如果参数
      // 不全、入口缺失，会在一秒内退出，而这里已经打算告诉人「已在后台跑」。
      // 那种情况下界面显示 running、实际一个 agent 都没起 —— 最坏的假象。
      // 所以这里必须拿到「确实活着」的确认，拿不到就把原因原样交回。
      const launch = await spawnSupervisor({
        projectRoot: process.cwd(),
        taskId,
        sliceId: id,
        sessionId: '',
        agentCommand: agentName,
        workDir,
        timeoutMs: (agentTimeout ?? loadConfig().agent.timeout ?? 1800) * 1000,
        isHotfix,
        adapterType,
      });

      if (!launch.ok) {
        // 监督进程没起来 → 没人跑这一轮 → 不能假装「已经在后台跑了」——
        // 那是把「没人管」说成「有人在管」。
        console.error(`zelto run ${id} — ❌ 无法拉起后台监督进程，这一轮没有在后台跑`);
        console.error(`     ${launch.reason}`);
        console.error(`     监督进程入口：${supervisorEntryPath()}`);
        console.error(`     请改用前台运行： zelto run ${id}`);
        // 切片已经被 `startRun` 推到 `running`，但这一轮没人跑 ——
        // 退回 `frozen`（D-64 同款病灶），否则这片没人能救。
        await revertRunAbortedBeforeStart(id, { reason: `无法拉起后台监督进程: ${launch.reason}` });
        return 1;
      }

      // 只补 pid —— 不整份覆盖（会把监督进程写的 sessionId 冲掉，D-53）
      patchTask(taskId, { supervisorPid: launch.pid });

      console.log(`zelto run ${id} — ✅ Detached (task: ${taskId})`);
      console.log(`  Supervisor: pid ${launch.pid}（独立进程：起 agent + 等它结束 + 写收尾）`);
      console.log(`  Run: zelto status ${taskId}`);
      return 0;
    }

    // 运行时守卫（C9）：取写集预约 + 装 PreToolUse 钩子。
    // 钩子装在 agent 真正工作的那个目录里 —— Claude Code 只读 cwd 下的
    // .claude/settings.local.json；预约与策略仍在主仓库（命令行里给了 --project-root）。
    let activeGuard: RuntimeGuard;
    try {
      activeGuard = await installRuntimeGuard({
        sliceId: id,
        writes: bundle.writes,
        worktree: worktree?.path ?? null,
        projectRoot: process.cwd(),
        baseCommit: worktree?.baseCommit ?? null,
        managedPaths: zeltoOwnedPaths(worktree?.path ?? null, slice),
        // 装哪种 harness 的钩子 —— adapter 决定跑的是谁，
        // harness 决定钩子的信封格式（ADR-083）。
        // 配错 = hook 读不懂载荷 = 判定静默失效。
        harness: harnessForAdapter(adapterType ?? cfg.agent.adapter),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ❌ 无法取得写集预约: ${msg}`);
      // agent 还没起（拿不到预约就 fail closed）—— 切片必须退回 frozen，
      // 否则卡在 running 且没人能救（D-64）：
      //   `run` 拒绝跑（准入只认 frozen/completed）、`merge` 不收、
      //   `stall --reap` 看不见（连会话文件都没写）、只能 `abandon`。
      await revertRunAbortedBeforeStart(id, { reason: `无法取得写集预约: ${msg}` });
      return 1;
    }
    guard = activeGuard;
    console.log(`  Reservation:   ${bundle.writes.join(', ') || '(空)'}`);

    let adapter = createExecutorAdapter(adapterType, agentName, agentTimeout, workDir);

    // 活进程看门狗（ADR-074）：记下本轮起跑时刻 —— 它把「本轮的现场」
    // 与「上一代被收走的尸体」分开（见 waitForExitWithWatchdog）
    //
    // **必须在 start 之前**取（D-49）：适配器写会话文件用的 `startedAt`
    // 比这个时刻早，取晚了本轮记录会被世代过滤滤掉 → 看门狗误判「从没开跑」。
    let runStartedAt = new Date().toISOString();
    runGenStartedAt.set(id, runStartedAt);

    let { sessionId } = await adapter.start({ sliceId: id, prompt: bundlePath });

    await events.append(id, 'run.started', 'zelto', {
      sliceId: id, agent: agentName, bundlePath, writes: bundle.writes,
      worktree: worktree?.relativePath ?? null,
    });

    // Start progress display
    progressTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      process.stdout.write(`\r  ??  Agent running... ${mins}m ${secs}s`);
    }, 1000);

    // Retry loop: agent may auto-retry internally (adapter handles transient failures),
    // then handleAgentFailure handles auto-resolvable stalls at the CLI level
    const config = loadConfig();
    const maxRetries = config.agent.maxRetries ?? 2;
    let finalExitCode: number | null = null;
    let attempt = 0;
    let watchdogRecorded = false;
    // 切片是否已经停机过（ADR-047 §2.1.1：停机只做一次）
    let alreadyStalled = false;

    while (attempt <= maxRetries) {
      // 活进程看门狗（ADR-074）：CLI 先死、agent 变孤儿、会话文件换壳……
      // 任何一种「这一轮已经没有进程在管」都在这里当场收走，不再傻等
      const waited = await waitForExitWithWatchdog({
        sliceId: id,
        sessionId,
        adapter,
        runStartedAt,
        maxRetries,
      });
      const exitCode = waited.exitCode;

      // Clear progress display
      if (progressTimer) {
        clearInterval(progressTimer);
        progressTimer = null;
      }
      process.stdout.write('\r' + ' '.repeat(50) + '\r');

      // 看门狗已经写好了停机（退 frozen + 分类 + run.aborted + 记账）——
      // 再走一遍 handleAgentFailure 只会写第二份分类、迁第二次状态。
      if (waited.watchdogReaped) {
        finalExitCode = null;
        watchdogRecorded = true;
        break;
      }

      // ── 被拉闸打断 ──────────────────────────────────────────────────
      //
      // 人喊停之后：停掉 agent、现场保留（worktree / 预约都不动）、
      // 切片退回 frozen —— 人处理完 `zelto halt --clear` 就能重跑。
      //
      // **不记账成失败**：这一轮不是「agent 跑废了」，是「人叫停的」。
      // 记成失败会让人在 run 记录里看到一片红色，而真实原因是一次人为干预。
      if (waited.halted) {
        finalExitCode = null;
        const reason = waited.haltReason ?? '人工拉闸';
        const rollback = await rollbackHaltedSlice(store, events, id, {
          reason,
          scope: id,
          actor: 'human',
        });
        await events.append(id, 'batch.halted', 'human', {
          sliceId: id,
          scope: id,
          reason,
        });
        console.error(`\n⏸️  已拉闸：${reason}`);
        console.error(`   状态: ${rollback.from} → ${rollback.to}（stall: human_halt）`);
        console.error('   现场保留。处理完：zelto halt --clear → zelto resume ' + id + ' → zelto run ' + id);
        break;
      }

      // 记账（ADR-092）：**每次 agent 进程结束 = 一条**，与并行路径同口径。
      // 记在重试判断之前 —— 中间被重试掉的失败尝试也必须在账本里。
      // 计数：attempt 从 0 起算，记录里的 attempt 从 1 起算。
      try {
        await store.recordRun(id, {
          ok: exitCode === 0,
          exitCode,
          phase: 'foreground',
          attempt: attempt + 1,
        });
      } catch { /* 记账失败不阻断 —— 现场比账本重要 */ }

      if (exitCode === 0) {
        finalExitCode = 0;
        break;
      }

      // Agent failed — try auto-retry at CLI level
      await events.append(id, 'run.aborted', 'zelto', { sliceId: id, exitCode });
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      console.log(`\n❌ Agent exited with code ${exitCode} (${elapsed}s)`);

      // 停机只做一次：`handleAgentFailure` 返回 'stall' 时它已经把切片
      // 停机了（退 frozen + 写分类 + 留痕，ADR-047）—— 不要再调一遍，
      // 否则会写两遍事件、迁两次状态。
      let stalled = false;
      if (attempt < maxRetries) {
        const result = await handleAgentFailure(id, exitCode, { maxRetries });
        if (result.action === 'retry') {
          attempt = result.retryCount ?? attempt + 1;          // Re-create adapter and re-start agent for retry
          adapter = createExecutorAdapter(adapterType, agentName, agentTimeout, workDir);
          // 超时重试要**接着上一次跑**，不是从头再来（ADR-055）。
          //
          // 上一次跑超时被杀时，它已经做掉的工作都留在 worktree 里了 ——
          // 从头再跑一遍等于把那些工作重做一遍（编译、跑测试、改代码），
          // 还把 agent 的上下文清零，让它重新摸索一遍已经摸清的东西。
          // 能续就续：同一个 agent 会话（`--resume`），提示它「继续」。
          //
          // 新一轮的「起跑时刻」必须在 start **之前**取（见上面 D-49 的说明）：
          // 世代过滤靠它切分本轮记录与上一代的尸体，取晚了本轮记录会被滤掉。
          runStartedAt = new Date().toISOString();
          runGenStartedAt.set(id, runStartedAt);
          const resumed = await resumeForRetry(adapter, sessionId, id, bundlePath);
          if (resumed) {
            sessionId = resumed;
          } else {
            const started = await adapter.start({ sliceId: id, prompt: bundlePath });
            sessionId = started.sessionId;
          }

          // Restart progress display
          progressTimer = setInterval(() => {
            const e = Math.floor((Date.now() - startTime) / 1000);
            const mins = Math.floor(e / 60);
            const secs = e % 60;
            process.stdout.write(`\r  ??  Agent running... ${mins}m ${secs}s`);
          }, 1000);

          continue; // Retry
        }
        stalled = true;
      }

      // Not retrying — write stall and stop
      if (!stalled) {
        await handleAgentFailure(id, exitCode, { maxRetries });
      }
      alreadyStalled = true;
      finalExitCode = exitCode;
      break;
    }

    // ── 收尾 ──────────────────────────────────────────────────────────
    //
    // 前台与后台监督进程**走同一条流水线**（./run-finish.ts）。
    // 两份实现必然漂移（一处跑门禁、一处忘了）—— 见 run-finish.ts 的说明。
    //
    // 记账（ADR-092）已经在重试循环里**每次进程结束记一条**（与并行同口径）。
    // 唯二没走循环内记账的情形：
    //   1. 看门狗收走的那一轮 —— 由 watchdog 记过（exitCode=null）；
    //   2. agent 起不来 / 循环一次都没跑（finalExitCode 仍是初始值）——
    //      这种「没有进程真的跑完」的结局**不该**进 runs（不是一次运行）。
    // 因此这里只在「看门狗收走」时补记，其余不再记 —— 否则会变成一条两记。
    if (watchdogRecorded) {
      // 看门狗已记过，这里不再记。
    }

    if (watchdogRecorded) {
      // 这一轮被看门狗收走（退 frozen + 分类已写）—— 现场已经交回给人。
      // 跑门禁 / 审计越界都没有意义（而且 enforceWriteSet 会再退一次状态）。
      return 1;
    }

    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const finished = await finishRun({
      sliceId: id,
      sessionId,
      exitCode: finalExitCode,
      elapsedSec: elapsed,
      guard: activeGuard,
      adapter,
      isHotfix,
      alreadyRecorded: true, // 上面已经记过账
      alreadyStalled,       // 重试预算耗尽时 handleAgentFailure 已经停过一次
    });

    if (!finished.ok && finalExitCode !== 0) {
      // All retries exhausted or non-resolvable — already handled by handleAgentFailure
      console.log('');
      printOutcome(agentFailedMessage({ sliceId: id }, finalExitCode, attempt + 1, elapsed));
    }
    if (finished.violated) return 1;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error running slice "${id}": ${msg}`);
    return 1;
  } finally {
    // 释放写集预约 + 撤掉钩子。detach 模式下预约交给后台监视器，这里不动。
    if (guard && !guardTransferred) {
      await guard.release();
    }
  }
  return 0;
});

// ─── run:parallel — concurrent slice execution ─────────────────────

/**
 * Run multiple non-conflicting slices in parallel.
 *
 * Usage: zelto run --parallel <id1> [id2 ...] [--agent <name>] [--adapter <type>]
 *
 * 执行语义全部在 ./parallel-executor.ts —— `zelto version start` 走同一条路径，
 * 保证版本层的并行与单切片并行的隔离、守卫、门禁行为完全一致。
 */
async function runParallel(args: string[]): Promise<number> {
  // Collect slice IDs: all non-flag args, regardless of --parallel position
  const ids = args.filter((a) => !a.startsWith('--') && a !== '--parallel');

  if (ids.length < 2) {
    console.error('Usage: zelto run --parallel <slice-id-1> <slice-id-2> [...slice-id-N] [--agent <name>]');
    return 1;
  }

  // D-2：`--agent` / `--adapter` 没给值时不能把 undefined 当成值传下去。
  // 并行路径的 undefined 会被 createExecutorAdapter 的兜底接住，
  // 但日志里会出现 `Agent: undefined` —— 征兆比 bug 本身更早出现。
  const agentName = optionValueStrict(args, '--agent');
  const adapterType = optionValueStrict(args, '--adapter');

  // 排阶段（G-1 + G-2）：依赖分层 + 写集冲突降级
  const plan = await buildExecutionPlan(ids, args);

  if (plan.cycle) {
    await events.append('batch', 'coord.cycle_detected', 'zelto', {
      cycle: plan.cycle,
      slices: ids,
    });
    console.error(`\n❌ 依赖成环：${plan.cycle.join(' → ')}`);
    console.error('   环里的切片没法排先后 —— 先解开依赖再跑。');
    return 1;
  }

  printExecutionPlan(plan);

  const result = await executeSlicesByPhase({
    ids,
    phases: plan.phases,
    agentName,
    adapterType,
    title: 'zelto run --parallel',
    eventKey: 'batch',
    affinity: plan.affinity,
    affinityPrevious: plan.affinityPrevious,
  });

  if (result.aborted) {
    console.error(`\n❌ 并行执行未开始：${result.abortReason}`);
    return 1;
  }

  printParallelSummary(result);

  if (result.skipped.length > 0) {
    console.log('');
    console.log(`⏸️  没来得及跑的切片：${result.skipped.join(', ')}`);
  }

  return result.ok ? 0 : 1;
}

register('admit', async (args) => {
  const [id] = args;
  if (!id || id.startsWith('--')) {
    console.error('Usage: zelto admit <slice-id> [--json]');
    return 1;
  }

  const isJson = args.includes('--json');

  try {
    const scheduler = new Scheduler(store, events, loadPolicyConfig());

    const result = await scheduler.admit(id);
    if (result.decision !== 'admitted') {
      if (isJson) {
        console.log(JSON.stringify({ sliceId: id, decision: 'blocked', reason: result.reason, blockedBy: result.blockedBy }));
      } else {
        console.log(`❌ Blocked: ${result.reason}`);
        if (result.blockedBy.length > 0) {
          console.log(`  Blocked by: ${result.blockedBy.join(', ')}`);
        }
      }
      return 1;
    }

    if (isJson) {
      console.log(JSON.stringify({ sliceId: id, decision: 'admitted', reason: null, blockedBy: [] }));
    } else {
      console.log(`✅ Admitted: ${id}`);
    }
    return 0;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isJson) {
      console.log(JSON.stringify({ error: msg }));
    } else {
      console.error(`Error: ${msg}`);
    }
    return 1;
  }
});

// ─── start ────────────────────────────────────────────────────────────────────

register('start', async (args) => {
  const [id] = args;
  if (!id || id.startsWith('--')) {
    console.error('Usage: zelto start <slice-id> [--title <title>] [--writes <path1,path2,...>] [--requirement <ref>]... [--agent <name>] [--adapter <type>] [--yes]');
    return 1;
  }

  // Confirmation prompt (skip with --yes, or when stdin is not a TTY).
  // Non-TTY means the command was invoked from a script/CI — there is nobody
  // to answer the prompt, so waiting for input would hang forever.
  if (!args.includes('--yes') && !args.includes('-y') && process.stdin.isTTY) {
    const title = extractFlagValue(args, '--title') ?? id;
    console.log(`About to execute slice "${id}" ("${title}")`);
    console.log(`  This will: create → freeze → run an AI agent`);
    console.log(`  The agent may modify files and incur API costs.`);
    console.log('');

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question('  Proceed? [y/N] ', resolve);
    });
    rl.close();

    if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
      console.log('Cancelled.');
      return 0;
    }
  }

  const title = extractFlagValue(args, '--title') ?? id;

  const writesRaw = extractFlagValue(args, '--writes');
  const customWrites = writesRaw ? writesRaw.split(',').map((w: string) => w.trim()).filter(Boolean) : null;

  // 需求追溯引用（人批准的出处）：start 常常没有规格可解析，
  // 这时人必须显式声明，否则冻结准入会拦住（ADR-032 §3.1）。
  const declaredRequirements = extractFlagValues(args, '--requirement');

  // Step 1: Create if not exists
  let isNew = false;
  if (!(await store.exists(id))) {
    const writes = customWrites ?? detectDefaultWrites();
    const slice = store.create(id, title, {
      writes,
      trace: { requirements: declaredRequirements, contracts: [], tests: [] },
    });
    await store.write(slice);
    await events.append(id, 'spec.drafted', 'cli', { sliceId: id, title, specPath: slice.spec.path });
    console.log(`  ✅ Created: ${id}`);
    if (writes.length > 0) {
      console.log(`  Write-set: ${writes.join(', ')}`);
    }
    isNew = true;
  } else {
    console.log(`  ??  Already exists: ${id}`);
  }

  // Step 2: Freeze (if not already frozen)
  try {
    const current = await store.read(id);
    if (current.state === 'draft' || current.state === 'clarifying') {
      // 人显式声明的需求追溯：切片已有出处就不覆盖（声明优先，但不覆盖更完整的声明）
      if (current.trace.requirements.length === 0 && declaredRequirements.length > 0) {
        current.trace.requirements = declaredRequirements;
        await store.write(current);
      }
      // Write a default spec if none exists
      const { existsSync, mkdirSync, writeFileSync } = await import('node:fs');
      const specPath = current.spec.path;
      if (!existsSync(specPath)) {
        const specDir = specPath.substring(0, specPath.lastIndexOf('/'));
        if (!existsSync(specDir)) {
          mkdirSync(specDir, { recursive: true });
        }
        // 占位规格：只有骨架，**验收标准留空**。
        //
        // 为什么不给一条默认的验收标准：那一句话会物化成本片的需求追溯，
        // 于是「追溯合格」变成 zelto 自己替人批准的需求——追溯链看着完整，
        // 实际是空的。假引用比缺失更有毒（ADR-032 §3.3）。
        // 所以这里写骨架，然后由冻结准入拦住人：先把验收标准写下来。
        writeFileSync(
          specPath,
          `# ${current.title}\n\n## Summary\n\n${current.title}\n\n## Scope\n\n## Acceptance Criteria\n\n## Risks\n`,
          'utf-8',
        );
      }

      // 追溯准入闸门（ADR-032 §3.1）：需求追溯为空 → 不许冻结、不许开跑
      const specContent = await readFile(specPath, 'utf-8').catch(() => '');
      const gate = evaluateFreezeTrace(current, specContent);
      if (gate.requirements.length !== current.trace.requirements.length) {
        current.trace.requirements = gate.requirements;
        await store.write(current);
      }
      if (gate.blocking.length > 0) {
        console.error(`  ❌ 追溯不合格，拒绝冻结：`);
        for (const v of gate.blocking) console.error(`     - ${v.message}`);
        console.error(`     在规格「${specPath}」里写「## 验收标准」（编号条目）→ 冻结准入会认它`);
        console.error(`     或显式声明需求追溯： zelto start ${id} --requirement "<需求引用>"`);
        console.error(`     或事后补声明： zelto set ${id} --field trace.requirements --value "<需求引用>"`);
        return 1;
      }

      const { hashSpecFile } = await import('./shared.js');
      const specHash = hashSpecFile(specPath);
      current.spec.frozenHash = specHash ?? `sha256:${Date.now()}`;
      current.spec.frozenAt = new Date().toISOString();
      current.spec.boundaryHash = computeBoundaryHash(current);
      await store.write(current);
      await store.transit(id, 'FREEZE');
      await events.append(id, 'spec.frozen', 'cli', {
        sliceId: id, frozenHash: current.spec.frozenHash, boundaryHash: current.spec.boundaryHash, frozenAt: current.spec.frozenAt,
      });
      console.log(`  ✅ Frozen: ${id}`);
    } else {
      console.log(`  ??  Already frozen: ${id} (state=${current.state})`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ❌ Freeze failed: ${msg}`);
    return 1;
  }

  // Step 3: Run the agent
  try {
    const scheduler = new Scheduler(store, events, loadPolicyConfig());

    const admitResult = await scheduler.admit(id);
    if (admitResult.decision !== 'admitted') {
      console.error(`  ❌ Cannot run: ${admitResult.reason}`);
      return 1;
    }

    // Check budget before starting run
    // `checkBudget` 内部已经打印统一措辞（并写 stall.classified 事件）
    const budgetOk = await checkBudget(id);
    if (!budgetOk) {
      return 1;
    }

    await scheduler.startRun(id);

    const slice = await store.read(id);
    const bundle = scheduler.buildConstraints(
      slice,
      null,
      gateCommandsForSlice(slice),
      await scheduler.readFeedbackFor(id),
    );
    const bundlePath = join(ZELTO_DIR, `${id}-bundle.json`);
    const { writeFileSync: write } = await import('node:fs');
    write(bundlePath, JSON.stringify(bundle, null, 2), 'utf-8');

    const cfg = loadConfig();
    const adapterType = optionValueStrict(args, '--adapter');
    // D-2：同上 —— `--agent` 没给值时回退到默认 agent。
    // **adapter 决定默认命令**（Cursor → `cursor-agent`）。
    const agentName = optionValue(
      args,
      '--agent',
      resolveAgentCommand(adapterType ?? cfg.agent.adapter, undefined, cfg),
    );

    console.log(`  Agent:         ${agentName}`);

    // Check agent availability before starting
    try {
      const { checkAgentAvailable } = await import('../../adapters/agent-command.js');
      // D-27：同上 —— 带上配置里的命令，错误信息要指向能用的那条。
      const agentError = await checkAgentAvailable(agentName, cfg.agent.command);
      if (agentError) {
        console.error(`  ❌ ${agentError}`);
        return 1;
      }
    } catch {
      // skip check
    }

    const sliceForTimeout = await store.read(id);
    let adapter = createExecutorAdapter(adapterType, agentName, sliceForTimeout.agentTimeout);
    // 活进程看门狗（ADR-074）的「本轮起跑时刻」—— **必须在 start 之前**取。
    //
    // 世代过滤靠它切分「本轮的记录」与「上一代的尸体」：只有
    // `startedAt >= 起跑时刻` 的记录才算本轮。适配器写会话文件用的
    // `startedAt` 是它自己 new Date() 取的 —— 比这里的时刻**早**（start
    // 先返回，CLI 才接着取时刻）。
    //
    // 取晚了就出事：差值超过 1 秒容差时，本轮自己的记录会被世代过滤
    // 滤掉 → 看门狗看到「本轮没有任何记录」→ 判「从没开跑」→ 收走。
    // 于是每次重试都要么秒收一次、要么被上一代的尸体当成现场（D-49）。
    let runStartedAt = new Date().toISOString();
    runGenStartedAt.set(id, runStartedAt);
    let { sessionId } = await adapter.start({ sliceId: id, prompt: bundlePath });

    await events.append(id, 'run.started', 'zelto', {
      sliceId: id, agent: agentName, bundlePath, writes: bundle.writes,
    });

    // Show progress
    let startTime = Date.now();
    let progressTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      process.stdout.write(`\r  ??  Agent running... ${mins}m ${secs}s`);
    }, 1000);

    // Retry loop
    const maxRetries = cfg.agent.maxRetries ?? 2;
    let finalExitCode: number | null = null;
    let attempt = 0;
    let watchdogRecorded = false;

    while (attempt <= maxRetries) {
      // 活进程看门狗（ADR-074）—— 与单片路径同一个等法
      const waited = await waitForExitWithWatchdog({
        sliceId: id,
        sessionId,
        adapter,
        runStartedAt,
        maxRetries,
      });
      const exitCode = waited.exitCode;

      clearInterval(progressTimer);
      process.stdout.write('\r' + ' '.repeat(50) + '\r');

      // 看门狗已写好停机与记账 —— 不再走 handleAgentFailure / 不再记账
      if (waited.watchdogReaped) {
        finalExitCode = null;
        watchdogRecorded = true;
        break;
      }

      // 记账（ADR-092）：**每次 agent 进程结束 = 一条**，与并行路径同口径。
      // 成功与失败都要记 —— 中间被重试掉的失败尝试也必须在账本里。
      try {
        await store.recordRun(id, {
          ok: exitCode === 0,
          exitCode,
          phase: 'foreground',
          attempt: attempt + 1,
        });
      } catch { /* 记账失败不阻断 */ }

      if (exitCode === 0) {
        finalExitCode = 0;
        break;
      }

      // Failed — try auto-retry
      await events.append(id, 'run.aborted', 'zelto', { sliceId: id, exitCode });
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      console.log(`  ❌ Agent exited with code ${exitCode} (${elapsed}s)`);

      // 停机只做一次（ADR-047）：`handleAgentFailure` 返回 'stall' 时
      // 它已经把切片停机了（退 frozen + 写分类 + 留痕）—— 别调两遍。
      let stalled = false;
      if (attempt < maxRetries) {
        const result = await handleAgentFailure(id, exitCode, { maxRetries });
        if (result.action === 'retry') {
          attempt = result.retryCount ?? attempt + 1;
          adapter = createExecutorAdapter(adapterType, agentName, sliceForTimeout.agentTimeout);
          // 超时重试接着上一次跑，不从头再来（ADR-055）
          //
          // 新一轮的「起跑时刻」必须在 start **之前**取（见上面 D-49 的说明）：
          // 世代过滤靠它切分本轮记录与上一代的尸体，取晚了本轮记录会被滤掉。
          runStartedAt = new Date().toISOString();
          runGenStartedAt.set(id, runStartedAt);
          const resumed = await resumeForRetry(adapter, sessionId, id, bundlePath);
          if (resumed) {
            sessionId = resumed;
          } else {
            const started = await adapter.start({ sliceId: id, prompt: bundlePath });
            sessionId = started.sessionId;
          }
          progressTimer = setInterval(() => {
            const e = Math.floor((Date.now() - startTime) / 1000);
            const mins = Math.floor(e / 60);
            const secs = e % 60;
            process.stdout.write(`\r  ??  Agent running... ${mins}m ${secs}s`);
          }, 1000);
          continue;
        }
        stalled = true;
      }

      if (!stalled) {
        await handleAgentFailure(id, exitCode, { maxRetries });
      }
      finalExitCode = exitCode;
      break;
    }

    // 记账（ADR-092）已在重试循环里每次进程结束记过 —— 这里不再补记，
    // 否则会变成一条两记。看门狗收走的那一轮由 watchdog 自己记。

    if (watchdogRecorded) {
      // 这一轮已交回给人（frozen + 停机分类），不再跑门禁 / 不进签字
      return 1;
    }

    if (finalExitCode === 0) {
      // 提问回路：agent 以问题收尾 → 挂起切片，不跑门禁（ADR-013 §3.6）
      const question = await detectQuestion(id, adapter, sessionId);
      if (question) {
        await suspendSliceForQuestion(id, question);
        console.log(`\n  ❓ Agent asked a question (${question.type}):`);
        console.log(`     ${question.question}`);
        console.log(`  Answer with: zelto answer ${question.id} "<your answer>"`);
        return 0;
      }

      await store.transit(id, 'RUN_FINISH');
      // 花费结算（ADR-035）：先记账，再复判预算；超预算则不进 gate。
      const cost = await settleRunCost(id, adapter, sessionId);
      await events.append(id, 'run.finished', 'zelto', { sliceId: id, exitCode: 0, costUsd: cost.costUsd });
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      console.log(`✅ Agent completed successfully (${elapsed}s)`);

      if (cost.exhausted) {
        printOutcome(budgetExhaustedMessage({ sliceId: id }, cost.spent, cost.limit));
        return 0;
      }

      // Auto-run gate and create sign request on pass
      await autoGateAfterRun(id);
    } else {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      printOutcome(agentFailedMessage({ sliceId: id }, finalExitCode, attempt + 1, elapsed));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ❌ Agent execution failed: ${msg}`);
    return 1;
  }

  return 0;
});

// ─── Background task tracking ────────────────────────────────────────────
//
// 任务文件的存取在 ./task-store.ts —— `--detach` 的监督进程
// （独立进程，见 supervisor.ts，D-50）也要读写同一份文件。

/**
 * 被动式活性检查（D-30 / D-51）。
 *
 * `--detach` 的监视器是一个**独立进程**（见 supervisor.ts，D-50）——
 * 这里不依赖任何后台进程：每次 `tasks` / `task-status` / `wait` / Web 查询时，
 * 现场读文件 + `kill(pid,0)` 判定进程死活。任务文件缺心跳字段时（老任务），
 * 回读会话文件兜底并回填。
 *
 * **D-51：必须带上 `agentPid`。**
 *
 * 会话文件里有两个 pid：
 *   - `pid`      —— 包装进程（Windows 上是 `cmd.exe`），它负责转发信号；
 *   - `agentPid` —— 真正的 agent 进程（`node.exe` / `claude.exe`）。
 *
 * 只看 `pid` 会误判：包装进程在 agent 启动后就退了（它不是常驻的），
 * 于是「包装进程没了」被当成「agent 死了」—— 一个**活着的 agent**
 * 被判成死的，然后被 `stall --reap` 收走（切片退回 frozen），
 * 而那个 agent 还在改文件。
 *
 * 判据要跟 `core/activity/liveness.ts` 一致：`agentPid ?? pid`。
 */
function taskLiveRecord(task: TaskInfo): import('../../core/activity/index.js').LivenessRecord {
  let session: import('../../core/activity/index.js').LivenessRecord | null = null;
  try {
    session = readSessionLiveness(process.cwd(), task.sessionId);
  } catch { /* 会话文件读不到就用任务文件本身 */ }
  return mergeSessionLiveness(task, session);
}

function taskLiveness(task: TaskInfo): import('../../core/activity/index.js').LivenessInfo {
  return classifyLiveness(taskLiveRecord(task), { isProcessAlive });
}

/** 把会话文件的新心跳同步回任务文件 —— 后续查询不用再回读会话。 */
async function syncTaskHeartbeat(task: TaskInfo): Promise<TaskInfo> {
  try {
    const sess = readSessionLiveness(process.cwd(), task.sessionId);
    if (!sess) return task;
    let dirty = false;
    if (task.pid === undefined && typeof sess.pid === 'number') { task.pid = sess.pid; dirty = true; }
    const taskLast = lastActivityOf(task);
    const sessLast = lastActivityOf(sess);
    if (sessLast !== null && (taskLast === null || sessLast > taskLast)) {
      task.lastActivityAt = sess.lastActivityAt ?? sess.lastOutputAt ?? sess.startedAt;
      if (sess.lastOutputAt) task.lastOutputAt = sess.lastOutputAt;
      dirty = true;
    }
    if (dirty && task.status === 'running') await saveTask(task);
  } catch { /* 同步失败不阻断展示 */ }
  return task;
}

/**
 * 看门狗单步处置（D-30）：`dead` 的 running 任务自动恢复，超预算则上报。
 *
 * - recover：任务文件置 failed + 切片 running→frozen + 计数 + 事件（可重跑）
 * - escalate：不再默默恢复 —— 任务保持 running，写 run.stalled 上报等人看
 *
 * 返回处置结果；非 dead 或已非 running 返回 `{ acted: false }`。
 */
async function maybeRecoverDeadTask(task: TaskInfo): Promise<{ acted: boolean; action?: 'recover' | 'escalate' }> {
  if (task.status !== 'running') return { acted: false };
  const live = taskLiveness(task);
  if (live.state !== 'dead') return { acted: false };
  const rec = readRecoveries(process.cwd(), task.sliceId);
  const decision = decideRecovery(rec);
  if (decision.action === 'recover') {
    task.status = 'failed';
    task.completedAt = new Date().toISOString();
    if (live.lastActivityAt) task.lastActivityAt = live.lastActivityAt;
    await saveTask(task);
    recordRecovery(process.cwd(), task.sliceId, live.reason);
    try {
      const s = await store.read(task.sliceId).catch(() => null);
      if (s && s.state === 'running') await store.transit(task.sliceId, 'RUN_FINISH');
    } catch { /* 切片不在 running 就不强掰 */ }
    await events.append(task.sliceId, 'run.aborted', 'watchdog', {
      sliceId: task.sliceId, taskId: task.taskId, reason: `看门狗自动恢复：${live.reason}`,
      recoveries: rec.count + 1, maxAutoRecoveries: MAX_AUTO_RECOVERIES,
    });
    return { acted: true, action: 'recover' };
  }
  recordEscalation(process.cwd(), task.sliceId);
  await events.append(task.sliceId, 'run.stalled', 'watchdog', {
    sliceId: task.sliceId, taskId: task.taskId,
    reason: `同一切片假死 ${rec.count} 次已达上限（${MAX_AUTO_RECOVERIES}），不再自动恢复，请人看现场：${live.reason}`,
    escalated: true, recoveries: rec.count,
  });
  return { acted: true, action: 'escalate' };
}

function taskLiveBadge(task: TaskInfo): string {
  const live = taskLiveness(task);
  if (live.state === 'active') return `🔄 active（${formatIdle(live.idleMs ?? 0)}前有动静）`;
  if (live.state === 'stale') return `⚠️ stale（${formatIdle(live.idleMs ?? 0)}没动静）`;
  if (live.state === 'dead') return `💀 dead（${live.reason}）`;
  return task.status;
}

// ─── task: list background tasks ──────────────────────────────────────────

register('tasks', async (args) => {
  const { readdirSync, existsSync } = await import('node:fs');
  const dir = tasksDir();
  if (!existsSync(dir)) {
    console.log('No background tasks.');
    return 0;
  }

  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) {
    console.log('No background tasks.');
    return 0;
  }

  console.log('Background tasks:');
  for (const file of files) {
    let task = await loadTask(file.slice(0, -5));
    if (!task) continue;
    if (task.status === 'running') {
      task = await syncTaskHeartbeat(task);
      await maybeRecoverDeadTask(task);
      task = (await loadTask(task.taskId)) ?? task;
    }
    const live = task.status === 'running' ? ` · ${taskLiveBadge(task)}` : '';
    const rec = task.status !== 'running' ? '' : (() => { try { const r = readRecoveries(process.cwd(), task.sliceId); return r.count > 0 ? ` · 自愈${r.count}次${r.escalated ? '(已上报)' : ''}` : ''; } catch { return ''; } })();
    const icon = task.status === 'completed' ? '✅' : task.status === 'running' ? (taskLiveness(task).state === 'dead' ? '💀' : taskLiveness(task).state === 'stale' ? '⚠️' : '🔄') : '❌';
    const elapsed = task.elapsedSec ? `${task.elapsedSec}s` : '—';
    console.log(`  ${icon} ${task.taskId.padEnd(30)} ${task.status.padEnd(10)} ${elapsed}${live}${rec}`);
  }
  return 0;
});

// ─── task-status: show task status ────────────────────────────────────

register('task-status', async (args) => {
  const [target] = args;
  if (!target) {
    // Show all tasks summary
    const { readdirSync, existsSync } = await import('node:fs');
    const dir = tasksDir();
    if (existsSync(dir)) {
      const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
      const running = [];
      for (const file of files) {
        let t = await loadTask(file.slice(0, -5));
        if (t?.status === 'running') {
          t = await syncTaskHeartbeat(t);
          await maybeRecoverDeadTask(t);
          t = (await loadTask(t.taskId)) ?? t;
          if (t.status === 'running') running.push(t);
        }
      }
      if (running.length > 0) {
        console.log(`Running tasks (${running.length}):`);
        for (const task of running) {
          const elapsed = Math.floor((Date.now() - new Date(task.startedAt).getTime()) / 1000);
          console.log(`  🔄 ${task.taskId} — ${task.sliceId} (${elapsed}s) · ${taskLiveBadge(task)}`);
        }
        return 0;
      }
    }
    console.log('No running background tasks.');
    return 0;
  }

  // Check if target is a task ID (starts with "task-")
  if (target.startsWith('task-')) {
    let task = await loadTask(target);
    if (!task) {
      console.error(`Task not found: ${target}`);
      return 1;
    }
    if (task.status === 'running') {
      task = await syncTaskHeartbeat(task);
      const acted = await maybeRecoverDeadTask(task);
      task = (await loadTask(task.taskId)) ?? task;
      if (acted.acted) {
        console.log(`  🤖 看门狗处置：${acted.action === 'recover' ? `自动恢复（running→failed，切片可重跑）` : `已上报（假死超${MAX_AUTO_RECOVERIES}次，请人看现场）`}`);
      }
    }
    const live = taskLiveness(task);
    const icon = task.status === 'completed' ? '✅' : task.status === 'running' ? (live.state === 'dead' ? '💀' : live.state === 'stale' ? '⚠️' : '🔄') : '❌';
    console.log(`  ${icon} ${task.taskId}`);
    console.log(`    Slice:    ${task.sliceId}`);
    console.log(`    Status:   ${task.status} · 活性 ${live.state}（${live.reason}）`);
    try {
      const r = readRecoveries(process.cwd(), task.sliceId);
      if (r.count > 0) console.log(`    看门狗：  已自愈 ${r.count} 次${r.escalated ? '（已上报）' : ''}${r.lastReason ? `，上次：${r.lastReason}` : ''}`);
    } catch { /* 不阻断展示 */ }
    console.log(`    Agent:    ${task.agentName}`);
    console.log(`    Session:  ${task.sessionId}`);
    if (task.elapsedSec) console.log(`    Elapsed:  ${task.elapsedSec}s`);
    if (task.exitCode !== undefined) console.log(`    Exit:     ${task.exitCode}`);
    return 0;
  }

  // Otherwise, show slice status via slice-status command
  const handler = (await import('./shared.js')).commands['slice-status'];
  if (handler) {
    return handler([target]);
  }
  console.error(`Unknown status target: ${target}`);
  return 1;
});

// ─── wait: block until task completes ─────────────────────────────────────

register('wait', async (args) => {
  const [taskId] = args;
  if (!taskId || !taskId.startsWith('task-')) {
    console.error('Usage: zelto wait <task-id>');
    console.error('  Get task ID from "zelto run --detach" or "zelto tasks"');
    return 1;
  }

  let task = await loadTask(taskId);
  if (!task) {
    console.error(`Task not found: ${taskId}`);
    return 1;
  }

  if (task.status !== 'running') {
    const icon = task.status === 'completed' ? '✅' : '❌';
    console.log(`${icon} Task ${taskId}: ${task.status}`);
    return task.status === 'completed' ? 0 : 1;
  }

  // Poll for completion —— 每次轮询都做一次被动活性检查（D-30）。
  // 内存监视器可能早死了，这里不信它，只信文件 + pid。
  const startTime = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise((r) => setTimeout(r, 2000));
    task = await loadTask(taskId);
    if (!task) break;
    if (task.status === 'running') {
      task = await syncTaskHeartbeat(task);
      const acted = await maybeRecoverDeadTask(task);
      task = (await loadTask(taskId)) ?? task;
      if (task.status !== 'running') {
        if (acted.acted && acted.action === 'escalate') {
          console.log(`\n💀 Task ${taskId}: 进程已死且自愈超${MAX_AUTO_RECOVERIES}次 —— 已上报，请人看现场`);
        } else if (acted.acted) {
          console.log(`\n🤖 Task ${taskId}: 看门狗自动恢复（进程已死，切片已可重跑）`);
        }
        break;
      }
      const live = taskLiveness(task);
      if (live.state === 'stale') {
        process.stdout.write(`\r  ⚠️  Waiting... ${Math.floor((Date.now() - startTime) / 1000)}s · ${formatIdle(live.idleMs ?? 0)}没动静（可疑）  `);
        continue;
      }
    }
    if (!task || task.status !== 'running') break;
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    process.stdout.write(`\r  🔄  Waiting... ${elapsed}s`);
  }

  process.stdout.write('\r' + ' '.repeat(30) + '\r');
  if (!task) {
    console.error(`Task lost: ${taskId}`);
    return 1;
  }

  const icon = task.status === 'completed' ? '✅' : '❌';
  console.log(`${icon} Task ${taskId}: ${task.status} (${task.elapsedSec ?? '?'}s)`);
  return task.status === 'completed' ? 0 : 1;
});
