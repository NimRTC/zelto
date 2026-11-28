// 配额 / 限流耗尽的识别（ADR-142）
//
// ## 为什么这个模块存在
//
// `budget_exhausted`（zelto 自己的闸门）与「agent 服务端的配额耗尽」
// **形状相似但处置完全不同**：
//
// | | zelto 自己的预算（⑥） | 服务端配额（⑩） |
// |---|---|---|
// | 撞墙的原因 | zelto 的 `budgetLimitUsd` 到了 | Claude/Cursor/OpenAI 的账号额度到了 |
// | 调高上限有用吗 | **有用** | **没用**（那不是 zelto 的闸门） |
// | 重试有用吗 | 看情况 | **没用**（墙还在） |
//
// 所以服务端配额必须是**独立的一类** —— 它**不可自动恢复**
// （`isAutoResolvable('usage_limit') === false`）。
//
// ## 识别靠输出文本，不靠退出码
//
// agent 撞配额时退出码就是普通的非 0 —— 退出码**说不了**这件事。
// 唯一的信号在**输出文本**里（stderr / agent 的错误消息）。
//
// ## 认不出就当普通失败
//
// 「认不出配额错误」只是**不优化重试**，不影响安全 ——
// 所以认不出就返回 false，**不猜**（同「认不出 ≠ 放行」的原则）。
//
// C3: 纯计算，不调模型、不触网、不读文件
// C6: core/ 内，不依赖 adapters/

/**
 * 配额耗尽的特征串。
 *
 * **为什么要固定串**：判定必须确定性（C3）——
 * 靠「像不像配额」的直觉 = 靠模型 = 不确定。
 *
 * **为什么跨 agent 用同一批串**：各家 agent 的错误文案不同，
 * 但**语义**只有几种 —— 「限流」「配额不足」「余额不足」「过载」。
 * shell 适配器拿到的是**文本**不是结构化错误，所以只能靠文本识别。
 */
const USAGE_LIMIT_PATTERNS: RegExp[] = [
  // 限流
  /\brate[\s_-]?limit(?:ed|ing|s)?\b/i,
  /\btoo many requests\b/i,
  // 配额
  /\busage[\s_-]?limit(?:ed|s)?\b/i,
  /\bquota\b/i,
  /\binsufficient[\s_-]?quota\b/i,
  /\bout of quota\b/i,
  // 余额
  /\bcredit balance is too low\b/i,
  /\binsufficient[\s_-]?(?:credit|balance|funds)\b/i,
  // 过载（服务端资源耗尽 —— 与限流同处置）
  /\boverloaded\b/i,
  /\bresource[_\s-]?exhausted\b/i,
  // HTTP 状态码
  /\b429\b/,
  /\b(?:http[/ ])?error\s*429\b/i,
];

/**
 * 绝对重置时间 —— 形如 `2026-11-28T17:30:00Z` 或 `2026-11-28 17:30:00 UTC`。
 *
 * **为什么认绝对时间而不自己换算**：换算要引入「现在几点」——
 * 那是推测。agent 报了绝对时间就用它。
 */
const RESET_AT_PATTERN =
  /\breset(?:s|ting)?\s+(?:at|on|in)?\s*[:：]?\s*(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:\s*(?:Z|UTC|GMT|[+-]\d{2}:?\d{2}))?)/i;

/**
 * 相对等待秒数 —— 形如 `try again in 3600s` / `retry after 60 seconds`。
 *
 * **为什么单独报相对秒数**：给不出绝对时间时，
 * 「等多久」这个信息仍然有用 —— 但**不自己换算成绝对时间**。
 */
const RETRY_AFTER_PATTERN =
  /\b(?:try again|retry|retr(?:y|ies)ing)?\s*(?:in|after|wait)\s*(?:about\s+|approximately\s+)?(\d{1,6})\s*(s\b|sec|secs|second|seconds|m\b|min|mins|minute|minutes|h\b|hr|hrs|hour|hours)/i;

