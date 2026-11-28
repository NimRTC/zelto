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
    /**
     * 续跑时**真续会话**的能力（ADR-140）。
     *
     * - `'load-resume'` —— 续跑能续同一个 agent 会话（上下文在）
     * - `'new-session'`  —— 续跑只能开新会话（上下文会丢）
     *
     * **声明的是能力上限，不是运行时结论**：
     * ACP adapter 声明 `'load-resume'`，但实际用 `session/resume`、
     * `session/load` 还是退回 `session/new`，取决于**那个 agent**
     * 在 `initialize` 回包里声明了什么能力。
     *
     * 为什么声明上限而不是运行时结论：`AdapterMeta` 是**静态**的，
     * 而调用方（`question.ts`）需要在 `adapter.resume()` **之前**
     * 就知道这件事 —— 因为它要在**人看到之前**给出提示。
     * 运行时才知道 = 提示来不及。
     *
     * 为什么不是反过来（声明 `'new-session'`）：那样即使实际 agent
     * 支持 load/resume，zelto 也永远不会去试 —— 能力被静态声明卡死。
     */
    sessionContinuation: 'load-resume' | 'new-session';
    /**
     * C9 的**主判定点**（ADR-133）。
     *
     * 「写集预约在哪里被强制」是**这个 adapter 怎么实现 C9** 的事实，
     * 不是用户的偏好 —— 所以它是 adapter 声明的能力，**不是配置项**。
     * 让用户去配「用哪套闸门」等于给「关掉闸门」开了一个口子。
     *
     * - `'hook'` —— agent 侧装钩子（`.claude/settings.local.json` /
     *   `.cursor/hooks.json` / `.codex/hooks.json`），agent 每次写文件前
     *   主动问 zelto 的 hook 进程。这是现有三个 adapter 的做法。
     * - `'permission'` —— agent 通过 ACP 的 `session/request_permission`
     *   向 zelto 请求授权，zelto 在回调里判定。这是 ACP adapter 的做法。
     *
     * 两种形态下判定内核都是同一个（`src/hook/` 的 `judgeWriteTargets`），
     * 差别只在**协议层**（ADR-083 §1）。
     */
    writeGuard: WriteGuardKind;
  };
}

/**
 * C9 主判定点的两种形态（ADR-133）。
 *
 * `'hook'` 与 `'permission'` **不是**二选一的配置，是**两种实现**；
 * 调用方按这个声明决定「要不要往 agent 的目录里装 hook 配置」。
 */
export type WriteGuardKind = 'hook' | 'permission';

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
   * 当前处于哪个**启动阶段**（ADR-143）；不在启动阶段 → null。
   *
   * 存在的理由：agent 的**启动阶段**（加载 MCP server、鉴权、读上下文文件）
   * **不是工具调用** —— 所以它不发 `tool_call`，也就不会喂 `markProgress`。
   * 于是「空转超时」（没有进展就这么久就杀）会把一个**正常启动但比较慢**的
   * agent 当成「卡住了」杀掉 —— 而它被杀的时候**一行代码都还没写**。
   *
   * 启动阶段**豁免**空转超时（不是延长它 —— 那要引入魔法数字）。
   * 豁免的依据是「阶段是否结束」这个**协议事实**，
   * 而阶段**只从真实信号来**（被等待的协议请求），**绝不用计时器**。
   *
   * **可选方法**：hook 路线的三个 adapter 没有这个概念 ——
   * 为它们编一个 `null` 就是「假装有这个能力」。
   * 不实现 = 没有这个能力（调用方要判存在性）。
   *
   * 返回的字符串是**给人看的**阶段名（如 `'initialize'` / `'session'`）。
   */
  getStartupPhase?(sessionId: string): string | null;

  /**
   * 这一轮续跑**实际用哪条**通道（ADR-140）；不适用时 → null。
   *
   * - `'resume'` —— 真续（`session/resume`），上下文在
   * - `'load'`   —— 真续（`session/load`），上下文在（历史回放）
   * - `'new'`    —— 退回 `session/new`，**上下文丢了**
   *
   * **为什么调用方需要知道**：续跑的**语义**不同（上下文在不在），
   * 人看到「agent 又问了同一个问题」时的判断完全不同。
   * 而且这件事必须进事件流（C4）—— 它进 `run.resumed` 的负载。
   *
   * **可选方法**：只有 ACP 路线有「协议层的会话通道」这个概念。
   */
  getSessionMode?(sessionId: string): 'resume' | 'load' | 'new' | null;

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
