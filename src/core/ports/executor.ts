// ExecutorAdapter port — dependency inversion boundary for agent executors
// core/ defines the port, adapters/ implement it

import type { EventEnvelope } from '../events/index.js';

export interface AdapterMeta {
  /** Adapter version (semver) */
  version: string;
  /** Human-readable description */
  description: string;
  /** Capabilities this adapter supports */
  capabilities: {
    resume: boolean;
    events: boolean;
    modelSelection: boolean;
  };
}

/**
 * Token / cost usage of one agent session (ADR-035).
 *
 * The adapter is the only place that knows what the agent actually cost —
 * the CLI shell spawn and the Agent SDK report it in completely different
 * shapes, so the shape is normalised here, at the port.
 */
export interface AdapterUsage {
  /** Cumulative cost of the session in USD. */
  costUsd: number;
  /** Prompt tokens consumed, when the adapter reports them. */
  inputTokens?: number;
  /** Completion tokens consumed, when the adapter reports them. */
  outputTokens?: number;
  /** Model id, when the adapter reports it. */
  model?: string;
}

/**
 * ExecutorAdapter — abstract interface for spawning and managing agent sessions.
 *
 * This is a superset of SessionPort that adds adapter identity metadata.
 * core/ depends on this interface; adapters/ provide implementations.
 */
export interface ExecutorAdapter {
  /** Unique adapter name, e.g. "claude-agent" */
  readonly name: string;
  /** Adapter metadata */
  readonly metadata: AdapterMeta;

  /**
   * Start a new agent session.
   * @param spec.sliceId — The slice being executed
   * @param spec.prompt — The instruction bundle or prompt to send to the agent
   * @param spec.model — Optional model override
   * @param spec.runId — 本轮运行身份（ADR-129 / ADR-130）。支持注入的适配器
   *   把它交给 agent 子进程的 `ZELTO_RUN_ID`，hook 的 `policy.decision`
   *   据此归属轮次。它只是**留痕维度**，不参与任何判定（C3/C9 不变）。
   * @returns A session identifier
   */
  start(spec: {
    sliceId: string;
    prompt: string;
    model?: string;
    runId?: string;
  }): Promise<{ sessionId: string }>;

  /**
   * Resume an existing agent session with additional context.
   *
   * The agent continues the *same* conversation, so the agent-side session id
   * must be preserved (see ADR-013 §3.4). Adapters that cannot truly resume
   * must throw rather than silently start a fresh conversation.
   *
   * @param sessionId — The zelto session to resume
   * @param patch — Additional instructions or context to inject
   * @param opts.runId — 续跑所属那一轮的 runId（ADR-130）。调用方确认过
   *   「这一轮确实还在等这次回答」就传它；没传则适配器沿用会话文件里
   *   记录的那个，都没有就不注入（hook 事件如实留空）。
   * @returns The zelto session id of the continued session
   */
  resume(
    sessionId: string,
    patch: string,
    opts?: { runId?: string },
  ): Promise<{ sessionId: string }>;

  /**
   * Continue the same agent conversation with **arbitrary** instructions.
   *
   * `resume()` is the question-loop path: its patch is "the human's answer",
   * and the wording it builds assumes that. A retry after a timeout needs a
   * different prompt ("continue where you left off"), so it gets its own
   * entry point rather than bending `resume()`'s semantics (ADR-055).
   *
   * Optional: an adapter that cannot continue a conversation simply doesn't
   * implement it, and the caller falls back to starting fresh.
   *
   * @param opts.runId — 续跑所属那一轮的 runId（ADR-130）。传了就用它，
   *   没传则由适配器沿用会话文件里记录的那个；两者都没有 → 不注入
   *   （hook 事件如实留空，不凭空造一个）。
   */
  continueSession?(
    sessionId: string,
    instructions: string,
    opts?: { runId?: string },
  ): Promise<{ sessionId: string }>;

  /**
   * 报告「这一轮有进展」（D-55）。
   *
   * 存在的理由：适配器的超时是**空转超时**（没有进展才杀），而
   * 「进展」不只有 stdout —— Claude Code 跑 `--output-format json`，
   * stdout 直到最后才有内容。只看输出的话，一个正在连续调用工具的
   * agent 会被误判成卡住。
   *
   * 谁调它：CLI 层在**看到切片事件流有新事件**时 —— 那些事件是 agent 的
   * PreToolUse hook 写的，每调用一次工具就有一条。
   *
   * 可选能力：没实现的适配器不受影响（调用方要判存在性）。
   */
  markProgress?(sessionId: string): void;

  /**
   * Get the agent's output text for a session.
   *
   * Used to read the agent's final answer — e.g. to parse the question marker
   * (see `core/question/`). Returns an empty string when the output is
   * unavailable.
   */
  getOutput(sessionId: string): string;

  /**
   * Get the agent-side conversation id for a session (e.g. the Claude Code
   * session uuid). Null when the adapter does not expose one.
   *
   * This is the id a human sees when asked to continue a conversation — it is
   * recorded in the question record (ADR-013 §3.2).
   */
  getAgentSessionId(sessionId: string): string | null;

  /**
   * Report the token / cost usage of a session (ADR-035).
   *
   * Optional: an adapter that cannot report usage simply does not implement
   * it, and the budget accounting then treats that slice as "no usage data"
   * rather than "zero cost". Never returns a negative cost.
   */
  getUsage?(sessionId: string): AdapterUsage | null;

  /**
   * 报告**运行中**的累计用量（ZD-007）。
   *
   * 与 `getUsage` 的区别是**什么时候**能拿到：
   * - `getUsage` —— 通常要等 agent **退出**（Claude Code 的 `--output-format json`
   *   在最后才吐出整段 JSON，中途没有）；
   * - `getLiveUsage` —— **运行中**就能报出当前累计花费。
   *
   * 为什么需要（ZD-007）：
   * 病灶（nimrtc v1.4，2026-11-20）：`checkBudget` 只在**起跑前**调一次，
   * 跑完后由 `settleRunCost` 记账时复判 —— **运行期间没有任何地方查预算**。
   * 于是 agent 想烧多少烧多少：实测一轮烧了 $5.86（上限 $1.00），
   * 产物其实做完了，但因为超预算**没进门禁**，切片卡在 frozen。
   * 更糟的是「预算耗尽」这个停机分类**误导人** —— 它看起来像「agent 跑砸了」，
   * 实际是「agent 跑成了但超了闸门」，人第一反应是重跑 → 再烧一遍。
   *
   * 实现者：
   * - Agent SDK 适配器 —— SDK 自己有 `maxBudgetUsd`（**事前**约束，更强），
   *   但也可以在每条消息上报一次累计花费；
   * - shell 适配器 —— Claude Code 的 json 输出中途拿不到，
   *   所以实现不了（返回 null = 「测不到」，不谎报）。
   *
   * **返回 null 的语义是「测不到」**（不是「零」）——
   * 与 `getUsage` 同一个原则：没数据不等于没花钱。
   */
  getLiveUsage?(sessionId: string): AdapterUsage | null;

  /**
   * Stop/kill an agent session.
   * @param sessionId — The session to stop
   */
  stop(sessionId: string): Promise<void>;

  /**
   * Stream events from a running or completed session.
   * @param sessionId — The session to read events from
   */
  events(sessionId: string): Promise<AsyncIterable<EventEnvelope>>;

  /**
   * Wait for the session to exit and return the exit code.
   * Returns null if the session is not found.
   */
  waitForExit(sessionId: string): Promise<number | null>;
}
