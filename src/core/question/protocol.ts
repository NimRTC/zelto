// Question protocol — deterministic parsing of the agent question marker
//
// C3: pure string processing. No model call, no network, no file access.
//
// The agent ends its reply with a marker block:
//
//   <<<ZELTO_QUESTION
//   type: spec_gap | choice | blocker
//   question: <one line>
//   options: <opt1> | <opt2>
//   >>>
//
// `type` is declared by the agent, but severity is NOT: it is derived from
// `type` through the fixed table below, so the model never participates in a
// judgement (C7).

import type { ParsedQuestion, QuestionSeverity, QuestionType } from './types.js';

export const MARKER_START = '<<<ZELTO_QUESTION';
export const MARKER_END = '>>>';

export const QUESTION_TYPES: readonly QuestionType[] = ['spec_gap', 'choice', 'blocker'];

/**
 * type → severity. Fixed table — the only place severity is decided.
 *
 * Every question raised through the protocol blocks the slice: the agent
 * stopped to ask, so it cannot proceed until a human answers. `non_blocking`
 * exists so the queue can carry questions that do not suspend a slice
 * (see ADR-013 §3.5).
 */
const SEVERITY_BY_TYPE: Record<QuestionType, QuestionSeverity> = {
  spec_gap: 'blocking',
  choice: 'blocking',
  blocker: 'blocking',
};

export function severityForType(type: QuestionType): QuestionSeverity {
  return SEVERITY_BY_TYPE[type];
}

export function isQuestionType(value: string): value is QuestionType {
  return (QUESTION_TYPES as readonly string[]).includes(value);
}

/**
 * Parse the question marker out of agent output.
 *
 * Only the **last** marker block in the output is considered — the protocol
 * requires the marker to terminate the reply. Returns null when there is no
 * marker or the marker is malformed.
 *
 * ── 容错（ZD-065）──────────────────────────────────────────────────────
 *
 * 原实现只认 `<<<ZELTO_QUESTION` 一个精确串。agent 少写三个尖括号
 * （`ZELTO_QUESTION`）就**完全收不到**：
 *
 *   病灶（nimrtc-v14 v1-transport-manager-pacing，2026-11-27）：
 *     agent 停下来问了人（问题本身完全正确：新文件要注册 CMake 源列表），
 *     但标记写成 `ZELTO_QUESTION` → 解析返回 null → 问题从未登记 →
 *     「agent 停下问人」被当成「agent 成功完成」→ 门禁在一个**零改动**
 *     的 worktree 上跑 → 报「build is not a directory」——
 *     报错指向构建目录，实际根因是**一行代码都没写**。
 *
 *   代价：整轮白跑（$2.78）+ 一条指错方向的错误信息。
 *
 * 修法（ADR-137）：**标记的识别要宽松，字段的解析要严格**。
 *   - 识别：`ZELTO_QUESTION` 前后可有 0..3 个 `<`、空白、代码块围栏（```），
 *           以及 `ZELTO_QUESTION:` 这类带尾冒号的写法；
 *   - 解析：字段仍必须齐全且合法（`type` ∈ 三种、`question` 非空）——
 *           宽松的是**外壳**，严格的是**内容**。
 *
 * 判据：宁可**多认**一个本来不是问题的标记（后面会被字段校验挡掉），
 * 也不要**漏认**一个真的是问题的标记 —— 后者让 agent 的提问静默消失，
 * 而提问静默消失的代价是「agent 停下了但工具以为它干完了」。
 */
export function parseQuestion(output: string): ParsedQuestion | null {
  if (!output) return null;

  const found = findMarker(output);
  if (!found) return null;

  const { bodyStart } = found;
  const end = output.indexOf(MARKER_END, bodyStart);
  // 收尾标记 `>>>` 缺失时，**取到输出末尾** —— 标记本来就该终止回复，
  // 所以「后面没有别的东西」就是最合理的兜底边界。
  const body = end === -1 ? output.slice(bodyStart) : output.slice(bodyStart, end);

  const fields = parseFields(body);

  const rawType = fields.get('type')?.trim() ?? '';
  if (!isQuestionType(rawType)) return null;

  const question = fields.get('question')?.trim() ?? '';
  if (!question) return null;

  const options = (fields.get('options') ?? '')
    .split('|')
    .map((o) => o.trim())
    .filter(Boolean);

  return { type: rawType, question, options };
}

/**
 * 找出标记起始处（宽松匹配）。
 *
 * 认这些形态（`MARKER_TOKEN` 是 `ZELTO_QUESTION`）：
 *
 *   `<<<ZELTO_QUESTION`   ← 规范形态
 *   `<<ZELTO_QUESTION`
 *   `ZELTO_QUESTION`      ← 少了尖括号（ZD-055 实测踩到）
 *   `<<< ZELTO_QUESTION`  ← 尖括号后带空格
 *   `ZELTO_QUESTION:`     ← 尾冒号
 *   ```` ```ZELTO_QUESTION ````  ← 代码块围栏包裹
 *
 * 返回**最后一个**匹配 —— 协议要求标记终止回复，所以看最后一个
 * （与原实现同口径）。
 *
 * @returns 标记之后（正文的起点）与匹配起点；没找到返回 null
 */
function findMarker(output: string): { start: number; bodyStart: number } | null {
  // 允许 0..3 个前导 `<` + 零或多个空白 —— 上限 3 是刻意的：
  // 再多的尖括号几乎肯定是别的标记。
  const prefix = /(?<![A-Za-z0-9_])(<{0,3}[ \t]*ZELTO_QUESTION\b[ \t]*:?)/g;

  let last: { start: number; bodyStart: number } | null = null;
  let m: RegExpExecArray | null;
  while ((m = prefix.exec(output)) !== null) {
    last = { start: m.index, bodyStart: m.index + m[0].length };
    if (m[0].length === 0) prefix.lastIndex += 1;
  }
  return last;
}

/**
 * Split a marker body into `key: value` pairs.
 * Lines without a colon are ignored; the first occurrence of a key wins.
 */
function parseFields(body: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim().toLowerCase();
    const value = trimmed.slice(idx + 1).trim();
    if (!key || fields.has(key)) continue;
    fields.set(key, value);
  }
  return fields;
}

/**
 * Instructions appended to every agent bundle so the agent knows how to ask.
 * Kept here (not in the scheduler) so the protocol has a single source.
 */
export const QUESTION_INSTRUCTIONS = [
  '## Asking questions',
  'If the spec is ambiguous and you cannot proceed, end your reply with exactly this block:',
  '',
  MARKER_START,
  'type: spec_gap | choice | blocker',
  'question: <one line>',
  'options: <opt1> | <opt2>',
  MARKER_END,
  '',
  'Rules:',
  '- `type` must be `spec_gap` (the spec does not say), `choice` (several valid options), or `blocker` (you are blocked).',
  '- `question` is one line. `options` is optional, separated by ` | `.',
  '- The marker must be the last thing in your reply. Do not write anything after it.',
  '- Asking is not failing — but guessing is. If you would have to invent behaviour, ask.',
].join('\n');
