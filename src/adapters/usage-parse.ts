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
 * 再失败还有第三种形状（真实踩到过的）：**前缀告警 + 多段 JSON**。
 * 适配器会把非致命告警打到 stdout 的第一行，后面才是 Claude 的结果对象：
 *
 * ```
 * [claude-code:unrecognized_model] {"model":"...","query_source":"sdk"}
 * {"duration_api_ms":...,"total_cost_usd":1.2152,"result":"..."}
 * ```
 *
 * 这种情况下前两种切法都会失败：
 * - 整体 parse —— 前缀不是 JSON
 * - 「第一个 { 到最后一个 }」—— 截出**两段 JSON 拼在一起**，`JSON.parse`
 *   报 `Unexpected non-whitespace character after JSON`
 *
 * 于是 `total_cost_usd` 被丢掉 → 记账写成 `costUsd: null` → 预算页显示
 * 「未记账」，而钱其实花了。这正是「账对不上」的根因。
 *
 * 所以第三种切法：**按括号配对逐个切出 JSON 对象**，然后按下面的优先级挑。
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
    const loose = tryParseObject(trimmed.slice(start, end + 1));
    if (loose) return loose;
  }

  // 第三种切法：前缀告警 + 多段 JSON。逐个切出候选对象再挑。
  const candidates = scanJsonObjects(trimmed);
  if (candidates.length === 0) return null;
  return pickClaudeJson(candidates);
}

/**
 * 候选对象的挑选规则 —— 有明确的优先顺序，不猜。
 *
 * 1. **含 `total_cost_usd` 的** —— 成本证据的唯一载体（ADR-035 §3.2）。
 *    告警那段的 payload 只有 `model` / `query_source`，不会带这个字段。
 * 2. **含 `result` 字符串的** —— Claude Code json 输出模式的回答在这里。
 *    `getOutput()` 依赖它（问答回路读这段文本）。
 * 3. **只有一个候选** —— 就它了。
 * 4. **都不满足且有多个候选** —— 不猜，返回 null。
 *    宁可退回原始 stdout 让人自己看，也不要随便挑一个当官方结果。
 */
function pickClaudeJson(candidates: Record<string, unknown>[]): Record<string, unknown> | null {
  const withCost = candidates.find((o) => 'total_cost_usd' in o);
  if (withCost) return withCost;

  const withResult = candidates.find((o) => typeof o.result === 'string');
  if (withResult) return withResult;

  if (candidates.length === 1) return candidates[0] ?? null;

  return null;
}

/**
 * 取出 Claude 的回答文本（json 输出模式的 `result` 字段）。
 *
 * 为什么单独一个函数：`extractClaudeJson` 的挑选优先级是「先看成本证据」，
 * 而回答与成本是两个独立需求 —— 答案必须在**含 `result` 字符串**的那个对象里。
 * 用一个共用函数会出现「拿到了成本、丢了答案」或者反过来。
 *
 * 找不到就返回 null —— 调用方退回原始 stdout 文本，不吞输出（ADR-035 §3.2）。
 */
export function extractClaudeResult(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const direct = tryParseObject(trimmed);
  if (direct && typeof direct.result === 'string') return direct.result;

  const candidates = scanJsonObjects(trimmed);
  for (const candidate of candidates) {
    if (typeof candidate.result === 'string') return candidate.result;
  }

  return null;
}

/**
 * 按括号配对从文本里切出所有 JSON 对象。
 *
 * 不能用正则（JSON 里有嵌套对象、字符串里的花括号和转义引号），
 * 也不能用「第一个 { 到最后一个 }」（那是把多段拼在一起）。
 * 所以手工扫一遍：跟住字符串字面量，只在字符串外数花括号。
 */
function scanJsonObjects(text: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];

  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
      continue;
    }

    if (ch === '}') {
      if (depth === 0) continue; // 落单的右括号 —— 跳过，不当对象
      depth--;
      if (depth === 0 && start >= 0) {
        const parsed = tryParseObject(text.slice(start, i + 1));
        if (parsed) found.push(parsed);
        start = -1;
      }
    }
  }

  return found;
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
