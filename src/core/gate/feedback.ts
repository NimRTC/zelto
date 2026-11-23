// 上一轮门禁/验收的失败反馈 —— 喂给重跑的 agent
//
// 实战病灶（ZD-013）：
//
// agent 跑完 → 门禁①过 → 门禁②跑了 build/test 但**没跑验收**
// （config.yaml 没配 gate.acceptance）→ 切片进 completed → 人签字。
//
// 验收里其实有**两个真 bug**（STUN 消息类型编码错、REQUESTED-TRANSPORT 字节序反了），
// 但因为门禁没跑验收，这两个 bug 一路溜到签字桌前。
//
// 人发现之后让 agent 重跑修 —— **但 agent 拿不到「上次为什么失败」**：
// 约束包里只有规格、写集、门禁命令。它只能从头再摸一遍，
// 甚至可能把已经对的东西改错。
//
// 这个模块解决的就是这件事：**把上一次的失败证据（原文，不加工）
// 交给下一轮 agent**。
//
// 读的是**事件流**（C4：追溯的唯一证据载体），不是切片状态文件 ——
// 门禁结论本来就只以事件的形式存在。
//
// C3: 纯读取 + 纯文本加工，不调模型、不触网
// C6: core/ 内，不依赖 adapters/

import type { EventEnvelope, EventStream } from '../events/stream.js';

/** 一条失败反馈 */
export interface GateFeedback {
  /** 哪一步失败了 */
  stage: 'gate' | 'acceptance';
  /** 命令名（gate 命令名 / 'acceptance'） */
  command: string;
  /** 失败原因原文（截断后） */
  reason: string;
  /** 失败输出（stdout+stderr，截断后） */
  output?: string;
}

/** 反馈里最多带多少字符的失败输出 —— 上下文有限，全塞进去会挤掉规格 */
const MAX_OUTPUT_CHARS = 4000;

/** 反馈条数上限 —— 只带最近的几条，早期的失败已经被后续修复了 */
const MAX_FEEDBACK_ITEMS = 3;

/**
 * 从事件流里读出「上一轮门禁/验收的失败」。
 *
 * 只看 `gate.result` 事件 —— 门禁的结论只以它为载体。
 *
 * **只看最后一次门禁结果**：更早的门禁失败可能已经被后面的运行修好了，
 * 全都带过去只会让 agent 去追一个已经不存在的问题。
 * 但验收的失败要单独看 —— 门禁过了、验收没过，是两件事。
 */
export async function readGateFeedback(
  events: EventStream,
  sliceId: string,
): Promise<GateFeedback[]> {
  const all = await events.read(sliceId);

  // 门禁结果事件：可能有多条（每次跑门禁一条）
  const gateResults = all.filter((e) => e.type === 'gate.result');
  const feedback: GateFeedback[] = [];

  // ── 验收失败 ────────────────────────────────────────────────────────
  // 验收的结论在 gate.result 的 payload.acceptance 里。
  // 找**最近一条**验收失败的门禁结果。
  for (let i = gateResults.length - 1; i >= 0; i--) {
    const acceptance = gateResults[i].payload?.acceptance as
      | { status?: string; reason?: string; path?: string | null }
      | undefined;
    if (!acceptance) continue;
    if (acceptance.status === 'failed') {
      feedback.push({
        stage: 'acceptance',
        command: 'acceptance',
        reason: acceptance.reason ?? '验收未通过',
        output: extractOutput(gateResults[i]),
      });
      break;
    }
    // 验收是 passed 或 skipped —— 不算失败，继续往前找更早的？
    // 不找：最近一次门禁里验收没失败，说明现状是好的。
    break;
  }

  // ── 门禁命令失败 ────────────────────────────────────────────────────
  // 最近一条 gate.result 里 passed=false 且没有验收失败 → 是门禁命令本身失败。
  const last = gateResults[gateResults.length - 1];
  if (last && last.payload?.passed === false) {
    const acceptance = last.payload?.acceptance as { status?: string } | undefined;
    if (acceptance?.status !== 'failed') {
      const results = (last.payload?.results ?? []) as Array<{
        command?: string;
        passed?: boolean;
        stderr?: string | null;
        stdout?: string | null;
        failures?: Array<{ test?: string; message?: string; location?: string }>;
        reportedFailureCount?: number | null;
        runner?: string;
      }>;
      const failed = results.find((r) => r.passed === false);
      if (failed) {
        // ZD-027：优先把**失败用例清单**作为 reason —— 比裸 stderr 精准得多
        // （stderr 往往只有一句 `Errors while running CTest`）。
        const summary = renderFailureSummary(failed);
        feedback.push({
          stage: 'gate',
          command: failed.command ?? 'gate',
          reason: summary ?? failed.stderr ?? '门禁命令未通过',
          output: extractOutput(last),
        });
      }
    }
  }

  return feedback.slice(0, MAX_FEEDBACK_ITEMS);
}

