// 并行执行器 —— `zelto run --parallel` 与 `zelto version start` 共用同一套执行语义。
//
// 为什么要抽出来：版本层要「并行进入高速开发」，就必须和单切片执行用同一套
// 隔离与约束机制（worktree 隔离 + 写集预约守卫 + 门禁② + 签名请求）。
// 两份实现各写一遍迟早会漂移 —— 版本层一旦漏掉守卫，就会出现
// 「并行 agent 在主仓互相覆盖」这种最伤可控性的事故（AGENTS.md C9）。
//
// 不变量：
// C1 状态只落在文件里（切片文件 + 事件流 + 预约文件）
// C3 准入 / 冲突 / 预算判定都是确定性的（不调模型、不触网）
// C4 每个动作都写 append-only 事件
// C9 写集预约在运行时由 hook 强制执行

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Scheduler } from '../../core/sched/engine.js';
import { listFilesUnder } from '../../core/sched/audit.js';
import { makeRunId } from '../../core/sched/run-id.js';
import { pathInWriteSet } from '../../core/pathspec/index.js';
import { HaltStore, rollbackHaltedSlice } from '../../core/halt/index.js';
import { classifyStall } from '../../core/stall/classifier.js';
import type { SliceData } from '../../core/slice/store.js';
import type { WorktreeInfo } from '../../core/worktree/index.js';

import {
  ZELTO_DIR,
  createExecutorAdapter,
  ensureWorktree,
  events,
  loadConfig,
  loadPolicyConfig,
  store,
  worktreeManager,
  harnessForAdapter,
  resolveAgentCommand,
  buildSpecIntegrity,
} from './shared.js';
import { autoGateAfterRun, checkBudget, handleAgentFailure, resolveWriteSet, settleRunCost, gateCommandsForSlice, gateScopeForSlice, markSliceStalled, revertRunAbortedBeforeStart, createRuntimeBudgetGuard, readBudgetLimit } from './run-support.js';
import { RuntimeBudgetGuard } from '../../core/budget/index.js';
import {
  type RuntimeGuard,
  enforceWriteSet,
  installRuntimeGuard,
  releaseGuards,
} from './runtime-guard.js';
import { detectQuestion, suspendSliceForQuestion } from './question.js';
import { SliceProgressProbe } from './progress-probe.js';
import {
  agentFailedMessage,
  budgetExhaustedMessage,
  printOutcome,
  writeSetOutcomeLines,
} from './run-messages.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/** 单个切片在并行批次里的结局 */
export type SliceOutcomeStatus = 'completed' | 'failed' | 'stalled' | 'asked' | 'halted';

export interface SliceOutcome {
  id: string;
  status: SliceOutcomeStatus;
  exitCode: number | null;
  elapsedSec: number;
  /** 门禁②是否通过；null 表示根本没走到门禁 */
  gatePassed: boolean | null;
  /** 是否已经发起签名请求 */
  signRequested: boolean;
  /** agent 以提问收尾时的提问记录 */
  question?: { id: string; question: string };
}

export interface ParallelExecutionOptions {
  /** 要并行执行的切片 id */
  ids: string[];
  /** agent 命令（默认取配置） */
  agentName?: string;
  /** 执行器适配器类型（默认取配置） */
  adapterType?: string;
  /** 进度显示用的标题 */
  title?: string;
  /** 是否自动跑门禁②并发起签名请求（默认 true） */
  autoGate?: boolean;
  /** 事件归属键（版本级用 version-<label>，run --parallel 用 batch） */
  eventKey?: string;
  /** 拉闸作用域（默认取 eventKey）——批次键或 'all' */
  haltScope?: string;
  /** 亲和分组（ADR-024）：sliceId → groupId，无命中为 null；缺省等价全 null */
  affinity?: Map<string, string | null>;
  /** 组内排在本片之前的切片 id（按执行序）；缺省为空 */
  affinityPrevious?: Map<string, string[]>;
  /**
   * 切片基点覆盖（ADR-056 §3.3）。
   *
   * 版本里的切片基点来自**版本分支的 tip**，不是主仓 HEAD ——
   * 否则同版本的切片看不到本版本其它切片的改动。
   */
  baseCommitOverride?: string | null;
}

export interface ParallelExecutionResult {
  outcomes: SliceOutcome[];
  completed: number;
  failed: number;
  stalled: number;
  asked: number;
  /** 被拉闸打断的切片数（人主动喊停） */
  halted: number;
  /** 本批次的拉闸作用域（解除时要用它） */
  haltScope: string;
  /** 是否全部走完且没有失败/停机 */
  ok: boolean;
  /** 准入 / 冲突 / 预算阶段就退出了 —— 一个 agent 都没跑起来 */
  aborted: boolean;
  /** 提前退出的原因 */
  abortReason: string | null;
  /** 因为前面的阶段没过而没来得及执行的切片 */
  skipped: string[];
}

// ─── zelto 自己写进 worktree 的文件 ──────────────────────────────────────────

/**
 * zelto 自己写进 worktree 的文件（相对 worktree 的路径）。
 *
 * 规格副本、验收目录副本、约束包镜像 —— 这些是 zelto 放进去的，不是 agent 写的。
 * 审计时它们不能算成「agent 越界写入」（否则每次运行都会被自己的文件拦下）；
 * 但内容被改动就是篡改：改了规格副本等于自动改规格（AGENTS.md 禁区）。
 *
 * **例外（ADR-046）**：验收目录里那些**在写集里**的文件不是「zelto 托管」的
 * —— 它们是 agent 该改的东西（验收骨架里的 `test.todo` 必须被换成真断言）。
 * 把它们同时登记成托管文件，等于一边叫 agent 改、一边拦它改。
 *
 * **例外（ADR-106）**：**规格文件**同样按写集判 —— 写集里有 → agent 的
 * 地盘（不托管）；写集里没有 → zelto 的地盘（托管，内容被改 = 篡改）。
 *
 * 为什么规格也要按写集判（ADR-046 只给验收目录开了这个口子）：
 * 人把规格列进写集，就是说「这片要改它」。zelto 一边在约束包里告诉
 * agent「You may only modify these paths」，一边在运行结束时因为它改了
 * 规格而把整轮判成篡改 —— 那是**自相矛盾**（实测 nimrtc-v14
 * `v1-call-state-surface`，2026-11-24：agent 把规格里 ADR 状态从
 * `Proposed` 改成 `Accepted`，整轮运行被拦，gate 都没跑）。
 *
 * 豁免不是无条件放行：审计时另有一道「冻结需求仍在」的校验
 * （`auditWorktreeWrites` 的 `specIntegrity`），少了任何一条冻结时
 * 物化的需求 → 仍然判篡改。详见 ADR-106 §2。
 *
 * 判据是**写集**：写集里有的 → agent 的地盘；没在写集里的 →
 * zelto 的地盘，agent 不该动。
 */
