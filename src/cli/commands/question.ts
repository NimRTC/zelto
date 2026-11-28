// Question loop commands — `zelto ask` / `zelto answer`
//
// ADR-013: agent 提问回路。
// - `ask`    列出待答问题（文件队列 `.zelto/questions/`）
// - `answer` 回答问题并续跑同一个 agent 会话
//
// C1: 问题状态只落在文件里；C4: 每个动作写一条 append-only 事件。

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { QuestionStore, parseQuestion, type QuestionRecord } from '../../core/question/index.js';
import { findRunConclusion } from '../../core/sched/index.js';
import type { ExecutorAdapter } from '../../core/ports/executor.js';
import { register } from './shared.js';
import {
  store, events, ZELTO_DIR, loadConfig, createExecutorAdapter, resolveAgentCommand, existingWorktreePath,
} from './shared.js';
// 直接从 run-support 拿 autoGateAfterRun —— core-slice.ts 只是再导出它。
// 经 core-slice 绕一圈会形成 question.ts → core-slice.ts → question.ts 的环，
// 而 core-slice.ts 又 import 并行执行器，于是变成三条命令文件互相咬。
import { autoGateAfterRun, settleRunCost, markSliceStalled } from './run-support.js';
import { classifyStall } from '../../core/stall/classifier.js';
// ADR-142：配额识别（纯函数，在 core/stall/ 下 —— C3 判定层）
import { detectUsageLimit } from '../../core/stall/usage-limit.js';
import { budgetExhaustedMessage, printOutcome } from './run-messages.js';
// ADR-139：续跑段要重新装运行时守卫（C9 的主防线）。
// 装法在独立模块里 —— 它要的 `zeltoOwnedPaths` 住在 parallel-executor.ts，
// 而那个文件 import 了本文件（并行路径要检测提问），直接 import 会成环。
import { installResumeGuard } from './resume-guard.js';
import { enforceWriteSet, type RuntimeGuard } from './runtime-guard.js';

const QUESTIONS_DIR = join(ZELTO_DIR, 'questions');

function questionStore(): QuestionStore {
  return new QuestionStore({ baseDir: QUESTIONS_DIR });
}

/**
 * 回答后续跑沿用哪个 runId（ADR-130）。
 *
 * runId 取自任务文件（ADR-129 的权威来源），但任务文件是「当前状态」不是历史，
 * 必须先确认它说的那一轮**仍在等这次回答**：
 *
 *   - `status !== 'running'` / 没有 `runId` → 没有「本轮」可言，null；
 *   - 事件流里它已有 `run.finished` / `run.aborted` → 那轮已结束，null；
 *   - 事件流里它有 `run.started`，且之后停在 `agent_question` → 就是它。
 *
 * 确认不了 → null：适配器不注入 `ZELTO_RUN_ID`，hook 端退回 `derived:` 或如实留空
 * （ADR-130 二）—— 绝不拿一个可能属于别轮的 id 冒充本轮。
 *
 * 事件列表由调用方**一次性读入**（纯计算，C3）：调用发生在写 `run.resumed`
 * 之前，所以不存在「读到本次续跑自己刚写的事件」的循环。
 *
 * **注意 `run.resumed` 现在写在续跑之后**（ADR-140 决策五 —— 它要带
 * `sessionMode`，而通道要等握手完成才知道）。这不影响这里的判定：
 * `resumeRunIdForAnswer` 找的是 `run.started` + `stall.classified`，
 * `run.resumed` **不参与**判定 —— 少一条/晚一条都不影响结果。
 */
export function resumeRunIdForAnswer(sliceId: string, stream: ReadonlyArray<unknown>): string | null {
  const task = loadRunningTask(sliceId);
  if (!task?.runId) return null;
  if (findRunConclusion(stream, task.runId)) return null;

  let startedSeen = false;
  let pendingQuestion = false;
  for (const raw of stream) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as { type?: unknown; payload?: unknown };
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (e.type === 'run.started' && p.runId === task.runId) {
      startedSeen = true;
      pendingQuestion = false; // 新一轮起跑：之前的提问不算这一轮的状态
    } else if (e.type === 'stall.classified' && p.class === 'agent_question') {
      // 只有**这一轮起跑之后**的提问才属于它：更早的提问属于更早的轮次，
      // 不能因为「这个切片曾经停在提问上」就把任务文件的 runId 认作本轮。
      pendingQuestion = startedSeen;
    }
  }
  return startedSeen && pendingQuestion ? task.runId : null;
}

