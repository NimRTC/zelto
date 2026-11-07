// Claude 用量解析 —— 把 Claude Code 的两种上报形状收敛成端口的 AdapterUsage
//
// 两种形状（ADR-035 §3.2）：
// - Agent SDK 的 `result` 消息：字段在消息对象顶层
// - Claude Code CLI 的 `--output-format json`：整个 stdout 是一个 JSON 对象
//
// 字段名在两处不完全一致（snake_case 与 camelCase 混用），所以这里两种都认。
//
// C2: 本文件属于 adapters/，只依赖 Node 内置与 core/ports 的纯类型。

import type { AdapterUsage } from '../core/ports/executor.js';

/**
 * 从一段文本里取出 Claude 的 JSON 对象。
 *
 * 正常情况下 stdout 就是**一个** JSON 对象，直接 parse 即可。
 * 但 stdout 里可能混进了别的东西（CLI 的横幅、警告、shell 的回显），
 * 所以 parse 失败时再试一次「截取第一个 { 到最后一个 }」的宽松切法。
 *
 * 解析不出就返回 null —— 调用方据此退回原始文本，不吞输出。
 */
export function extractClaudeJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const direct = tryParseObject(trimmed);
  if (direct) return direct;

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return tryParseObject(trimmed.slice(start, end + 1));
  }

  return null;
}

function tryParseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 不是 JSON —— 返回 null
  }
  return null;
}

/**
 * 把 Claude 的用量载荷解析成端口的 `AdapterUsage`。
 *
 * 返回 null 表示「没测到」：
 * - 没有 `total_cost_usd` 字段
 * - 花费不是有限数
 * - 花费为负（不是「零」，是数据坏了）
 *
 * 注意：`costUsd === 0` 是**有效数据**（真的没花钱），与 null 语义不同。
 */
export function parseClaudeUsage(payload: Record<string, unknown>): AdapterUsage | null {
  const cost = toFiniteNumber(payload.total_cost_usd);
  if (cost === null || cost < 0) return null;

  const usage = asRecord(payload.usage);
  const inputTokens = usage ? firstNumber(usage.input_tokens, usage.inputTokens) : null;
  const outputTokens = usage ? firstNumber(usage.output_tokens, usage.outputTokens) : null;

  const usageOut: AdapterUsage = { costUsd: cost };
  if (inputTokens !== null) usageOut.inputTokens = inputTokens;
  if (outputTokens !== null) usageOut.outputTokens = outputTokens;

  const model = pickSingleModel(payload.modelUsage);
  if (model) usageOut.model = model;

  return usageOut;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const num = toFiniteNumber(value);
    if (num !== null) return num;
  }
  return null;
}

/**
 * 从 `modelUsage` 里取模型 id。
 *
 * 只有**恰好一个**模型时才取 —— 多个模型说明这次会话用了不同模型，
 * 报一个会造成「账单对不上」，宁可留空让人自己看明细。
 */
function pickSingleModel(modelUsage: unknown): string | null {
  const record = asRecord(modelUsage);
  if (!record) return null;
  const keys = Object.keys(record);
  if (keys.length !== 1) return null;
  return keys[0] ?? null;
}
