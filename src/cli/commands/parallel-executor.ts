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
import { HaltStore, rollbackHaltedSlice } from '../../core/halt/index.js';
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
} from './shared.js';
import { autoGateAfterRun, checkBudget, handleAgentFailure, resolveWriteSet, settleRunCost } from './run-support.js';
import {
  type RuntimeGuard,
  enforceWriteSet,
  installRuntimeGuard,
  releaseGuards,
} from './runtime-guard.js';
import { detectQuestion, suspendSliceForQuestion } from './question.js';

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
 */
export function zeltoOwnedPaths(worktreePath: string | null, slice: SliceData): string[] {
  if (!worktreePath) return [];

  const paths: string[] = [];
  if (slice.spec.path) paths.push(slice.spec.path);
  if (slice.acceptance.dir) {
    paths.push(...listFilesUnder(worktreePath, slice.acceptance.dir));
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
 * C3：只读文件、比对作用域，没有模型参与。
 */
export async function waitForExitOrHalt(
  adapter: { waitForExit(id: string): Promise<number | null>; stop(id: string): Promise<void> },
  sessionId: string,
  haltStore: HaltStore,
  scope: string,
): Promise<ExitOrHalt> {
  let finished = false;
  let halted = false;
  let reason: string | undefined;

  // 轮询器：看到暂停请求就停掉 agent；agent 先退出就自己收摊
  const watcher = (async () => {
    while (!finished) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (finished) return;
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

  return { exitCode, halted, reason };
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

  /** 被拉闸打断、没能跑起来的切片 */
  const haltedIds = new Set<string>();

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
  const agentName = options.agentName ?? loadConfig().agent.command;
  const adapterType = options.adapterType;

  // 每个切片一份运行时守卫（C9）：写集预约 + PreToolUse 钩子
  const guards = new Map<string, RuntimeGuard>();

  // 主仓有未提交改动时提醒：这些改动不会被带进 worktree
  try {
    const status = execSync('git status --porcelain', { encoding: 'utf-8', timeout: 5000 }).trim();
    if (status) {
      console.warn(`  ??  You have uncommitted changes in the main worktree. They are NOT copied into slice worktrees.`);
      console.warn(`       Commit them first if the slices depend on them.`);
    }
  } catch { /* ignore */ }

  for (let i = 0; i < ids.length; i++) {
    const st = states[i];
    const slice = slices[i];

    await scheduler.startRun(st.id);

    // 约束包：规格路径 + 写集 + 保护域 + 相关策略规则 + 亲和上下文（只读建议）
    const affinityGroup = options.affinity?.get(st.id) ?? null;
    const affinityPrev = options.affinityPrevious?.get(st.id) ?? [];
    const affinityCtx =
      affinityGroup !== null
        ? await scheduler.buildAffinityContext(st.id, affinityGroup, affinityPrev)
        : null;
    const bundle = scheduler.buildConstraints(slice, affinityCtx);
    const bundlePath = join(ZELTO_DIR, `${st.id}-bundle.json`);
    writeFileSync(bundlePath, JSON.stringify(bundle, null, 2), 'utf-8');

    // 隔离 worktree —— 主仓分支全程不动
    // 不在 git 仓库里 → 无法隔离，退化为当前目录（与隔离功能出现之前的行为一致）
    let baseCommit: string | null = null;
    try {
      const wt: WorktreeInfo | null = await ensureWorktree(st.id);
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
      });
      guards.set(st.id, g);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ❌ ${st.id}: 无法取得写集预约: ${msg}`);
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
    });
  }

  // ── Phase 3: 拉起 agent ────────────────────────────────────────────
  const adapters = states.map((st, i) => {
    const timeout = slices[i]?.agentTimeout;
    return createExecutorAdapter(adapterType, agentName, timeout, st.worktreePath ?? process.cwd());
  });

  const startTime = Date.now();
  console.log(`\n${title} — starting ${ids.length} agents...`);

  // 安全点 ①：拉起之前先看有没有人喊停
  // 喊停了就不该再开新 agent —— 已跑起来的那个会在安全点 ② 收手。
  const haltBeforeStart = await haltStore.isHalted(haltScope);
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
    if (haltBeforeStart || (await haltStore.isHalted(haltScope))) {
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

  const results = await Promise.allSettled(
    states.map(async (st, i) => {
      if (haltedIds.has(st.id)) {
        return { ...st, exitCode: null, status: 'halted' as const };
      }
      if (st.sessionId === null) return { ...st, exitCode: -1, status: 'failed' as const };

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        // 安全点 ②：等 agent 的时候也在听拉闸
        // 喊停 → 停掉这个 agent → 现场保留（worktree / 预约都还在）
        const exitCode = await waitForExitOrHalt(
          adapters[i],
          st.sessionId,
          haltStore,
          haltScope,
        );
        st.exitCode = exitCode.exitCode;
        st.elapsedSec = Math.floor((Date.now() - startTime) / 1000);

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
              const { sessionId } = await adapters[i].start({ sliceId: st.id, prompt: bundlePath });
              st.sessionId = sessionId;
              st.status = 'running';
              continue; // 重试
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`  ❌ ${st.id}: retry start failed: ${msg}`);
            }
          }
        }

        // 不再重试 —— 最终失败
        await events.append(st.id, 'run.aborted', 'zelto', { sliceId: st.id, exitCode: exitCode.exitCode });
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
      outcomes.push({
        id: st.id,
        status: 'failed',
        exitCode: st.exitCode,
        elapsedSec: st.elapsedSec,
        gatePassed: null,
        signRequested: false,
      });
      console.log(`❌ ${st.id}: agent failed (exit ${st.exitCode})`);
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
    const withinBounds = await enforceWriteSet(st.id, guards.get(st.id) ?? null);
    if (!withinBounds) {
      console.log(`❌ ${st.id}: 写集越界 — 未进入 gate，等人处理`);
      await events.append(st.id, 'run.aborted', 'zelto', {
        sliceId: st.id, exitCode: 0, reason: 'write-set violation',
      });
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
      sliceId: st.id, exitCode: 0, costUsd: cost.costUsd, affinityGroup: finishedAffinity,
    });
    console.log(`✅ ${st.id}: completed (${st.elapsedSec}s)`);

    if (cost.exhausted) {
      // 超预算：停在 frozen 等人 —— 不进 gate、不发签字请求（ADR-035 §3.5）。
      console.log(`⛔ ${st.id}: 预算耗尽（$${cost.spent.toFixed(2)}）— 未进入 gate，等人处理`);
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
  const keptGuards: string[] = [];
  for (const [id, guard] of guards) {
    if (haltedIds.has(id)) {
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
    if (p > 0) {
      const haltReq = await haltStore.isHalted(haltScope);
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