/**
 * 本切片「还在跑」的那份任务文件。
 *
 * 任务文件名是 taskId，**不能**按文件名认切片（id 里可能带 `-`，
 * `task-a-b-1` 与 `task-a-1` 无法从文件名区分）；一律读内容里的 `sliceId`。
 * 多份同时 `running` 时取落盘最晚的一份（`writtenAt` —— 监督进程会
 * 反复改写同一份文件，按文件名里的起跑时刻排会排错）。
 */
function loadRunningTask(sliceId: string): { runId?: string } | null {
  let files: string[];
  try {
    files = readdirSync(join(ZELTO_DIR, 'tasks')).filter((f) => f.endsWith('.json'));
  } catch {
    return null; // 没有任务目录 = 前台跑的那一轮
  }
  let latest: ({ runId?: string } & { writtenAt?: string }) | null = null;
  for (const f of files) {
    try {
      const parsed = JSON.parse(readFileSync(join(ZELTO_DIR, 'tasks', f), 'utf-8')) as {
        sliceId?: unknown;
        runId?: unknown;
        status?: unknown;
        writtenAt?: unknown;
      };
      if (parsed.sliceId !== sliceId || parsed.status !== 'running') continue;
      const writtenAt = typeof parsed.writtenAt === 'string' ? parsed.writtenAt : '';
      if (!latest || writtenAt > (latest.writtenAt ?? '')) {
        latest = {
          ...(typeof parsed.runId === 'string' ? { runId: parsed.runId } : {}),
          writtenAt,
        };
      }
    } catch {
      /* 单份损坏不影响其它候选 */
    }
  }
  return latest;
}

// ─── 提问检测与挂起（供 run 流程复用） ──────────────────────────────────────

/**
 * 读这一轮续跑**实际用哪条**通道（ADR-140）。
 *
 * 读不到 → null（适配器不实现 `getSessionMode`，或这一轮不是续跑）。
 * **null 不等于 `'new'`** —— 「不知道」与「确实是新会话」是两件事，
 * 不能混（混了会把「没实现这个能力」说成「上下文丢了」）。
 */
function readSessionMode(
  adapter: ExecutorAdapter,
  sessionId: string,
): 'resume' | 'load' | 'new' | null {
  if (typeof adapter.getSessionMode !== 'function') return null;
  try {
    return adapter.getSessionMode(sessionId);
  } catch {
    return null;
  }
}

/**
 * 取 agent 的输出文本（**永不抛**）—— ADR-142 配额识别用。
 *
 * 为什么要有这个包装：`getOutput()` 会读会话文件 —— 会话文件可能已经
 * 坏了、删了、或者适配器实现不同（有的读内存、有的读盘）。
 * 拿不到输出只意味着「识别不了配额」—— **不该因此崩掉整条失败路径**。
 *
 * 拿不到就返回空串 —— `detectUsageLimit('')` 返回「不是配额」。
 */
function readAgentOutput(adapter: ExecutorAdapter, sessionId: string): string {
  try {
    return adapter.getOutput(sessionId) ?? '';
  } catch {
    return '';
  }
}

/**
 * 检测 agent 输出末尾的问题标记，并把问题登记进队列。
 *
 * 纯确定性字符串解析（core/question/protocol.ts）——不调用模型。
 *
 * @returns 登记的问题记录；没有标记时返回 null
 */
export async function detectQuestion(
  sliceId: string,
  adapter: ExecutorAdapter,
  zeltoSessionId: string,
): Promise<QuestionRecord | null> {
  const output = adapter.getOutput(zeltoSessionId);
  const parsed = parseQuestion(output);
  if (!parsed) return null;

  const record = await questionStore().raise({
    sliceId,
    parsed,
    zeltoSessionId,
    agentSessionId: adapter.getAgentSessionId(zeltoSessionId),
    adapterName: adapter.name,
  });

  await events.append(sliceId, 'question.raised', 'agent', {
    sliceId,
    questionId: record.id,
    type: record.type,
    severity: record.severity,
    question: record.question,
    options: record.options,
  });

  return record;
}

