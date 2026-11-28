// ACP 会话续跑 —— 「续同一个会话，不许重开」（ADR-140）
//
// ## 为什么这个模块存在
//
// `resume()` / `continueSession()` 拿到上一轮的 ACP 会话 id 之后，
// 现在的实现**只做一次存在性检查就把它丢了** —— 然后 `spawn()` →
// `connect()` → `buildSession().start()` 发的是 **`session/new`**，
// 于是**开了一个全新会话**，agent 的上下文清零。
//
// 而 `resume()` 的注释承诺的是：
//
// > 问答回路：把人的回答喂回**同一个** ACP 会话。
//
// ## ACP 协议给了三条路
//
// | 方法 | 语义 | 能力位 |
// |---|---|---|
// | `session/new` | 开新会话 | 所有 agent 必须支持 |
// | `session/load` | 恢复上下文，**并把整个对话历史回放给 client** | `agentCapabilities.loadSession` |
// | `session/resume` | 恢复上下文，**不回放历史**（更省 token） | `sessionCapabilities.resume` |
//
// 规范明文（`SessionStatus` 的硬约束）：
//
// > A Client that did not create or resume the session on its own connection
// > **MUST still call `session/load` or `session/resume`** before sending
// > `session/prompt` or expecting `session/update` notifications.
//
// zelto 每次续跑都换一条新连接 → 按规范必须先 load/resume。
//
// ## 为什么 `session/resume` 优先于 `session/load`
//
// `session/load` 会把**整个对话历史回放**给 client。而 zelto 的提问检测
// （`parseQuestion()`）是**纯字符串解析** —— 历史里如果有上一轮的
// `<<<ZELTO_QUESTION` 标记，回放时会被**再解析一次**，
// 于是 agent 上一轮问的问题被当成**这一轮又问了一次** → **无限挂起**。
//
// `session/resume` **不回放历史**，没有这个问题，而且更省 token。
//
// ## 退路路径不假装
//
// agent 不支持 load/resume 时（实测 `cursor-agent acp` 就是
// `loadSession: false`），zelto **不假装能续** —— 它明确告诉人
// 「这次续跑是**新会话**，agent 之前的上下文已丢失」。
//
// 静默退回 = 人以为 agent 记得刚才讨论过什么，实际它什么都不记得 ——
// 人会基于错误的假设做判断，那是最坏的一种失败模式。
//
// C1: 状态只在文件里（会话文件里的 `agentSessionId`）
// C2: 本模块在 src/adapters/，允许第三方依赖；core/ 不受影响
// C3: 判定确定性 —— 能力位读不到就当作没有（fail closed）

import type { AcpSessionContinuation } from './protocol.js';

/**
 * 续跑时**实际用哪条**通道（ADR-140 决策五）。
 *
 * 这个值要进 `run.resumed` 事件的负载 —— 续跑的**语义**不同
 * （上下文在不在），这件事必须在追溯链上看得见（C4）。
 */
export type AcpSessionMode = 'resume' | 'load' | 'new';

/**
 * 续跑时**该走哪条**通道 —— 由 agent 声明的能力 + 目标会话 id 决定。
 *
 * @param capability agent 在 `initialize` 回包里声明的会话能力
 * @param acpSessionId 要续的会话 id（null = 首轮，没有可续的会话）
 */
export function decideSessionMode(
  capability: AcpSessionContinuation,
  acpSessionId: string | null,
): AcpSessionMode {
  // 没有可续的会话 id → 首轮，只能 `session/new`。
  if (!acpSessionId) return 'new';

  switch (capability) {
    case 'resume':
      return 'resume';
    case 'load':
      return 'load';
    case 'new':
      return 'new';
  }
}

/**
 * 「这次续跑是真续还是新会话」的人话提示（ADR-140 决策二）。
 *
 * **只在退回路径需要说** —— 真续时不需要打扰人。
 *
 * 为什么必须说：静默退回 = 人以为 agent 记得刚才讨论过什么，
 * 实际它什么都不记得。人会基于错误的假设做判断。
 */
export function describeSessionMode(mode: AcpSessionMode): string {
  if (mode !== 'new') return '';

  return (
    '⚠️  agent 不支持 session/resume / session/load —— 这次续跑是**新会话**。\n' +
    '    agent 之前的上下文已丢失，它需要重新摸索。\n' +
    '    （agent 的 initialize 回包没有声明 sessionCapabilities.resume，' +
    '也没有声明 agentCapabilities.loadSession。）'
  );
}

/**
 * 「本次续跑的提示词」—— 退回路径用（真续时**不需要**这段话）。
 *
 * 为什么退回路径保留这个模板：那条提示词模板是**已经验证过能用**的路径。
 * 在 agent 不支持 load/resume 的情况下，它是唯一可用的路径。
 * 本模块只是**加一句告知**，不改它的语义。
 */
export function buildFallbackResumeInstructions(patch: string): string {
  return [
    'You previously asked a question and the human answered it.',
    '',
    'The answer is:',
    patch,
    '',
    'Continue the work in this same session. If anything is still unclear, ask again using the question marker.',
  ].join('\n');
}

/**
 * 「任意提示词的续跑」—— 退回路径用（超时重试：「接着上次做」）。
 */
export function buildFallbackContinueInstructions(instructions: string): string {
  return instructions;
}
