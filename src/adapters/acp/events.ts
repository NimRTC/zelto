// ACP 事件映射 —— `session/update` → zelto 的输出与进展信号（ADR-133）
//
// 这一层只做两件事：
//
//   1. **抽文本** —— `agent_message_chunk` 里的文字 → 人看得到的输出；
//   2. **判进展** —— 哪些 update 算「agent 在动」→ 空转超时的信号（D-55）。
//
// **不判定**。判定在 `src/hook/acp.ts`。
//
// ── 为什么「不认识的 update 一律忽略」而不是「崩掉」────────────────
//
// ACP 的 `SessionUpdate` 是**封闭 union**（规范 v1），但规范明说
// 新版本可能加变体，且客户端**必须**忽略不认识的命名字段。
// 一个新版本的 agent 多发一种通知，不该让整个会话崩掉 ——
// 那等于「agent 升级了 zelto 就不能用」，是最坏的失败形态。

import type { SessionUpdate } from '@agentclientprotocol/sdk';

/** 已知会带文本的 update 种类。 */
const TEXT_UPDATE_KINDS = new Set([
  'agent_message_chunk',
  'agent_thought_chunk',
  'session_message_chunk',
  'compaction_summary_chunk',
]);

/**
 * 从一条 `session/update` 里抽出文本。
 *
 * 只取 `content: { type: 'text', text }` —— 图像/音频/资源链接不是文本，
 * 塞进输出缓冲只会污染人看到的内容。
 */
export function extractAcpText(update: SessionUpdate | undefined): string {
  if (!update || typeof update !== 'object') return '';
  const kind = (update as { sessionUpdate?: string }).sessionUpdate;
  if (typeof kind !== 'string' || !TEXT_UPDATE_KINDS.has(kind)) return '';

  const content = (update as { content?: { type?: string; text?: string } }).content;
  if (!content || content.type !== 'text') return '';
  return typeof content.text === 'string' ? content.text : '';
}

/**
 * 这条 update 算不算「有进展」。
 *
 * **判据**：agent 报了工具调用（`tool_call` / `tool_call_update`）。
 *
 * 为什么不是「有任何 update 就算」：agent 可能只是在推 plan、
 * 报 notice、发 mode 变化 —— 那些不说明它**在干活**。
 * 工具调用才是「它在动文件/跑命令」的信号。
 *
 * 这比 hook 路线直接：hook 路线要靠 hook 进程写事件来喂
 * `markProgress`；ACP 下每个工具调用自带一条通知。
 */
export function isProgressUpdate(update: SessionUpdate | undefined): boolean {
  if (!update || typeof update !== 'object') return false;
  const kind = (update as { sessionUpdate?: string }).sessionUpdate;
  return kind === 'tool_call' || kind === 'tool_call_update';
}

/**
 * 从一条 `usage_update` 里抽出累计花费（美元）。
 *
 * ACP v1 的 `UsageUpdate.cost` 是可选的 —— 没有就是「没测到」。
 *
 * **返回 null 而不是 0**（ADR-035 口径）：0 的含义是「确实没花钱」，
 * 而这里是「agent 没报」。谎报零成本会让预算闸门变成一道**假闸门**。
 */
export function extractAcpCost(update: SessionUpdate | undefined): number | null {
  if (!update || typeof update !== 'object') return null;
  const kind = (update as { sessionUpdate?: string }).sessionUpdate;
  if (kind !== 'usage_update') return null;

  const cost = (update as { cost?: { amount?: number; currency?: string } | null }).cost;
  if (!cost || typeof cost !== 'object') return null;

  const amount = cost.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return null;

  // 币种不是 USD 时**不折算** —— 折算需要汇率，那是「不确定」的来源。
  // 拿别的币种当美元报出去，比报 null 更坏（ADR-035 同款理由）。
  const currency = cost.currency;
  if (typeof currency === 'string' && currency.toUpperCase() !== 'USD') return null;

  return amount;
}