/**
 * 把切片挂起在 `agent_question` 停机类上。
 *
 * 阻塞型问题必须等人回答，因此切片不跑门禁、不进签字流程。
 */
export async function suspendSliceForQuestion(
  sliceId: string,
  record: QuestionRecord,
): Promise<void> {
  const slice = await store.read(sliceId);
  slice.stall.class = 'agent_question';
  slice.stall.gateRetries = 0;
  await store.write(slice);

  await events.append(sliceId, 'stall.classified', 'zelto', {
    sliceId,
    class: 'agent_question',
    questionId: record.id,
    resolution: 'needs_attention',
  });
}

// ─── 列表渲染（ask 与 answer --list 共用） ──────────────────────────────────

function renderPendingQuestions(pending: QuestionRecord[]): void {
  if (pending.length === 0) {
    console.log('No pending questions.');
    return;
  }

  console.log(`Pending questions (${pending.length}):`);
  for (const q of pending) {
    console.log('');
    console.log(`  ${q.id}`);
    console.log(`    Slice:    ${q.sliceId}`);
    console.log(`    Type:     ${q.type} (${q.severity})`);
    console.log(`    Asked:    ${q.askedAt}`);
    console.log(`    Question: ${q.question}`);
    if (q.options.length > 0) {
      console.log(`    Options:  ${q.options.join(' | ')}`);
    }
    console.log(`    Answer:   zelto answer ${q.id} "<your answer>"`);
  }
}

// ─── zelto ask ──────────────────────────────────────────────────────────────

register('ask', async (args) => {
  const isJson = args.includes('--json');
  const sliceIdx = args.indexOf('--slice');
  const sliceFilter = sliceIdx !== -1 ? args[sliceIdx + 1] : undefined;

  if (args.includes('--help')) {
    console.log('Usage: zelto ask [--slice <slice-id>] [--json]');
    console.log('  列出 agent 提出的待答问题。');
    return 0;
  }

  const qs = questionStore();
  const pending = await qs.listPending(sliceFilter);

  if (isJson) {
    console.log(JSON.stringify({ questions: pending }, null, 2));
    return 0;
  }

  renderPendingQuestions(pending);
  return 0;
});

// ─── zelto answer ───────────────────────────────────────────────────────────