export function zeltoOwnedPaths(worktreePath: string | null, slice: SliceData): string[] {
  if (!worktreePath) return [];

  const paths: string[] = [];

  // ADR-106：规格在写集里 → agent 的地盘，不登记为托管。
  // 不在写集里 → 照旧托管（内容被改 = 篡改）。
  //
  // **判据必须与 C9 运行时一致**（`pathInWriteSet`，与
  // `auditWorktreeWrites` 用的是同一个匹配器）——
  //
  // 之前这里用的是 `writeSet.has(specRel)`（严格相等），那与 C9 的
  // `pathInWriteSet` **判得不一样**：C9 认 glob（`specs/slices/*.md`）
  // 与目录前缀（`specs/`），严格相等**不认**。
  //
  // 后果（实测四种写法都中招：glob / 目录前缀 / 裸目录 / 父目录前缀）：
  //   人用 `specs/` 写写集 → C9 允许 agent 改这个规格
  //   → 但这里判「不在写集」→ 登记成托管 → agent 一改就判篡改
  //   → **zelto 一边让 agent 改、一边因它改而拦下** ——
  //   正是 ADR-106 要修的那个矛盾，只是换了种写法没修掉。
  //
  // 「同一件事两套判据」是 D-11（合并的两条路径判据不一致）的老教训。
  if (slice.spec.path) {
    const specRel = slice.spec.path.replace(/\\/g, '/');
    if (!pathInWriteSet(specRel, slice.writes)) paths.push(specRel);
  }
  if (slice.acceptance.dir) {
    for (const file of listFilesUnder(worktreePath, slice.acceptance.dir)) {
      // ADR-046：写集里的验收文件是 agent 该改的（骨架里的 `test.todo`
      // 必须被换成真断言）。**同样用 `pathInWriteSet`**（理由同上）。
      if (pathInWriteSet(file, slice.writes)) continue;
      paths.push(file);
    }
  }
  paths.push(join(ZELTO_DIR, `${slice.id}-bundle.json`));
  return paths;
}

/**
 * 打印批次小结（完成 / 停机 / 提问三类）。
 * 两种调用方（`run --parallel` 与 `version start`）共用同一份小结格式。
 */
export function printParallelSummary(result: ParallelExecutionResult): void {
  console.log('');
  console.log(`?? 并行批次结束：${result.completed} 通过，${result.stalled} 停机，${result.asked} 待回答${result.halted > 0 ? `，${result.halted} 已被拉闸` : ''}`);

  const haltedOutcomes = result.outcomes.filter((o) => o.status === 'halted');
  if (haltedOutcomes.length > 0) {
    console.log('');
    console.log(`⏸️  已被拉闸的切片（现场保留，处理完可重跑）:`);
    for (const o of haltedOutcomes) {
      console.log(`  ⏸️  ${o.id}`);
    }
    console.log(`     处理完：zelto halt --clear --scope ${result.haltScope}  →  重新跑批次`);
  }

  const asked = result.outcomes.filter((o) => o.status === 'asked');
  if (asked.length > 0) {
    console.log('');
    console.log(`❓ 等待回答的切片:`);
    for (const o of asked) {
      console.log(`  ❓ ${o.id} — ${o.question?.question ?? ''}`);
      console.log(`     zelto answer ${o.question?.id ?? ''} "<your answer>"`);
    }
  }

  const stalled = result.outcomes.filter((o) => o.status === 'stalled' || o.status === 'failed');
  if (stalled.length > 0) {
    console.log('');
    console.log(`??  需要人处理的切片:`);
    for (const o of stalled) {
      console.log(`  ❌ ${o.id} — exit ${o.exitCode ?? 'signal'} (zelto resume ${o.id})`);
    }
  }

  const completed = result.outcomes.filter((o) => o.status === 'completed');
  if (completed.length > 0) {
    console.log('');
    console.log(`✅ 完成的切片:`);
    for (const o of completed) {
      const gate = o.gatePassed ? '门禁通过，已发起签名' : '门禁未通过';
      console.log(`  ✅ ${o.id} — ${gate} (${o.elapsedSec}s)`);
    }
  }
}

// ─── 拉闸：等待 agent 时也能被叫停 ──────────────────────────────────────────

/** 等待结果：正常退出，或被人拉闸打断 */
export interface ExitOrHalt {
  exitCode: number | null;
  halted: boolean;
  reason?: string;
  /** ZD-007：预算闸门在运行中拦下 */
  budgetExceeded?: boolean;
  /** 拦截时的已花费（美元） */
  spentUsd?: number;
  /** 拦截时的上限（美元） */
  limitUsd?: number;
}

/**
 * 等 agent 退出，同时盯着拉闸请求。
 *
 * 为什么要「边等边听」：批次跑起来之后，人往往是在看到某个 agent
 * 跑偏了才想喊停。等到 agent 自己结束再停，就没有「拉闸」可言了。
 *
 * 停了之后现场保留（worktree、写集预约、切片状态都还在），
 * 人处理完 `zelto halt --clear` 再重跑批次。
 *
 * ── D-66：这里还要**喂进展** ──────────────────────────────────────────
 * 适配器的超时是**空转超时**（没进展才杀，D-55），而「进展」不只有 stdout：
 * Claude Code 跑 `--output-format json`，stdout 直到最后才有内容。
 * 只看输出的话，一个正在连续调用工具的 agent 在适配器看来是「一声不吭」，
 * 会在整整 timeoutMs 那一刻被砍掉。
 *
 * 病灶（实测于 nimrtc-zelto v4-ai-teammate，2026-11-18）：
 *   `zelto version start v4` 走的就是这条并行路径。第一轮跑了整整 30 分钟，
 *   事件流里 20:41–20:51 每分钟都有新事件（agent 一直在调工具），
 *   但会话文件写的是 `[zelto: no progress for 1800000ms — killed]` ——
 *   **倒计时一次都没被重置过**。
 *
 * 根因：D-55 把 `markProgress` 接到了**单片路径**（`core-slice.ts` 的
 * `waitForExitWithWatchdog`）和**后台监督路径**（`supervisor.ts`），
 * 但**并行执行路径**没接 —— 适配器的倒计时只认 `markProgress`，
 * 没人叫它就一路数到 1800 秒。
 *
 * 这跟 D-56（看门狗路径漏了 progress）是同一个形态：
 * 「每条路径都接上了」不等于「每条路径都接全了」。
 * 两条路都在真实项目上跑一遍才看见的。
 *
 * C3：只读文件、比对作用域，没有模型参与。
 */
