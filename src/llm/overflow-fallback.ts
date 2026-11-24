// 「prompt 装不下」的降级重试
//
// ── 病灶（ZD-002，nimrtc v1.4，2026-11-20）────────────────────────────
//
// 第一次加完项目结构摘要后，摘要本身有 1.1MB（`src/third_party` 一个目录
// 就 14k 个文件，全被 `scanProject` 逐条喂）。DeepSeek 直接 400：
//
//   number of input tokens (373385) has exceeded max_seq_len (163840)
//
// 也就是说：摘要已经**有**字符预算（`MAX_SUMMARY_CHARS`），
// 但那个预算**猜不出**模型端的 token 上限 ——
// 12k 字符在某个模型上是安全的，在另一个模型上（上下文更小、
// 或分词效率更差）就未必。
//
// ── 修法 ──────────────────────────────────────────────────────────────
//
// 抓「装不下」这类错误 → 把注入的那段**按比例缩小** → 重试一次。
//
// 关键设计：
//
// 1. **只对「装不下」重试**，不对别的错误重试。
//    别的错误（鉴权失败、网络断了、模型不存在）重试没有意义，
//    重试只会把一个快速失败变成慢速失败。
//
// 2. **缩小的对象是「可缩的注入段」**，不是整条 prompt。
//    需求正文是**不能缩**的（缩了就丢需求）。缩的只是我们注入的
//    仓库上下文摘要 —— 它本来就是「锦上添花」的部分。
//
// 3. **重试次数有上限**（默认 1 次）。
//    缩到很小还装不下 → 那是需求正文本身太大，不是摘要的锅，
//    再缩摘要也救不了 → 如实抛错，把原始错误带出去。
//
// 4. **不静默降级**。
//    重试成功 → 照常返回；重试仍失败 → 抛原始错误（带上重试痕迹）。
//    绝不能「重试失败就悄悄用空摘要再试一次」——
//    那样模型会拿**残缺**的仓库上下文生成设计，而人看不出来
//    （设计看起来正常，只是路径瞎编）—— 那比直接失败更糟。

import type { LlmAdapter, LlmRequest, LlmResponse } from '../core/ports/llm.js';

/** 装不下这类错误在各家 SDK / API 里的说法 */
const OVERFLOW_PATTERNS: RegExp[] = [
  /exceeded max_seq_len/i,
  /maximum context length/i,
  /context_length_exceeded/i,
  /too many tokens/i,
  /prompt is too long/i,
  /input length and `max_tokens` exceed/i,
  /string too long/i,
  /input tokens.{0,40}exceed/i,
  /reduce the length/i,
];

/**
 * 这条错误是不是「prompt 装不下」？
 *
 * 判据是**消息文本**里出现装不下那几套说法。
 *
 * 为什么不去猜错误码 / 错误类型：各家 SDK 的错误形态差别很大
 * （OpenAI 的 `code: 'context_length_exceeded'`、DeepSeek 的
 * `number of input tokens ... has exceeded max_seq_len`、Anthropic 的
 * `input is too long`），而 `core/` 不能 import 任何 SDK（C2）。
 * 文本匹配是唯一在 `core/` 里也站得住的做法。
 *
 * 误判的代价：把一个别的错误当成「装不下」→ 白重试一次 →
 * 多花一次请求的钱，但不会产生错误结论（重试仍失败就抛原错）。
 */
export function isTokenOverflowError(err: unknown): boolean {
  if (!err) return false;
  const text = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
  return OVERFLOW_PATTERNS.some((re) => re.test(text));
}

/**
 * 把一段注入文本按比例缩短到**至多** `maxChars` 字符。
 *
 * 截断点是**行边界** —— 从尾部砍，砍到一整行结束。
 * 半行截断会让摘要末尾出现半句话，模型会当成真的内容。
 *
 * 砍完要留一句「摘要被截断了」的话 —— 否则模型不知道自己看到的是节选，
 * 可能以为仓库就长这样（那又是一次「看起来正常但内容是空的」）。
 */
export function shrinkToBudget(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const keep = Math.max(0, maxChars);
  const head = text.slice(0, keep);
  const lastBreak = head.lastIndexOf('\n');
  const body = lastBreak > 0 ? head.slice(0, lastBreak) : head;
  return `${body}\n\n（以上仓库上下文因模型上下文上限被截断，后续内容未展开。）`;
}

/**
 * 带降级重试的一次 LLM 调用。
 *
 * @param llm LLM 适配器
 * @param buildPrompt 用**当前**注入段的大小拼出 prompt
 * @param shrinkable 注入段的可缩文本（需求正文等**不可缩**的部分不在这里）
 * @param maxRetries 重试次数上限（默认 1）
 *
 * 流程：按原样调一次 → 报「装不下」→ 把注入段按 1/2 缩 → 再调一次
 * → 还报「装不下」→ 再缩（最多 `maxRetries` 次）→ 仍失败则抛原始错误。
 */
export async function chatWithOverflowFallback(
  llm: LlmAdapter,
  buildPrompt: (injectable: string) => string,
  shrinkable: string,
  options: { maxRetries?: number; request: Omit<LlmRequest, 'messages'> & { messages?: LlmRequest['messages'] } },
): Promise<LlmResponse> {
  const maxRetries = options.maxRetries ?? 1;
  let injectable = shrinkable;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await llm.chat({
        ...options.request,
        messages: [
          ...(options.request.messages ?? []),
          { role: 'user', content: buildPrompt(injectable) },
        ],
      });
    } catch (err) {
      lastError = err;
      // 只对「装不下」重试 —— 别的错误重试没有意义
      if (!isTokenOverflowError(err)) throw err;
      if (attempt >= maxRetries) break;

      // 按比例缩小：第 n 次重试用 1/2^n 的预算
      const factor = 2 ** (attempt + 1);
      const next = shrinkToBudget(injectable, Math.floor(injectable.length / factor));
      // 缩到一样长 → 再缩也没用 → 停（如实抛错）
      if (next.length >= injectable.length) break;
      injectable = next;
    }
  }

  throw lastError;
}