/** 配额耗尽的识别结果。 */
export interface UsageLimitSignal {
  /** 是配额耗尽吗 */
  readonly isUsageLimit: boolean;
  /** agent 报的**绝对**重置时间（ISO 串）；没有 → null */
  readonly resetAt: string | null;
  /** agent 报的**相对**等待秒数；没有 → null */
  readonly retryAfterSec: number | null;
  /** 命中的特征串（写进事件让人看得懂为什么这么判） */
  readonly matched: string | null;
}

/** 没有命中时的结果。 */
const NO_MATCH: UsageLimitSignal = {
  isUsageLimit: false,
  resetAt: null,
  retryAfterSec: null,
  matched: null,
};

/**
 * 把「等 30 分钟」这类相对时长换算成秒。
 *
 * 只有 `m`/`min`/`minute`/`h`/`hour` 需要换算 —— `s`/`sec`/`second` 已是秒。
 */
function toSeconds(value: number, unit: string): number {
  const u = unit.toLowerCase();
  if (u.startsWith('m') && !u.startsWith('ms')) return value * 60;
  if (u.startsWith('h')) return value * 3600;
  return value;
}

/**
 * 识别 agent 的输出是不是「服务端配额耗尽」。
 *
 * **纯函数** —— 不读文件、不触网、不调模型（C3）。
 *
 * @param output agent 的输出文本（stdout + stderr 拼起来）
 * @returns 识别结果；认不出时 `isUsageLimit === false` 且其余字段为 null
 */
export function detectUsageLimit(output: string | null | undefined): UsageLimitSignal {
  if (!output || typeof output !== 'string') return NO_MATCH;

  // 只看**后** 8000 字符 —— 配额错误通常在末尾（agent 先跑了一段才撞墙），
  // 而开头可能是很长的正常输出。全量扫会让正则回溯变慢。
  const text = output.length > 8000 ? output.slice(-8000) : output;

  let matched: string | null = null;
  for (const pattern of USAGE_LIMIT_PATTERNS) {
    const hit = pattern.exec(text);
    if (hit) {
      matched = hit[0];
      break;
    }
  }
  if (matched === null) return NO_MATCH;

  // 命中了 → 顺手把 reset time / retry-after 也找出来。
  //
  // **为什么两个都找**：有的 agent 报绝对时间（跨天/跨时区），
  // 有的只报相对秒数。都没有 → 如实留空（**不编**）。
  const resetMatch = RESET_AT_PATTERN.exec(text);
  const resetAt = resetMatch ? normalizeResetAt(resetMatch[1]) : null;

  const retryMatch = RETRY_AFTER_PATTERN.exec(text);
  const retryAfterSec = retryMatch
    ? toSeconds(Number(retryMatch[1]), retryMatch[2])
    : null;

  return {
    isUsageLimit: true,
    resetAt,
    retryAfterSec: Number.isFinite(retryAfterSec) ? retryAfterSec : null,
    matched,
  };
}

/**
 * 把 agent 报的绝对时间规范化成 ISO 串。
 *
 * **规范化到什么程度**：只做「补上 `T`」和「把 `UTC`/`GMT` 换成 `Z`」
 * 这种**不引入推测**的整理。真的推不出合法 ISO → 返回原串（不编）。
 */
function normalizeResetAt(raw: string): string | null {
  const trimmed = raw.trim();
  // `2026-11-28 17:30:00` → `2026-11-28T17:30:00`
  const withT = trimmed.replace(' ', 'T');
  // `UTC` / `GMT` → `Z`（同一个意思，只是写法不同 —— 不是推测）。
  const withZone = withT.replace(/\s*(UTC|GMT)$/i, 'Z');
  // 没有时区 → **不补**（补 `Z` 就是**假设**它是 UTC）。
  return withZone;
}