export async function waitForExitOrHalt(
  adapter: {
    waitForExit(id: string): Promise<number | null>;
    stop(id: string): Promise<void>;
    /** D-66：报告「这一轮有进展」—— 可选能力，没实现不受影响 */
    markProgress?(id: string): void;
    /** ZD-007：运行中累计用量 —— 可选能力，没有就拦不了 */
    getLiveUsage?(id: string): { costUsd: number } | null;
  },
  sessionId: string,
  haltStore: HaltStore,
  scope: string,
  /** D-66：进展探针（读切片事件流大小） */
  progressProbe?: SliceProgressProbe,
  /**
   * ZD-007：运行中预算闸门。
   *
   * 不传 → 不拦（并行路径的旧行为）。
   * 传了就每轮询查一次，超了当场叫停 agent。
   */
  budgetGuard?: RuntimeBudgetGuard,
): Promise<ExitOrHalt> {
  let finished = false;
  let halted = false;
  let reason: string | undefined;
  let budgetExceeded = false;
  let spentUsd: number | undefined;
  let limitUsd: number | undefined;

  // 轮询器：看到暂停请求就停掉 agent；agent 先退出就自己收摊
  const watcher = (async () => {
    while (!finished) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (finished) return;

      // ── D-66：进展探针先行 ──────────────────────────────────────────
      // 事件流变长了 = agent 又动了一次 = 空转倒计时重新开始。
      // 探针只读文件大小，失败不阻断拉闸判定。
      if (progressProbe) {
        try {
          if (progressProbe.poll()) adapter.markProgress?.(sessionId);
        } catch { /* 探针失败不影响拉闸判定 */ }
      }

      // ── ZD-007：运行中预算闸门 ─────────────────────────────────────
      //
      // 与单片路径同一口径：测不到 → 不判定超支（继续跑）；
      // 超了 → 叫停 agent，且**与拉闸分开记**（原因不同，处置不同）。
      if (budgetGuard?.enabled) {
        const verdict = budgetGuard.check();
        if (verdict.status === 'exceeded') {
          budgetExceeded = true;
          spentUsd = verdict.spentUsd;
          limitUsd = verdict.limitUsd;
          try {
            await adapter.stop(sessionId);
          } catch {
            // agent 已经退出了 —— 停不到也没关系
          }
          return;
        }
      }

      const req = await haltStore.isHalted(scope);
      if (!req) continue;
      halted = true;
      reason = req.reason;
      try {
        await adapter.stop(sessionId);
      } catch {
        // agent 已经退出了 —— 停不到也没关系
      }
      return;
    }
  })();

  const exitCode = await adapter.waitForExit(sessionId);
  finished = true;
  await watcher;

  return { exitCode, halted, reason, budgetExceeded, spentUsd, limitUsd };
}

// ─── 内部状态 ────────────────────────────────────────────────────────────────
interface SliceState {
  id: string;
  status: 'admitted' | 'running' | 'completed' | 'failed';
  exitCode: number | null;
  sessionId: string | null;
  branchName: string;
  /** 隔离 worktree 路径 */
  worktreePath: string | null;
  elapsedSec: number;
}

// ─── 执行器 ──────────────────────────────────────────────────────────────────

/**
 * 并行执行一批切片。
 *
 * 流程：
 * 1. 准入 + 写集解析 + 跨切片冲突检测 + 预算检查
 * 2. 每个切片建隔离 worktree + 取写集预约 + 装 PreToolUse 钩子（C9）
 * 3. 并行拉起 agent，逐个等待退出（失败按配置重试）
 * 4. 成功的切片：写集审计 → 状态回写 → 门禁② → 签名请求
 * 5. 提问回路（ADR-013）：以问题收尾的切片挂起，批次里其它切片不受影响
 *
 * 主仓工作树全程不被切换分支、也不被 agent 写入。
 */
