// Question loop commands — `zelto ask` / `zelto answer`
//
// ADR-013: agent 提问回路。
// - `ask`    列出待答问题（文件队列 `.zelto/questions/`）
// - `answer` 回答问题并续跑同一个 agent 会话
//
// C1: 问题状态只落在文件里；C4: 每个动作写一条 append-only 事件。

import { join } from 'node:path';
import { QuestionStore, parseQuestion, type QuestionRecord } from '../../core/question/index.js';
import type { ExecutorAdapter } from '../../core/ports/executor.js';
import { register } from './shared.js';
import {
  store, events, ZELTO_DIR, loadConfig, createExecutorAdapter, existingWorktreePath,
} from './shared.js';
// 直接从 run-support 拿 autoGateAfterRun —— core-slice.ts 只是再导出它。
// 经 core-slice 绕一圈会形成 question.ts → core-slice.ts → question.ts 的环，
// 而 core-slice.ts 又 import 并行执行器，于是变成三条命令文件互相咬。
import { autoGateAfterRun, settleRunCost } from './run-support.js';

const QUESTIONS_DIR = join(ZELTO_DIR, 'questions');

function questionStore(): QuestionStore {
  return new QuestionStore({ baseDir: QUESTIONS_DIR });
}

// ─── 提问检测与挂起（供 run 流程复用） ──────────────────────────────────────

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
    cfg.agent.command,
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
  await events.append(sliceId, 'run.resumed', 'zelto', {
    sliceId,
    resolution: 'question_answered',
    questionId,
  });

  console.log(`Answered ${questionId} — resuming slice "${sliceId}"...`);

  let newSessionId: string;
  try {
    const resumed = await adapter.resume(record.zeltoSessionId, answerText);
    newSessionId = resumed.sessionId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`❌ Could not resume the agent session: ${msg}`);
    console.error(`   Fallback: zelto run ${sliceId}`);
    return 1;
  }

  const exitCode = await adapter.waitForExit(newSessionId);

  if (exitCode !== 0) {
    const elapsedNote = `exit ${exitCode ?? 'signal'}`;
    console.error(`❌ Agent exited with ${elapsedNote} after the answer.`);
    await events.append(sliceId, 'run.aborted', 'zelto', { sliceId, exitCode });
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
    await events.append(sliceId, 'run.finished', 'zelto', { sliceId, exitCode: 0, costUsd: cost.costUsd });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`❌ Could not finish the run for slice "${sliceId}": ${msg}`);
    console.error(`   The agent finished, but the slice state was not updated.`);
    console.error(`   Check with: zelto slice show ${sliceId}`);
    await events.append(sliceId, 'run.aborted', 'zelto', { sliceId, exitCode, reason: msg });
    return 1;
  }
  console.log(`✅ Agent completed after the answer.`);

  if (cost.exhausted) {
    console.log(`  ⛔ Budget exhausted: $${cost.spent.toFixed(2)} spent — 未进入 gate，等人处理`);
    return 0;
  }

  await autoGateAfterRun(sliceId);
  return 0;
});
