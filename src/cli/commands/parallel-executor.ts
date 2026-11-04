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
import { autoGateAfterRun, checkBudget, handleAgentFailure, resolveWriteSet } from './run-support.js';
import {
  type RuntimeGuard,
  enforceWriteSet,
  installRuntimeGuard,
  releaseGuards,
} from './runtime-guard.js';
import { detectQuestion, suspendSliceForQuestion } from './question.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/** 单个切片在并行批次里的结局 */
export type SliceOutcomeStatus = 'completed' | 'failed' | 'stalled' | 'asked';

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
}

export interface ParallelExecutionResult {
  outcomes: SliceOutcome[];
  completed: number;
  failed: number;
  stalled: number;
  asked: number;
  /** 是否全部走完且没有失败/停机 */
  ok: boolean;
  /** 准入 / 冲突 / 预算阶段就退出了 —— 一个 agent 都没跑起来 */
  aborted: boolean;
  /** 提前退出的原因 */
  abortReason: string | null;
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
  console.log(`?? 并行批次结束：${result.completed} 通过，${result.stalled} 停机，${result.asked} 待回答`);

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

  const empty = (): ParallelExecutionResult => ({
    outcomes: [],
    completed: 0,
    failed: 0,
    stalled: 0,
    asked: 0,
    ok: false,
    aborted: false,
    abortReason: null,
  });

  if (ids.length === 0) {
    return { ...empty(), abortReason: '没有要执行的切片', aborted: true };
  }

  const scheduler = new Scheduler(store, events, loadPolicyConfig());

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

    // 约束包：规格路径 + 写集 + 保护域 + 相关策略规则
    const bundle = scheduler.buildConstraints(slice);
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
    });
  }

  // ── Phase 3: 拉起 agent ────────────────────────────────────────────
  const adapters = states.map((st, i) => {
    const timeout = slices[i]?.agentTimeout;
    return createExecutorAdapter(adapterType, agentName, timeout, st.worktreePath ?? process.cwd());
  });

  const startTime = Date.now();
  console.log(`\n${title} — starting ${ids.length} agents...`);

  for (let i = 0; i < states.length; i++) {
    const st = states[i];
    const adapter = adapters[i];
    const bundlePath = join(ZELTO_DIR, `${st.id}-bundle.json`);
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
      if (st.sessionId === null) return { ...st, exitCode: -1, status: 'failed' as const };

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const exitCode = await adapters[i].waitForExit(st.sessionId);
        st.exitCode = exitCode;
        st.elapsedSec = Math.floor((Date.now() - startTime) / 1000);

        if (exitCode === 0) {
          st.status = 'completed';
          return st;
        }

        // 失败 —— 按配置在 CLI 层自动重试
        if (attempt < maxRetries) {
          await events.append(st.id, 'run.aborted', 'zelto', { sliceId: st.id, exitCode });
          const result = await handleAgentFailure(st.id, exitCode, { maxRetries });
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
        await events.append(st.id, 'run.aborted', 'zelto', { sliceId: st.id, exitCode });
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
    await events.append(st.id, 'run.finished', 'zelto', { sliceId: st.id, exitCode: 0 });
    console.log(`✅ ${st.id}: completed (${st.elapsedSec}s)`);

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

  await releaseGuards(guards);

  const completed = outcomes.filter((o) => o.status === 'completed').length;
  const asked = outcomes.filter((o) => o.status === 'asked').length;
  const failed = outcomes.filter((o) => o.status === 'failed').length;
  const stalled = outcomes.filter((o) => o.status === 'stalled').length;

  return {
    outcomes,
    completed,
    failed,
    stalled,
    asked,
    ok: failed === 0 && stalled === 0 && asked === 0,
    aborted: false,
    abortReason: null,
  };
}