export async function executeSlicesParallel(
  options: ParallelExecutionOptions,
): Promise<ParallelExecutionResult> {
  const ids = options.ids;
  const title = options.title ?? 'zelto run --parallel';
  const autoGate = options.autoGate !== false;

  // ─── 拉闸：人喊停的通道 ──────────────────────────────────────────────
  // 批次进程不能常驻（AGENTS.md 禁区），所以人写一份暂停请求到文件，
  // 正在跑的批次在安全点上读到它就收手（C1：状态只在文件里）。
  const haltStore = new HaltStore(ZELTO_DIR);
  const haltScope = options.haltScope ?? options.eventKey ?? 'batch';

  const empty = (): ParallelExecutionResult => ({
    outcomes: [],
    completed: 0,
    failed: 0,
    stalled: 0,
    asked: 0,
    halted: 0,
    haltScope,
    ok: false,
    aborted: false,
    abortReason: null,
    skipped: [],
  });

  if (ids.length === 0) {
    return { ...empty(), abortReason: '没有要执行的切片', aborted: true };
  }

  const scheduler = new Scheduler(store, events, loadPolicyConfig());

  /**
   * 把本轮「已 startRun 但还没起 agent」的切片一起退回 `frozen`（D-64）。
   *
   * 为什么是**整批**退而不是只退失败的那一片：并行批次里，第 2 片装守卫失败时，
   * 第 1 片已经被 startRun 推到 `running`、守卫也装了，但 agent 一次都没起
   * （Phase 3 在整个准备循环之后才拉 agent）。整批 abort 时，第 1 片同样卡在
   * running —— 而它的守卫会被 `releaseGuards` 摘掉，剩下一个
   * 「running 但没人管、也没预约」的壳子。
   *
   * 这种壳子**没人能救**（实测 nimrtc-zelto v4-ai-teammate，2026-11-18）：
   *   - `run` 拒绝跑（准入只认 frozen / completed）
   *   - `merge` 不收它（没签字）
   *   - `stall --reap` 看不见它（连会话文件都没写 → 活性判定不是 stale/dead）
   *   - 唯一出路是 `abandon` —— 整个切片作废，规格得重写
   */
  async function revertStartedRound(started: string[], reason: string): Promise<void> {
    for (const id of started) {
      await revertRunAbortedBeforeStart(id, { reason });
    }
  }

  /** 被拉闸打断、没能跑起来的切片 */
  const haltedIds = new Set<string>();

  /**
   * 被**预算闸门**拦下的切片（ZD-007）。
   *
   * 与 `haltedIds` **分开记** —— 两者处置相似（都交回人）但**原因不同**：
   * - `haltedIds` = 人喊停 → 走 `rollbackHaltedSlice`（人工介入）；
   * - `budgetExhaustedIds` = 闸门拦下 → 走预算停机路径（`stall.classified`
   *   记 `budget_exhausted`）。
   *
   * 混在一起的后果：人看到「halted」会以为是自己喊停的，
   * 于是去 `zelto halt --clear` 找原因 —— 而真相是「钱烧完了」。
   */
  const budgetExhaustedIds = new Set<string>();

  /**
   * 被预算闸门拦下的切片的花费明细（ZD-007）。
   *
   * 为什么要单独存：`SliceState` 里没有这两个字段，
   * 而事后打印时需要它们（「花了多少 / 上限多少」）——
   * 现场被交回给人时，人第一件事就是想看这个数。
   */
  const budgetSpent = new Map<string, { spentUsd: number; limitUsd: number }>();

  /** 拉闸原因（人写的）—— 写进事件与 stall 记录，给人自己看 */
  let haltReason: string | undefined;

  const states: SliceState[] = ids.map((id) => ({
    id,
    status: 'admitted',
    exitCode: null,
    sessionId: null,
    branchName: `slice/${id}`,
    worktreePath: null,
    elapsedSec: 0,
  }));

  // ── Phase 1: 准入 / 写集 / 冲突 / 预算 ─────────────────────────────
  console.log(`${title} — admitting ${ids.length} slices...`);

  for (const st of states) {
    const result = await scheduler.admit(st.id);
    if (result.decision !== 'admitted') {
      console.error(`  ❌ ${st.id}: ${result.reason}`);
      return { ...empty(), abortReason: `${st.id}: ${result.reason}`, aborted: true };
    }
  }

  // 先解析写集 —— 冲突检测要用的是生效写集，不是切片文件里那个原始值
  for (const id of ids) {
    const resolved = await resolveWriteSet(id);
    if (resolved.changed) {
      console.log(
        resolved.source === 'spec'
          ? `  ??  ${id}: write-set from spec: ${resolved.writes.join(', ')}`
          : `  ??  ${id}: auto-detected write-set: ${resolved.writes.join(', ')}`,
      );
    }
  }

  const slices = await Promise.all(ids.map((id) => store.read(id)));

  // 跨切片冲突：并行执行的切片不允许写同一批文件
  const conflicts = scheduler.checkConflicts(slices.map((s) => s.writes));
  if (conflicts.length > 0) {
    for (const [i, j] of conflicts) {
      console.error(`  ❌ Write-set conflict: ${ids[i]} ↔ ${ids[j]}`);
      console.error(`     "${ids[i]}" writes: ${slices[i].writes.join(', ')}`);
      console.error(`     "${ids[j]}" writes: ${slices[j].writes.join(', ')}`);
    }
    return {
      ...empty(),
      abortReason: `写集冲突：${conflicts.map(([i, j]) => `${ids[i]} ↔ ${ids[j]}`).join('，')}`,
      aborted: true,
    };
  }

  for (const id of ids) {
    const ok = await checkBudget(id);
    if (!ok) {
      return { ...empty(), abortReason: `${id}: 预算耗尽`, aborted: true };
    }
  }

  // ── Phase 2: 隔离 worktree + 写集预约守卫 ─────────────────────────
  const { execSync } = await import('node:child_process');
  const adapterType = options.adapterType;
  const agentName =
    options.agentName ?? resolveAgentCommand(adapterType ?? loadConfig().agent.adapter, undefined, loadConfig());

  // 每个切片一份运行时守卫（C9）：写集预约 + PreToolUse 钩子
  const guards = new Map<string, RuntimeGuard>();
  // 本轮已经 startRun（切片 → running）但**还没起 agent** 的切片。
  // 中止时它们要一起退回 frozen —— 见循环里的说明（D-64）。
  const startedThisRound: string[] = [];

  // 主仓有未提交改动时提醒：这些改动不会被带进 worktree
  try {
    const status = execSync('git status --porcelain', { encoding: 'utf-8', timeout: 5000 }).trim();
    if (status) {
      console.warn(`  ??  You have uncommitted changes in the main worktree. They are NOT copied into slice worktrees.`);
      console.warn(`       Commit them first if the slices depend on them.`);
    }
  } catch { /* ignore */ }

  // ADR-129：每片这一轮的起跑时刻 —— 第 i 片的事件流里 runId 用它算
  const runStartedAts: string[] = new Array(ids.length).fill('');
  for (let i = 0; i < ids.length; i++) {
    const st = states[i];
    const slice = slices[i];

    await scheduler.startRun(st.id);
    // ADR-129：起跑时刻 —— 必须在 agent 起跑**之前**取（与单片 D-49 同理）
    runStartedAts[i] = new Date().toISOString();
    // 记下「这一轮已经 startRun 过」—— 中止时要把它连同后面几片一起退回 frozen。
    //
    // 为什么不能只退失败的那一片（D-64）：并行批次里，第 2 片装守卫失败时，
    // 第 1 片已经被 startRun 推到 `running`、守卫也装了，但**agent 一次都没起**
    // （Phase 3 在整个循环之后才拉 agent）。整批 abort 时，第 1 片同样卡在
    // running —— 而且它的守卫会被 releaseGuards 摘掉，剩下一个
    // 「running 但没人管」的壳子。
    startedThisRound.push(st.id);

    // 约束包：规格路径 + 写集 + 保护域 + 相关策略规则 + 亲和上下文（只读建议）
    const affinityGroup = options.affinity?.get(st.id) ?? null;
    const affinityPrev = options.affinityPrevious?.get(st.id) ?? [];
    const affinityCtx =
      affinityGroup !== null
        ? await scheduler.buildAffinityContext(st.id, affinityGroup, affinityPrev)
        : null;
    const bundle = scheduler.buildConstraints(
      slice,
      affinityCtx,
      gateCommandsForSlice(slice),
      await scheduler.readFeedbackFor(st.id),
      await scheduler.readHumanFeedbackFor(st.id),
      gateScopeForSlice(slice) ?? undefined,
    );
    const bundlePath = join(ZELTO_DIR, `${st.id}-bundle.json`);
    writeFileSync(bundlePath, JSON.stringify(bundle, null, 2), 'utf-8');

    // 隔离 worktree —— 主仓分支全程不动
    // 不在 git 仓库里 → 无法隔离，退化为当前目录（与隔离功能出现之前的行为一致）
    let baseCommit: string | null = null;
    try {
      const wt: WorktreeInfo | null = await ensureWorktree(st.id, {
        baseCommitOverride: options.baseCommitOverride ?? null,
      });
      if (wt) {
        st.worktreePath = wt.path;
        baseCommit = wt.baseCommit;
        const wtBundleDir = join(wt.path, ZELTO_DIR);
        if (!existsSync(wtBundleDir)) mkdirSync(wtBundleDir, { recursive: true });
        writeFileSync(join(wtBundleDir, `${st.id}-bundle.json`), JSON.stringify(bundle, null, 2), 'utf-8');
      } else {
        console.warn(`  ⚠️  ${st.id}: 不在 git 仓库中，无法隔离 worktree，将在当前目录执行`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ❌ ${st.id}: 无法创建隔离 worktree: ${msg}`);
      // 切片已经被 startRun 推到 `running` 了 —— 退回去（D-64）。
      // 不退的话这片卡在 running，而「没开跑过的 running」连
      // `stall --reap` 都看不见（没有会话记录 → 活性判定不是 stale/dead）。
      await revertStartedRound(startedThisRound, `无法创建隔离 worktree: ${msg}`);
      await releaseGuards(guards);
      return { ...empty(), abortReason: `${st.id}: 无法创建隔离 worktree: ${msg}`, aborted: true };
    }

    // 写集预约 + PreToolUse 钩子（C9）
    try {
      const g = await installRuntimeGuard({
        sliceId: st.id,
        writes: bundle.writes,
        worktree: st.worktreePath,
        projectRoot: process.cwd(),
        baseCommit,
        managedPaths: zeltoOwnedPaths(st.worktreePath, slice),
        // ADR-106 §2：规格在写集里 → 不托管，但「冻结需求仍在」是硬约束。
        specIntegrity: buildSpecIntegrity(st.worktreePath, slice),
        // 装哪种 harness 的钩子（ADR-083）—— adapter 决定跑的是谁。
        harness: harnessForAdapter(options.adapterType),
      });
      guards.set(st.id, g);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ❌ ${st.id}: 无法取得写集预约: ${msg}`);
      // 同上：agent 还没起（拿不到预约就 fail closed），切片必须退回 frozen（D-64）。
      await revertStartedRound(startedThisRound, `无法取得写集预约: ${msg}`);
      await releaseGuards(guards);
      return { ...empty(), abortReason: `${st.id}: 无法取得写集预约: ${msg}`, aborted: true };
    }

    await events.append(st.id, 'run.started', 'zelto', {
      sliceId: st.id,
      agent: agentName,
      bundlePath,
      writes: slice.writes,
      worktree: st.worktreePath ? worktreeManager().relativePathFor(st.id) : null,
      affinityGroup,
      previousSlices: affinityPrev,
      // ADR-129 一：并行路径与单片用同一口径算 runId
      runId: makeRunId(st.id, runStartedAts[i], 0),
    });
  }

  // ── Phase 3: 拉起 agent ────────────────────────────────────────────
  const adapters = states.map((st, i) => {
    const timeout = slices[i]?.agentTimeout;
    return createExecutorAdapter(adapterType, agentName, timeout, st.worktreePath ?? process.cwd());
  });

  // ── D-66：每片一个进展探针 ──────────────────────────────────────────
  // agent 每调用一次工具，PreToolUse 钩子就往**切片自己的事件流**写一条。
  // 事件流变长了 = 它还在推进 → 告诉适配器「空转倒计时重新开始」。
  //
  // 没有这一条，并行路径上的 agent 会在整整 timeoutMs 那一刻被砍掉，
  // 哪怕它一分钟都没停过（实测 nimrtc-zelto v4-ai-teammate，2026-11-18）。
  const progressProbes = new Map<string, SliceProgressProbe>();
  for (const st of states) {
    progressProbes.set(st.id, new SliceProgressProbe(process.cwd(), st.id));
  }

  const startTime = Date.now();
  console.log(`\n${title} — starting ${ids.length} agents...`);

  // 安全点 ①：拉起之前先看有没有人喊停
  // 喊停了就不该再开新 agent —— 已跑起来的那个会在安全点 ② 收手。
  //
  // 用 `isBlockingNewWork`：**过期的请求不再拦新工作**（ZD-023）。
  // 「这块地方我一会儿再处理」本来就是临时状态；刹车踩下没人松，
  // 不该把后面大半个工作日都堵死。安全点 ②（停正在跑的活）不看过期。
  const haltBeforeStart = await haltStore.isBlockingNewWork(haltScope);
  if (haltBeforeStart) {
    haltReason = haltBeforeStart.reason;
    console.log(`⏸️  已拉闸（${haltBeforeStart.reason}）—— 本批次不再启动新的 agent`);
    await events.append(options.eventKey ?? haltScope, 'batch.halted', 'human', {
      scope: haltScope,
      reason: haltBeforeStart.reason,
      stage: 'before_start',
      slices: ids,
    });
  }

  for (let i = 0; i < states.length; i++) {
    const st = states[i];
    const adapter = adapters[i];
    const bundlePath = join(ZELTO_DIR, `${st.id}-bundle.json`);

    // 安全点 ①（逐片）：批次跑到一半人才喊停的，后面的 agent 不再开
    if (haltBeforeStart || (await haltStore.isBlockingNewWork(haltScope))) {
      st.status = 'failed';
      st.exitCode = null;
      haltedIds.add(st.id);
      continue;
    }

    try {
      let sessionId: string | undefined;
      ({ sessionId } = await adapter.start({ sliceId: st.id, prompt: bundlePath }));
      st.sessionId = sessionId;
      st.status = 'running';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ❌ ${st.id}: failed to start agent: ${msg}`);
      st.status = 'failed';
    }
  }

  // ── Phase 4: 进度显示 ──────────────────────────────────────────────
  const statusLineCount = states.length + 2; // 表头 + N 个切片 + 空行
  let progressTimer: ReturnType<typeof setInterval> | null = null;

  function renderProgress(): void {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const lines: string[] = [];
    const running = states.filter((s) => s.status === 'running').length;
    const done = states.filter((s) => s.status === 'completed' || s.status === 'failed').length;
    lines.push(`  ⏱️  ${elapsed}s elapsed — ${running} running, ${done} done`);
    for (const st of states) {
      const icon = st.status === 'completed' ? '✅' : st.status === 'failed' ? '❌' : st.status === 'running' ? '🔄' : '⏳';
      const elapsedStr = st.elapsedSec > 0 ? `${st.elapsedSec}s` : st.status !== 'admitted' ? `${Math.floor((Date.now() - startTime) / 1000)}s` : '—';
      const exitStr = st.exitCode !== null ? ` exit=${st.exitCode}` : '';
      lines.push(`    ${icon} ${st.id.padEnd(22)} ${elapsedStr.padEnd(6)}${exitStr}`);
    }
    process.stdout.write(`\x1b[${statusLineCount}A` + lines.join('\n') + '\n');

    if (done === states.length && progressTimer) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
  }

  {
    const lines: string[] = [];
    lines.push(`  ⏱️  0s elapsed — ${states.length} starting...`);
    for (const st of states) {
      lines.push(`    ⏳ ${st.id.padEnd(22)} —`);
    }
    console.log(lines.join('\n'));
  }

  progressTimer = setInterval(renderProgress, 2000);

  // ── Phase 5: 等待全部结束（逐片重试）──────────────────────────────
  const config = loadConfig();
  const maxRetries = config.agent.maxRetries ?? 2;

  // ZD-007：预算上限（美元）。`0` = 不限 → 没有闸门。
  //
  // 与单片路径**同一口径**（同一个 `BudgetCollector.getLimit`）——
  // 两处漂移的后果是「单片按 $1 拦、并行按 $100 拦」。
  const budgetLimitUsd = await readBudgetLimit();

  const results = await Promise.allSettled(
    states.map(async (st, i) => {
      if (haltedIds.has(st.id)) {
        return { ...st, exitCode: null, status: 'halted' as const };
      }
      if (st.sessionId === null) return { ...st, exitCode: -1, status: 'failed' as const };

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        // 安全点 ②：等 agent 的时候也在听拉闸
        // 喊停 → 停掉这个 agent → 现场保留（worktree / 预约都还在）
        //
        // ZD-007：同一处也在听**预算闸门** —— 并行路径同样会烧钱，
        // 而且并行时烧得更快（一批 agent 同时跑）。
        const budgetGuard = budgetLimitUsd !== null
          ? createRuntimeBudgetGuard({
              adapter: adapters[i],
              sessionId: st.sessionId,
              limitUsd: budgetLimitUsd,
            })
          : null;
        const exitCode = await waitForExitOrHalt(
          adapters[i],
          st.sessionId,
          haltStore,
          haltScope,
          progressProbes.get(st.id),
          budgetGuard ?? undefined,
        );
        st.exitCode = exitCode.exitCode;
        st.elapsedSec = Math.floor((Date.now() - startTime) / 1000);

        // 记账（ADR-041 §3.1 / ADR-092）：每次 agent 进程结束 = 一条运行记录。
        // 重试会另起一个 agent，所以重试一次就多一条 —— 记录的是「跑过几次」，
        // 不是「这一轮批次的最终结论」。口径与前台单片一致（ADR-092）。
        await store.recordRun(st.id, {
          ok: exitCode.exitCode === 0,
          exitCode: exitCode.exitCode,
          phase: 'parallel',
          attempt: attempt + 1,
        });

        if (exitCode.budgetExceeded) {
          // 与「拉闸」**分开**处理（ZD-007）：
          // 不是人喊停，是闸门拦下的 —— 记成 failed 会让人以为「跑砸了」，
          // 于是重跑 → 再烧一遍钱。
          st.status = 'failed';
          budgetExhaustedIds.add(st.id);
          budgetSpent.set(st.id, {
            spentUsd: exitCode.spentUsd ?? 0,
            limitUsd: exitCode.limitUsd ?? 0,
          });
          await events.append(st.id, 'run.aborted', 'zelto', {
            sliceId: st.id,
            exitCode: null,
            reason: 'budget_exhausted',
            budgetExceeded: true,
            spentUsd: exitCode.spentUsd,
            limitUsd: exitCode.limitUsd,
          });
          await events.append(st.id, 'stall.classified', 'zelto', {
            sliceId: st.id,
            class: 'budget_exhausted',
            spent: exitCode.spentUsd,
            limit: exitCode.limitUsd,
          });
          return { ...st, exitCode: null, status: 'halted' as const };
        }

        if (exitCode.halted) {
          st.status = 'failed';
          haltedIds.add(st.id);
          haltReason = exitCode.reason ?? haltReason;
          await events.append(st.id, 'batch.halted', 'human', {
            scope: haltScope,
            reason: exitCode.reason ?? '',
            sliceId: st.id,
          });
          return { ...st, exitCode: null, status: 'halted' as const };
        }

        if (exitCode.exitCode === 0) {
          st.status = 'completed';
          return st;
        }

        // 失败 —— 按配置在 CLI 层自动重试
        let stalled = false;
        if (attempt < maxRetries) {
          await events.append(st.id, 'run.aborted', 'zelto', { sliceId: st.id, exitCode: exitCode.exitCode });
          const result = await handleAgentFailure(st.id, exitCode.exitCode, { maxRetries });
          if (result.action === 'retry') {
            const timeout = slices[i]?.agentTimeout;
            adapters[i] = createExecutorAdapter(
              adapterType,
              agentName,
              timeout,
              st.worktreePath ?? process.cwd(),
            );
            const bundlePath = join(ZELTO_DIR, `${st.id}-bundle.json`);
            try {
              // 超时重试接着上一次跑，不从头再来（ADR-055）
              const previousSessionId: string | null = st.sessionId;
              let resumedSessionId: string | null = null;
              if (previousSessionId && typeof adapters[i].continueSession === 'function') {
                try {
                  const resumed = await adapters[i].continueSession(
                    previousSessionId,
                    '继续完成这个切片。上一次运行超时被中止了，' +
                    '工作区里已经有你之前做出的改动 —— 先检查当前状态，' +
                    '补完没做完的部分，不要从头重做已经做完的事。',
                  );
                  resumedSessionId = resumed.sessionId;
                } catch {
                  resumedSessionId = null;
                }
              }
              const sessionId: string = resumedSessionId
                ?? (await adapters[i].start({ sliceId: st.id, prompt: bundlePath })).sessionId;
              st.sessionId = sessionId;
              st.status = 'running';
              continue; // 重试
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`  ❌ ${st.id}: retry start failed: ${msg}`);
            }
          }
          // handleAgentFailure 返回 'stall' 时，它**已经**把切片停机了
          // （退 frozen + 写分类 + 留痕）—— 不再重复一遍。
          stalled = result.action === 'stall';
        }

        // 不再重试 —— 最终失败
        if (!stalled) {
          await events.append(st.id, 'run.aborted', 'zelto', {
            sliceId: st.id,
            runId: makeRunId(st.id, runStartedAts[i], attempt + 1),
            exitCode: exitCode.exitCode,
          });
          // 停机标记（ADR-047）：并行路径原本**完全不写停机** ——
          // 只有单片路径写。于是并行批次里失败的切片既没有停机分类，
          // 也没有退回 frozen：人看不见它卡住了，而它还占着写集，
          // 继续阻塞别的切片（准入只认 frozen / completed）。
          // 走「停机的唯一落点」：退 frozen + 写分类 + 留痕。
          await markSliceStalled(st.id, classifyStall({
            type: exitCode.exitCode === null ? 'build_failure' : 'test_failure',
            message: `Agent exited with code ${exitCode.exitCode ?? 'signal'}`,
            attempts: 1,
          }), {
            exitCode: exitCode.exitCode,
            reason: `agent failed: ${exitCode.exitCode ?? 'signal'}`,
          });
        }
        st.status = 'failed';
        return st;
      }

      st.status = 'failed';
      return st;
    }),
  );

  if (progressTimer) {
    clearInterval(progressTimer);
  }
  process.stdout.write(`\x1b[${statusLineCount}A` + ' '.repeat(80) + '\n');

  // ── Phase 6: 逐片收尾（写集审计 → 门禁 → 签名请求）─────────────────
  console.log('');
  const outcomes: SliceOutcome[] = [];

  for (const result of results) {
    if (result.status === 'rejected') {
      outcomes.push({
        id: states.find((s) => s.status === 'failed')?.id ?? 'unknown',
        status: 'failed',
        exitCode: -1,
        elapsedSec: 0,
        gatePassed: null,
        signRequested: false,
      });
      continue;
    }

    const st = result.value;

    // ── 被**预算闸门**拦下的切片（ZD-007）─────────────────────────────
    //
    // 与「被拉闸打断」**分开处置** —— 两者原因不同：
    // - 拉闸 = 人喊停 → `stall.class = human_halt`；
    // - 预算 = 闸门拦下 → `stall.class = budget_exhausted`。
    //
    // 混为一谈的后果：人看到「halted」会去 `zelto halt --clear` 找原因，
    // 而真相是「钱烧完了」—— 找错了地方，还以为闸门坏了。
    //
    // 共同点：**现场保留**（worktree / 预约都不动）——
    // 产物可能已经写好了，人要先看现场再决定是放行还是重来。
    if (budgetExhaustedIds.has(st.id)) {
      // 回退：running → frozen。准入只认 frozen/completed，
      // 不退回去切片会永远卡在 running（ADR-020 §3.2 同理）。
      let reverted = false;
      try {
        await store.transit(st.id, 'RUN_FINISH');
        reverted = true;
      } catch {
        // 状态被别处改过 —— 事件照样留
      }

      outcomes.push({
        id: st.id,
        status: 'failed',
        exitCode: null,
        elapsedSec: st.elapsedSec,
        gatePassed: null,
        signRequested: false,
      });
      const spent = budgetSpent.get(st.id);
      console.log(
        `⛔  ${st.id}: 预算闸门拦下（$${spent?.spentUsd.toFixed(4) ?? '?'} / ` +
          `上限 $${spent?.limitUsd.toFixed(4) ?? '?'}）—— 现场保留，等人处理`,
      );
      console.log('   注意：这不是「agent 跑砸了」，是「闸门在运行中拦下的」。产物可能已经写好了 —— 先看现场，别直接重跑。');
      if (reverted) {
        console.log(`   状态: → frozen（stall: budget_exhausted）`);
        console.log(`   继续: 调高 budgetLimitUsd 后 zelto resume ${st.id} → zelto run ${st.id}`);
      }
      continue;
    }

    // 被拉闸打断的切片：不进门禁、不发签名请求 —— 现场交回给人
    if (st.status === 'halted' || haltedIds.has(st.id)) {
      // 回退：running → frozen，并标记 stall.class='human_halt'。
      // 不做这一步，切片会永远卡在 running —— 准入只认 frozen/completed，
      // 于是「处理完继续」这条路直接断了（ADR-020 §3.2）。
      const rollback = await rollbackHaltedSlice(store, events, st.id, {
        reason: haltReason ?? '人工拉闸',
        scope: haltScope,
      });

      outcomes.push({
        id: st.id,
        status: 'halted',
        exitCode: null,
        elapsedSec: st.elapsedSec,
        gatePassed: null,
        signRequested: false,
      });
      console.log(`⏸️  ${st.id}: 已拉闸 —— 现场保留，等人处理（zelto halt --clear 后重跑）`);
      if (rollback.reverted) {
        console.log(`   状态: ${rollback.from} → ${rollback.to}（stall: human_halt）`);
        console.log(`   继续: zelto resume ${st.id} → zelto run ${st.id}`);
      }
      continue;
    }

    if (st.exitCode !== 0) {
      // agent 失败也要审计 —— 失败的那一轮同样可能写了越界的文件。
      // 不审计就等于并行路径上没有兜底：C9 的「运行后 git 审计兜底」在这里是空的。
      const failedVerdict = await enforceWriteSet(st.id, guards.get(st.id) ?? null);
      const failedLines = writeSetOutcomeLines({ sliceId: st.id, compact: true }, failedVerdict);
      if (failedLines.length > 0) {
        printOutcome(failedLines);
      }
      outcomes.push({
        id: st.id,
        status: 'failed',
        exitCode: st.exitCode,
        elapsedSec: st.elapsedSec,
        gatePassed: null,
        signRequested: false,
      });
      printOutcome(agentFailedMessage({ sliceId: st.id, compact: true }, st.exitCode, 1, st.elapsedSec ?? 0));
      continue;
    }

    // 提问回路：某个切片以问题收尾 → 只挂起该切片，批次里其它切片不受影响（ADR-013 §3.5）
    const idx = states.findIndex((s) => s.id === st.id);
    const adapter = idx >= 0 ? adapters[idx] : undefined;
    const sessionId = st.sessionId;
    const question = adapter && sessionId ? await detectQuestion(st.id, adapter, sessionId) : null;

    if (question) {
      await suspendSliceForQuestion(st.id, question);
      console.log(`❓ ${st.id}: asked a question (${question.type}) — suspended`);
      console.log(`   ${question.question}`);
      console.log(`   Answer with: zelto answer ${question.id} "<your answer>"`);
      outcomes.push({
        id: st.id,
        status: 'asked',
        exitCode: 0,
        elapsedSec: st.elapsedSec,
        gatePassed: null,
        signRequested: false,
        question: { id: question.id, question: question.question },
      });
      continue;
    }

    // 写集审计（ADR-014 §5）—— 越界就不进 gate
    //
    // `enforceWriteSet` 已经把切片退回 frozen 并写了 `run.aborted` 事件，
    // 这里不再重复写事件（append-only 事件流里重复条目只会让人误以为发生了两次）。
    const verdict = await enforceWriteSet(st.id, guards.get(st.id) ?? null);
    if (!verdict.ok) {
      printOutcome(writeSetOutcomeLines({ sliceId: st.id, compact: true }, verdict));
      outcomes.push({
        id: st.id,
        status: 'stalled',
        exitCode: 0,
        elapsedSec: st.elapsedSec,
        gatePassed: null,
        signRequested: false,
      });
      continue;
    }

    await store.transit(st.id, 'RUN_FINISH');
    const finishedAffinity = options.affinity?.get(st.id) ?? null;
    // 花费结算（ADR-035）：先记账，再复判预算；超预算则该片不进 gate。
    const cost = adapter && sessionId
      ? await settleRunCost(st.id, adapter, sessionId)
      : { costUsd: null, exhausted: false, spent: 0, limit: Number.POSITIVE_INFINITY };
    await events.append(st.id, 'run.finished', 'zelto', {
      sliceId: st.id,
      exitCode: 0,
      costUsd: cost.costUsd,
      affinityGroup: finishedAffinity,
      // ADR-129：并行路径没有 CLI 层重试，attempt 恒为 0
      runId: makeRunId(st.id, runStartedAts[idx >= 0 ? idx : 0] ?? '', 0),
    });
    console.log(`✅ ${st.id}: completed (${st.elapsedSec}s)`);

    if (cost.exhausted) {
      // 超预算：停在 frozen 等人 —— 不进 gate、不发签字请求（ADR-035 §3.5）。
      printOutcome(budgetExhaustedMessage({ sliceId: st.id, compact: true }, cost.spent, cost.limit));
      outcomes.push({
        id: st.id,
        status: 'stalled',
        exitCode: 0,
        elapsedSec: st.elapsedSec,
        gatePassed: null,
        signRequested: false,
      });
      continue;
    }

    let gatePassed: boolean | null = null;
    let signRequested = false;
    if (autoGate) {
      await autoGateAfterRun(st.id);
      const after = await store.read(st.id).catch(() => null);
      gatePassed = after?.state === 'completed';
      signRequested = gatePassed;
    }

    outcomes.push({
      id: st.id,
      status: 'completed',
      exitCode: 0,
      elapsedSec: st.elapsedSec,
      gatePassed,
      signRequested,
    });
  }

  // 被拉闸的切片保留预约与钩子 —— 现场交回给人（ADR-020 §3.5）。
  // 释放预约会让仍在跑（或没死透）的 agent 失去写集约束（C9）。
  //
  // ZD-007：被**预算闸门**拦下的切片**同样保留** ——
  // agent 是被 stop() 叫停的，可能没死透（进程还在收尾），
  // 释放了预约它就失去写集约束了。
  const keptGuards: string[] = [];
  for (const [id, guard] of guards) {
    if (haltedIds.has(id) || budgetExhaustedIds.has(id)) {
      keptGuards.push(id);
      continue;
    }
    try {
      await guard.release();
    } catch {
      // 释放失败不阻断：残留的预约会被 reap 清理
    }
  }
  if (keptGuards.length > 0) {
    console.log(`⏸️  ${keptGuards.join(', ')}: 写集预约保留 —— 处理完用 zelto reservation release <id> 释放`);
  }

  const completed = outcomes.filter((o) => o.status === 'completed').length;
  const asked = outcomes.filter((o) => o.status === 'asked').length;
  const failed = outcomes.filter((o) => o.status === 'failed').length;
  const stalled = outcomes.filter((o) => o.status === 'stalled').length;
  const halted = outcomes.filter((o) => o.status === 'halted').length;

  return {
    outcomes,
    completed,
    failed,
    stalled,
    asked,
    halted,
    haltScope,
    ok: failed === 0 && stalled === 0 && asked === 0 && halted === 0,
    aborted: false,
    abortReason: null,
    skipped: [],
  };
}

// ─── 分阶段执行（G-1 依赖分层 + G-2 写集冲突降级）────────────────────────

export interface PhasedExecutionOptions extends ParallelExecutionOptions {
  /**
   * 执行阶段：阶段内切片互不冲突可并行，阶段之间串行。
   * 由 core/sched/batch.ts 的 planExecutionPhases() 排出来。
   */
  phases: string[][];
  /** 事件归属键（版本级用 version-<label>，run --parallel 用 batch） */
  eventKey?: string;
}

/**
 * 按阶段顺序执行一批切片。
 *
 * 与 executeSlicesParallel 的关系：单个阶段的执行语义完全一样
 * （同一份隔离 worktree、写集预约守卫、门禁②、签名请求），
 * 区别只在于「阶段之间串行」——依赖要求后面的切片看到前面切片的产物，
 * 写集冲突要求同一批文件不能被两个 agent 同时改。
 *
 * 某个阶段没过（失败 / 停机 / 提问）就停在这里，不启动后面的阶段：
 * 依赖没满足就跑下去，跑出来的多半也是错的，不如把控制权交回给人。
 */
export async function executeSlicesByPhase(
  options: PhasedExecutionOptions,
): Promise<ParallelExecutionResult> {
  const phases = options.phases.filter((p) => p.length > 0);

  const eventKey = options.eventKey ?? 'batch';
  const outcomes: SliceOutcome[] = [];
  const skipped: string[] = [];
  let ok = true;

  // 阶段之间是安全点：人在这两阶段之间喊停，后面的阶段不再启动
  const haltStore = new HaltStore(ZELTO_DIR);
  const haltScope = options.haltScope ?? eventKey;

  if (phases.length === 0) {
    return {
      outcomes: [],
      completed: 0,
      failed: 0,
      stalled: 0,
      asked: 0,
      halted: 0,
      haltScope,
      ok: false,
      aborted: true,
      abortReason: '没有要执行的阶段',
      skipped: [],
    };
  }

  for (let p = 0; p < phases.length; p++) {
    const phaseIds = phases[p];
    const parallel = phaseIds.length > 1 ? `（${phaseIds.length} 个并行）` : '';

    // 安全点 ③：阶段之间检查拉闸
    //
    // 这一条是「要不要开始新工作」→ 过期的请求不再拦（ZD-023）。
    if (p > 0) {
      const haltReq = await haltStore.isBlockingNewWork(haltScope);
      if (haltReq) {
        console.log('');
        console.log(`⏸️  已拉闸（${haltReq.reason}）—— 后续 ${phases.length - p} 个阶段不再启动`);
        await events.append(eventKey, 'batch.halted', 'human', {
          scope: haltScope,
          reason: haltReq.reason,
          stage: 'between_phases',
          phase: p,
          slices: phases.slice(p).flat(),
        });
        skipped.push(...phases.slice(p).flat());
        ok = false;
        break;
      }
    }

    console.log('');
    console.log(`── 阶段 ${p + 1}/${phases.length}: ${phaseIds.join(', ')} ${parallel}`);

    const affinityRecord: Record<string, string | null> = {};
    for (const id of phaseIds) {
      affinityRecord[id] = options.affinity?.get(id) ?? null;
    }
    await events.append(eventKey, 'coord.phase_ready', 'zelto', {
      phase: p,
      slices: phaseIds,
      totalPhases: phases.length,
      affinity: affinityRecord,
    });

    const result = await executeSlicesParallel({
      ...options,
      ids: phaseIds,
      title: options.title ?? 'zelto run --parallel',
    });

    if (result.aborted) {
      await events.append(eventKey, 'coord.phase_complete', 'zelto', {
        phase: p,
        slices: phaseIds,
        ok: false,
        aborted: true,
        reason: result.abortReason,
      });
      outcomes.push(...result.outcomes);
      skipped.push(...phases.slice(p + 1).flat());
      return {
        outcomes,
        completed: 0,
        failed: 0,
        stalled: 0,
        asked: 0,
        halted: outcomes.filter((o) => o.status === 'halted').length,
        haltScope,
        ok: false,
        aborted: true,
        abortReason: result.abortReason,
        skipped,
      };
    }

    outcomes.push(...result.outcomes);

    await events.append(eventKey, 'coord.phase_complete', 'zelto', {
      phase: p,
      slices: phaseIds,
      ok: result.ok,
    });

    if (!result.ok) {
      ok = false;
      skipped.push(...phases.slice(p + 1).flat());
      if (phases.length > p + 1) {
        console.log('');
        console.log(`⏸️  阶段 ${p + 1} 未全部通过 —— 后续 ${phases.length - p - 1} 个阶段不再启动`);
      }
      break;
    }
  }

  const completed = outcomes.filter((o) => o.status === 'completed').length;
  const asked = outcomes.filter((o) => o.status === 'asked').length;
  const failed = outcomes.filter((o) => o.status === 'failed').length;
  const stalled = outcomes.filter((o) => o.status === 'stalled').length;
  const halted = outcomes.filter((o) => o.status === 'halted').length;

  return {
    outcomes,
    completed,
    failed,
    stalled,
    asked,
    halted,
    haltScope,
    ok: ok && failed === 0 && stalled === 0 && asked === 0 && halted === 0,
    aborted: false,
    abortReason: null,
    skipped,
  };
}