/**
 * 把失败用例清单渲染成一段人/agent 可读的文字（ZD-027）。
 *
 * 没有结构化失败清单时返回 null —— 调用方退回裸 stderr（不编造）。
 * 抽到的条数少于运行器声明的失败总数时，明说「还有 N 条没抽到」——
 * 不许让 agent 以为只有这几条坏了。
 */
function renderFailureSummary(failed: {
  failures?: Array<{ test?: string; message?: string; location?: string }>;
  reportedFailureCount?: number | null;
  runner?: string;
}): string | null {
  const failures = failed.failures ?? [];
  if (failures.length === 0) return null;

  const lines: string[] = [];
  const runner = failed.runner && failed.runner !== 'unknown' ? `（${failed.runner}）` : '';
  lines.push(`失败的用例${runner}：`);
  for (const f of failures) {
    const name = f.test?.trim() || '(未命名用例)';
    const loc = f.location ? `  ${f.location}` : '';
    lines.push(`  ✗ ${name}${loc}`);
    if (f.message && f.message.trim()) {
      // 缩进断言消息，多行也能看清归属
      for (const ml of f.message.split('\n')) {
        lines.push(`      ${ml}`);
      }
    }
  }
  const reported = failed.reportedFailureCount;
  if (typeof reported === 'number' && reported > failures.length) {
    lines.push(`（运行器共报 ${reported} 个失败，上面列出 ${failures.length} 个）`);
  }
  return lines.join('\n');
}

/** 从门禁结果事件里取失败输出 */
function extractOutput(evt: EventEnvelope): string | undefined {
  const results = (evt.payload?.results ?? []) as Array<{
    stderr?: string | null;
    stdout?: string | null;
  }>;
  const parts: string[] = [];
  for (const r of results) {
    if (r.stderr) parts.push(r.stderr);
    if (r.stdout) parts.push(r.stdout);
  }
  if (parts.length === 0) return undefined;
  return parts.join('\n').slice(0, MAX_OUTPUT_CHARS);
}

/**
 * 把失败反馈渲染成给 agent 看的一段话。
 *
 * **原文，不加工** —— agent 要看的是「真实失败长什么样」，
 * 不是人转述的版本。人转述会把关键细节转掉（本次实战里
 * 「STUN 消息类型编码错」这个要点，人转述时只会说「测试没过」）。
 */
export function renderGateFeedback(feedback: GateFeedback[]): string[] {
  if (feedback.length === 0) return [];
  const lines: string[] = [
    '## Previous attempt failed — here is the evidence',
    '',
    'The previous run of this slice did not pass. Fix the cause, not the symptom.',
    'The output below is verbatim from the last gate/acceptance run.',
    '',
  ];
  for (const f of feedback) {
    lines.push(`### ${f.stage === 'acceptance' ? 'Acceptance test' : 'Gate command'} \`${f.command}\``);
    lines.push('');
    lines.push('```');
    lines.push(f.reason.slice(0, MAX_OUTPUT_CHARS));
    lines.push('```');
    if (f.output) {
      lines.push('');
      lines.push('Full output:');
      lines.push('```');
      lines.push(f.output);
      lines.push('```');
    }
    lines.push('');
  }
  return lines;
}