register('answer', async (args) => {
  if (args.includes('--help')) {
    console.log('Usage: zelto answer <question-id> "<answer>"');
    console.log('       zelto answer --list [--slice <slice-id>] [--json]');
    console.log('  回答问题，并在同一个 agent 会话里续跑该切片。');
    console.log('  --list 只列出待答问题（同 ask），不回答。');
    return 0;
  }

  // `--list`：只看队列，不回答（ADR-013 §3.7）
  if (args.includes('--list')) {
    const isJson = args.includes('--json');
    const sliceIdx = args.indexOf('--slice');
    const sliceFilter = sliceIdx !== -1 ? args[sliceIdx + 1] : undefined;

    const pending = await questionStore().listPending(sliceFilter);
    if (isJson) {
      console.log(JSON.stringify({ questions: pending }, null, 2));
      return 0;
    }
    renderPendingQuestions(pending);
    return 0;
  }

  // 答案文本可能没加引号，因此问题 id 之后的全部位置参数都算答案
  const positional = args.filter((a) => !a.startsWith('--'));
  const questionId = positional[0];
  const answerText = positional.slice(1).join(' ').trim();

  if (!questionId || !answerText) {
    console.error('Usage: zelto answer <question-id> "<answer>"');
    console.error('  列出待答问题：zelto ask');
    return 1;
  }

  const qs = questionStore();
  const record = await qs.read(questionId);
  if (!record) {
    console.error(`Question "${questionId}" not found.`);
    return 1;
  }
  if (record.status === 'answered') {
    console.error(`Question "${questionId}" was already answered at ${record.answeredAt}.`);
    return 1;
  }
  if (!record.zeltoSessionId) {
    console.error(`Question "${questionId}" has no agent session — cannot resume.`);
    return 1;
  }

  const sliceId = record.sliceId;
  const slice = await store.read(sliceId);

  // 适配器：优先用提问时的那个；同一 worktree、同一 agent 命令
  const cfg = loadConfig();
  const workDir = existingWorktreePath(sliceId) ?? process.cwd();
  const adapter = createExecutorAdapter(
    record.adapterName ?? cfg.agent.adapter,
    // 命令也要按 adapter 重算 —— Cursor 的默认命令是 `cursor-agent`，
    // 拿配置里的 `npx claude-code` 去续一个 Cursor 会话，续的是另一个人。
    resolveAgentCommand(record.adapterName ?? cfg.agent.adapter, undefined, cfg),
    slice.agentTimeout,
    workDir,
  );

  if (!adapter.metadata.capabilities.resume) {
    console.error(`Adapter "${adapter.name}" does not support resume — cannot continue the conversation.`);
    return 1;
  }

  // 先记录答案（文件 + 事件），再续跑
  await qs.answer(questionId, answerText);
  await events.append(sliceId, 'question.answered', 'human', {
    sliceId,
    questionId,
    answer: answerText,
    answeredBy: 'human',
  });

  console.log(`Answered ${questionId} — resuming slice "${sliceId}"...`);

  // ADR-130：续跑仍属**同一轮**，agent 的 `policy.decision` 要能归属到它。
  // runId 取自任务文件（ADR-129 的权威来源），只在那轮**仍在等这次回答**时沿用：
  // 有结论 / 没有停在 `agent_question` 的证据 → 不注入。判定全部只读文件（C3），
  // 单次读取快照 —— 读时 `run.resumed` 还没写，不存在「读到自己刚写的」。
  const runId = resumeRunIdForAnswer(sliceId, await events.read(sliceId));

  // ── 运行时守卫（ADR-139）────────────────────────────────────────────
  //
  // **续跑前必须重新装守卫** —— `zelto run` 的守卫在它自己的 `finally` 里
  // 释放了（提问挂起时 `zelto run` 正常退出 → `finally` 跑掉 → 钩子被撤掉、
  // 预约被释放）。`zelto answer` 是**另一个进程**。
  //
  // 不装的后果：续跑段 agent 写的文件**没有经过任何运行时逐写判定** ——
  // C9 的主防线消失，只剩事后审计（那时越界的文件已经写出去了）。
  //
  // 实测证据（探针切片 `probe-claude-smoke`，2026-11-28）：
  // `reservation.released`（00:33:18）**早于** `run.resumed`（00:33:30）。
  let guard: RuntimeGuard | null = null;
  try {
    guard = await installResumeGuard({
      sliceId,
      adapterType: record.adapterName ?? cfg.agent.adapter,
      projectRoot: process.cwd(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // C9：**预约缺失时 fail closed（一律拒绝）**。
    // 拿不到判据就放行 = 让 agent 在没人看着的时候改文件。
    console.error(`❌ 无法取得写集预约: ${msg}`);
    console.error(`   agent 不能在无守卫状态下续跑 —— 默认拒绝。`);
    console.error(`   排掉冲突后重试，或先修环境（zelto reservation list）。`);
    return 1;
  }

  let newSessionId: string;
  try {
    const resumed = await adapter.resume(
      record.zeltoSessionId,
      answerText,
      runId ? { runId } : undefined,
    );
    newSessionId = resumed.sessionId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`❌ Could not resume the agent session: ${msg}`);
    console.error(`   Fallback: zelto run ${sliceId}`);
    // 起跑失败 → 守卫必须释放（预约悬空 → 下片撞写集冲突）。
    await guard.release();
    return 1;
  }

  // ── 续跑语义（ADR-140 决策二 / 决策五）───────────────────────────
  //
  // 「这次是真续还是新会话」——**上下文在不在**，语义完全不同。
  //
  // - 真续（`session/resume` / `session/load`）—— agent 记得刚才讨论过什么；
  // - 退回（`session/new`）—— **上下文丢了**，agent 得从零摸索。
  //
  // **必须说清楚**（决策二）：静默退回 = 人以为 agent 记得，
  // 实际它什么都不记得 —— 人会基于错误的假设做判断。
  //
  // **必须进事件**（决策五）：C4 说事件是追溯的唯一证据载体 ——
  // 「这次续跑是不是真续」正是审计要问的问题。
  //
  // **为什么在续跑之后才写这条事件**：通道要等握手完成才知道
  // （`session/resume` 成功与否也是握手的一部分）。
  // 提前写就只能是「渠道待定」，等于没写。
  //
  // **只写一条**（不补第二条）：补写会让「这片被续跑了几次」翻倍 ——
  // 而 `rework_rate` 之类「事件条数 ÷ 门禁次数」的指标会被这个翻倍直接带偏
  // （见 `core/sched/engine.ts` 里 `run.resumed` 的说明）。
  const sessionMode = readSessionMode(adapter, newSessionId);
  await events.append(sliceId, 'run.resumed', 'zelto', {
    sliceId,
    resolution: 'question_answered',
    questionId,
    ...(sessionMode ? { sessionMode } : {}),
  });

  if (sessionMode === 'new') {
    console.error(
      '⚠️  agent 不支持 session/resume / session/load —— 这次续跑是**新会话**。',
    );
    console.error('    agent 之前的上下文已丢失，它需要重新摸索。');
  }

  const exitCode = await adapter.waitForExit(newSessionId);

  // 守卫在**续跑结束**时释放（ADR-139 决策三）—— 不是「门禁之前」。
  //
  // 为什么在 `waitForExit` 之后：agent 还在跑的时候撤钩子，
  // 续跑段的后半程就没有运行时判定了 —— 那等于只守了一半。
  //
  // 为什么不在「门禁之前」：续跑后 agent **又提了新问题**时，
  // 切片**再次挂起** —— 挂起是跨进程的，这时守卫也该释放
  // （否则预约悬空 → 下片撞写集冲突）。
  //
  // `release()` 自带幂等（`released` 标志），重复调用安全。
  await guard.release();

  // 记账（ADR-041 §3.1 / ADR-092）：续跑也是一次运行 —— agent 又跑了一遍。
  await store.recordRun(sliceId, { ok: exitCode === 0, exitCode, phase: 'resume' });

  // ── 写集审计（ADR-139 决策三之二）────────────────────────────────────
  //
  // 正常路径（`run-finish.ts` 的 `finishRun`）是：
  //   记账 → enforceWriteSet（审计）→ 提问检测 → 状态迁移 → 门禁 → 签字
  // 续跑路径原来**没有审计** —— 只剩钩子这一道主防线。
  //
  // 补上它有两个理由：
  //   1. 钩子只拦「agent 通过工具写文件」。`git checkout`、
  //      `node -e "fs.writeFileSync(...)"`、子进程写文件都绕过钩子 ——
  //      **审计是唯一兜住这些的防线**。
  //   2. 门禁②跑的是验收测试，**它不看写集** —— 越界的文件不会让验收失败，
  //      只会**被合进主干**。
  //
  // 判据与 `finishRun` 完全一致（同一个 `enforceWriteSet`）。
  //
  // **为什么在「又提问」分支之前**：续跑后 agent 又提问时切片会再次挂起，
  // 那时切片不进 gate、不进签字 —— 但**越界的事实仍然成立**，不能因为
  // 「这一轮没走完」就当没发生过。审计判成越界 → 退回 frozen + 留痕。
  const withinBounds = await enforceWriteSet(sliceId, guard);

  if (exitCode !== 0) {
    const elapsedNote = `exit ${exitCode ?? 'signal'}`;
    console.error(`❌ Agent exited with ${elapsedNote} after the answer.`);
    await events.append(sliceId, 'run.aborted', 'zelto', { sliceId, exitCode, ...(runId ? { runId } : {}) });

    // ADR-142：配额耗尽要**单独**分类 —— 它不可自动恢复
    //（配额墙不会因为重试而恢复），而且退出码与普通失败**一模一样**。
    //
    // 识别靠 agent 的**输出** —— 退出码说不了这件事。
    const agentOutput = readAgentOutput(adapter, newSessionId);
    const usageLimit = detectUsageLimit(agentOutput);

    // 续跑失败同样要退回 frozen（ADR-047）：切片本来就在 running
    // （提问回路挂起时不迁状态），不退回就永远卡在 running ——
    // 准入只认 frozen / completed，人救不回来。
    await markSliceStalled(sliceId, classifyStall({
      type: usageLimit.isUsageLimit
        ? 'usage_limit'
        : exitCode === null
          ? 'build_failure'
          : 'test_failure',
      message: `Agent exited with code ${exitCode ?? 'signal'} after the answer`,
      attempts: 1,
    }), {
      exitCode,
      reason: `agent failed after answer: ${exitCode ?? 'signal'}`,
      // ADR-142：配额重置时间（取不到就是 null —— 不编）。
      resetAt: usageLimit.resetAt,
      retryAfterSec: usageLimit.retryAfterSec,
    });

    // 配额耗尽要**说清「等，别重跑」**（ADR-142 决策五）。
    if (usageLimit.isUsageLimit) {
      console.error('⚠️  Agent 服务端配额已耗尽 —— 重试没用（配额不会因为重试而恢复）。');
      if (usageLimit.resetAt) {
        console.error(`    恢复时间: ${usageLimit.resetAt}`);
      } else if (usageLimit.retryAfterSec !== null) {
        console.error(`    恢复时间: 约 ${usageLimit.retryAfterSec} 秒后`);
      } else {
        console.error('    恢复时间: 未知（agent 没报）—— 查服务商的配额页面');
      }
    }
    return 1;
  }

  // 越界 → 不进 gate、不进签字，等人处理（ADR-014 §5）。
  //
  // `enforceWriteSet` 已经把切片退回 frozen 并写了 `run.aborted` 事件。
  if (!withinBounds.ok) {
    console.error('');
    printOutcome(
      [`写集越界：agent 写了写集之外的文件。`, ...withinBounds.violations.map((v) => `  ${v}`)],
    );
    console.error('   状态: → frozen（等人扩写集后重跑）');
    return 1;
  }

  // 续跑后可能又提了新问题
  const followUp = await detectQuestion(sliceId, adapter, newSessionId);
  if (followUp) {
    await suspendSliceForQuestion(sliceId, followUp);
    console.log('');
    console.log(`❓ The agent asked another question:`);
    console.log(`   ${followUp.question}`);
    console.log(`   Answer with: zelto answer ${followUp.id} "<your answer>"`);
    return 0;
  }

  // 没有新问题 —— 走正常收尾：清除停机 → 跑门禁 → 签字请求
  //
  // 重新读一次切片：上一份快照是回答前读的，续跑期间切片可能已被别的流程
  // 改动（如 gate 记录），直接写回旧快照会覆盖掉那些变更。
  const current = await store.read(sliceId);
  current.stall.class = null;
  current.stall.gateRetries = 0;
  await store.write(current);

  // RUN_FINISH 只在 `running` 状态合法。切片若已被人工改动过状态，
  // transitionSlice 会抛 Invalid transition —— 捕获后按可读信息报错，
  // 不让整个命令崩成未捕获异常。
  // 花费结算（ADR-035）：先记账，再复判预算；超预算则不进 gate。
  let cost: Awaited<ReturnType<typeof settleRunCost>>;
  try {
    await store.transit(sliceId, 'RUN_FINISH');
    cost = await settleRunCost(sliceId, adapter, newSessionId);
    await events.append(sliceId, 'run.finished', 'zelto', { sliceId, exitCode: 0, costUsd: cost.costUsd, ...(runId ? { runId } : {}) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`❌ Could not finish the run for slice "${sliceId}": ${msg}`);
    console.error(`   The agent finished, but the slice state was not updated.`);
    console.error(`   Check with: zelto slice show ${sliceId}`);
    await events.append(sliceId, 'run.aborted', 'zelto', { sliceId, exitCode, reason: msg, ...(runId ? { runId } : {}) });
    return 1;
  }
  console.log(`✅ Agent completed after the answer.`);

  if (cost.exhausted) {
    printOutcome(budgetExhaustedMessage({ sliceId }, cost.spent, cost.limit));
    return 0;
  }

  await autoGateAfterRun(sliceId);
  return 0;
});
