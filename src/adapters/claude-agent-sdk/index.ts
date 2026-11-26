// ClaudeAgentSdkAdapter — ExecutorAdapter implementation using the Claude Agent SDK
//
// Unlike the shell-spawn adapter, this uses the SDK's programmatic API:
//   - startup() → warmQuery.query(prompt) → AsyncGenerator of SDKMessage events
//   - Supports budget limits (maxBudgetUsd), max turns, and permission modes
//   - Supports session resume via session IDs
//   - Streams real-time events from the agent session
//
// Reliability features:
//   - Timeout (kills agent if it exceeds time limit)
//   - Retry (re-starts on failure up to maxRetries)
//   - Output capture for progress reporting
//   - Health check (isSessionAlive)
//
// Requirements:
//   - ANTHROPIC_API_KEY environment variable (or configured API key)
//   - @anthropic-ai/claude-agent-sdk installed

import { startup } from '@anthropic-ai/claude-agent-sdk';
import { type ExecutorAdapter, type AdapterMeta, type AdapterUsage } from '../../core/ports/executor.js';
import type { EventEnvelope, EventType } from '../../core/events/index.js';
import { parseClaudeUsage } from '../usage-parse.js';

/**
 * ZD-007：运行中累计的 token 数。
 *
 * 只记 token，不记金额 —— SDK 的 assistant 消息只给 token，
 * 金额在 `result` 消息里才有（那是**最终**值）。
 */
interface LiveTokenCount {
  inputTokens: number;
  outputTokens: number;
  model?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

export interface ClaudeAgentSdkAdapterOptions {
  /** Working directory for the agent session (default: process.cwd()) */
  cwd?: string;
  /** Maximum budget in USD (default: no limit) */
  maxBudgetUsd?: number;
  /**
   * ZD-007：每 1k token 的单价（USD）—— 用于把运行中的 token 折算成金额。
   *
   * 没有它 → `getLiveUsage` 报不出金额（返回 null = 「测不到」）。
   * 宁可测不到，也不要拿猜的金额去判超支。
   */
  pricePerKToken?: { input: number; output: number };
  /** Maximum number of agentic turns (default: no limit) */
  maxTurns?: number;
  /** Model to use (e.g. 'sonnet', 'opus', 'fable') */
  model?: string;
  /** Path to the Claude Code executable (default: auto-detected by SDK) */
  claudeCodePath?: string;
  /** Permission mode (default: 'bypassPermissions' — hook handles the checks) */
  permissionMode?: 'bypassPermissions' | 'auto' | 'default';
  /** Environment variables to pass */
  env?: Record<string, string>;
  /** Maximum time in ms before aborting the agent (default: 900000 = 15 min) */
  timeoutMs?: number;
  /** Maximum number of retries on failure (default: 2) */
  maxRetries?: number;
  /**
   * Optional callback for real-time output from the agent.
   * Called with each text message as it arrives.
   */
  onOutput?: (sessionId: string, text: string) => void;
  /**
   * Optional callback for progress updates.
   * Called periodically during execution with elapsed time info.
   */
  onProgress?: (sessionId: string, elapsedMs: number, status: string) => void;
}

const ADAPTER_META: AdapterMeta = {
  version: '2.0.0',
  description:
    'Claude Agent SDK adapter — programmatic agent control with timeout, retry, budget, events, and resume',
  capabilities: {
    resume: true,
    events: true,
    modelSelection: true,
  },
};

interface SdkSessionState {
  /** Unique session identifier */
  sessionId: string;
  /** ISO timestamp when the session started */
  startedAt: string;
  /** Abort controller for cancellation */
  abortController: AbortController;
  /** Current retry attempt (0 = first try) */
  retryCount: number;
  /** True once the session's generator loop has ended */
  exited: boolean;
  /** Exit code of the session (null = aborted / no exit code) */
  exitCode: number | null;
}

/**
 * Minimal event type mapping from SDK messages to zelto event types.
 */
function inferEventType(
  msgType: string,
  _payload: Record<string, unknown>,
): EventType {
  switch (msgType) {
    case 'text':
      return 'llm.called';
    case 'tool_use':
      return 'policy.decision';
    case 'tool_result':
      return 'gate.executed';
    case 'error':
      return 'run.aborted';
    case 'message_stop':
      return 'run.finished';
    default:
      return 'llm.called';
  }
}

export class ClaudeAgentSdkAdapter implements ExecutorAdapter {
  readonly name = 'claude-agent-sdk';
  readonly metadata: AdapterMeta = ADAPTER_META;

  private readonly cwd: string;
  private readonly maxBudgetUsd: number | undefined;
  private readonly maxTurns: number | undefined;
  private readonly model: string | undefined;
  private readonly claudeCodePath: string | undefined;
  private readonly permissionMode: 'bypassPermissions' | 'auto' | 'default';
  private readonly env: Record<string, string> | undefined;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly onOutput?: (sessionId: string, text: string) => void;
  private readonly onProgress?: (sessionId: string, elapsedMs: number, status: string) => void;

  /** Active sessions keyed by sessionId */
  private readonly sessions = new Map<string, SdkSessionState>();
  /** Timeouts per session */
  private readonly timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  /** Progress intervals per session */
  private readonly progressIntervals = new Map<string, ReturnType<typeof setInterval>>();
  /** Buffer of events per session, for the events() method */
  private readonly sessionEvents = new Map<string, EventEnvelope[]>();
  /** Accumulated agent text output per session */
  private readonly sessionText = new Map<string, string>();
  /**
   * 本次会话的用量（ADR-035）。
   *
   * 单独存一份而不是靠事件缓冲反推：`sessionEvents` 只保留最近 100 条，
   * 长会话里 `result` 消息早就被 shift 掉了。
   */
  private readonly sessionUsage = new Map<string, AdapterUsage>();
  /**
   * ZD-007：运行中累计的 token 数（每会话）。
   *
   * 只累加 token，不直接累加金额 —— SDK 的 assistant 消息只给 token，
   * 金额在 `result` 里才有。金额由 `getLiveUsage` 用单价折算。
   */
  private readonly sessionLiveTokens = new Map<string, LiveTokenCount>();
  /**
   * ZD-007：每 1k token 的单价（USD）。
   *
   * 没有单价 → `getLiveUsage` 报不出金额（返回 null）。
   * 宁可「测不到」也不要猜一个金额去判超支。
   */
  private readonly pricePerKToken?: { input: number; output: number };
  /** Resolve functions for waitForExit promises, keyed by sessionId */
  private readonly exitResolvers = new Map<string, (code: number | null) => void>();
  /** Resolvers for "the generator loop has fully unwound", keyed by sessionId */
  private readonly drainResolvers = new Map<string, () => void>();
  /** Sessions whose generator loop has already fully unwound */
  private readonly drainedSessions = new Set<string>();

  constructor(options: ClaudeAgentSdkAdapterOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.maxBudgetUsd = options.maxBudgetUsd;
    this.pricePerKToken = options.pricePerKToken;
    this.maxTurns = options.maxTurns;
    this.model = options.model;
    this.claudeCodePath = options.claudeCodePath;
    this.permissionMode = options.permissionMode ?? 'bypassPermissions';
    this.env = options.env;
    this.timeoutMs = options.timeoutMs ?? 900_000; // 15 minutes default
    this.maxRetries = options.maxRetries ?? 2;
    this.onOutput = options.onOutput;
    this.onProgress = options.onProgress;
  }

  async start(spec: {
    sliceId: string;
    prompt: string;
    model?: string;
    runId?: string;
  }): Promise<{ sessionId: string }> {
    return this.startWithRetry(spec, 0);
  }

  private async startWithRetry(
    spec: { sliceId: string; prompt: string; model?: string; runId?: string },
    retryCount: number,
  ): Promise<{ sessionId: string }> {
    const sessionId = `sdk-${spec.sliceId}-${Date.now()}${retryCount > 0 ? `-retry-${retryCount}` : ''}`;

    // Build SDK options
    const sdkOptions: Record<string, unknown> = {
      cwd: this.cwd,
      permissionMode: this.permissionMode,
    };

    if (this.maxBudgetUsd !== undefined) {
      sdkOptions.maxBudgetUsd = this.maxBudgetUsd;
    }

    if (this.maxTurns !== undefined) {
      sdkOptions.maxTurns = this.maxTurns;
    }

    if (this.model ?? spec.model) {
      sdkOptions.model = this.model ?? spec.model;
    }

    if (this.claudeCodePath) {
      sdkOptions.pathToClaudeCodeExecutable = this.claudeCodePath;
    }

    if (this.env) {
      sdkOptions.env = this.env;
    }
    // ADR-130：本轮身份交给 agent 的子进程环境 —— PreToolUse 钩子据此
    // 把 `policy.decision` 归属到这一轮。不碰判定本身（C3/C5 不变）。
    if (spec.runId) {
      sdkOptions.env = { ...(this.env ?? {}), ZELTO_RUN_ID: spec.runId };
    }

    const abortController = new AbortController();
    const startedAt = new Date().toISOString();

    // Store session state before starting (so waitForExit can find it)
    this.sessions.set(sessionId, {
      sessionId,
      startedAt,
      abortController,
      retryCount,
      exited: false,
      exitCode: null,
    });

    // Start the agent session via SDK
    // The abortController MUST be handed to the SDK — it is the only thing that
    // actually tears down the spawned Claude Code process. Without it, stop()
    // and the timeout timer would only clear local bookkeeping while the
    // child process kept running (and kept the event loop alive).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const warm = await startup({ options: { ...sdkOptions, abortController } as any });

    // Send the prompt
    const gen = warm.query(spec.prompt);

    // Set timeout
    const timeout = setTimeout(() => {
      this.handleTimeout(sessionId);
    }, this.timeoutMs);
    // ADR-125：与 shell 适配器同口径 —— 空转倒计时不拖住进程退出。
    (timeout as unknown as { unref?: () => void }).unref?.();
    this.timeouts.set(sessionId, timeout);

    // Start progress reporting interval (every 5 seconds)
    if (this.onProgress) {
      const startedAtMs = Date.parse(startedAt);
      const progressInterval = setInterval(() => {
        if (!this.sessions.has(sessionId)) {
          clearInterval(progressInterval);
          return;
        }
        const elapsed = Date.now() - startedAtMs;
        this.onProgress!(sessionId, elapsed, 'running');
      }, 5000);
      // ADR-125：心跳不许拖住进程退出 —— 它只负责落盘活性证据。
      (progressInterval as unknown as { unref?: () => void }).unref?.();
      this.progressIntervals.set(sessionId, progressInterval);
    }

    // Start consuming the generator in the background
    const done = this.consumeGenerator(sessionId, spec, gen, retryCount).catch((err) => {
      // If the session was intentionally stopped, ignore the error
      if ((err as Error).message?.includes('abort') || (err as Error).message?.includes('AbortError')) {
        return;
      }
      console.error(`[sdk-adapter] Session ${sessionId} error:`, err);
    });
    this.trackDrain(sessionId, done);

    return { sessionId };
  }

  /**
   * Remember when a session's generator loop has fully unwound, so stop() can
   * wait for the child process to actually be gone.
   */
  private trackDrain(sessionId: string, done: Promise<void>): void {
    void done.finally(() => {
      this.drainedSessions.add(sessionId);
      const resolve = this.drainResolvers.get(sessionId);
      if (resolve) {
        this.drainResolvers.delete(sessionId);
        resolve();
      }
    });
  }

  /**
   * Consume the AsyncGenerator from query() and store events.
   * This runs in the background while the agent works.
   * Handles timeout and retry internally.
   */
  private async consumeGenerator(
    sessionId: string,
    spec: { sliceId: string; prompt: string; model?: string },
    gen: AsyncGenerator<unknown, void>,
    retryCount: number,
  ): Promise<void> {
    const eventBuffer: EventEnvelope[] = [];
    try {
      for await (const message of gen) {
        const msg = message as Record<string, unknown>;
        const msgType = (msg.type as string) ?? 'unknown';

        const envelope: EventEnvelope = {
          ts: new Date().toISOString(),
          runSeq: eventBuffer.length + 1,
          slice: sessionId.split('-')[1] ?? 'unknown',
          run: sessionId,
          type: inferEventType(msgType, msg),
          actor: 'agent',
          payload: msg as Record<string, unknown>,
        };

        eventBuffer.push(envelope);

        // 用量上报（ADR-035 §3.2）：SDK 的 `result` 消息自带 `total_cost_usd`
        // 与 `usage`。记到会话上，`getUsage` 直接返回。
        if (msgType === 'result' || 'total_cost_usd' in msg) {
          const usage = parseClaudeUsage(msg);
          if (usage) this.sessionUsage.set(sessionId, usage);
        }

        // ZD-007：**运行中**的累计花费。
        //
        // SDK 每条 assistant 消息都带 `usage`（token 数），但**不带**累计金额
        // —— 金额只在 `result` 消息里。所以运行中能报的是**token**，
        // 金额要靠模型单价折算。
        //
        // 为什么值得做：`getUsage` 只有在 agent **退出**后才有值，
        // 于是「运行中查预算」根本无从下手（ZD-007 的病灶：
        // 一轮烧 $5.86 没人拦得住）。token 是运行中**唯一**能拿到的信号，
        // 它足够粗，但够用来**停手**。
        //
        // 折算用配置里的 `llm.pricing`（每 1k token 的价）。
        // 没有配单价 → **报不了金额**（返回 null = 「测不到」）——
        // 宁可测不到，也不拿一个猜的金额去判「超支」（那会让预算闸门变成假闸门）。
        const liveTokens = this.accumulateLiveTokens(sessionId, msg);
        if (liveTokens) {
          this.sessionLiveTokens.set(sessionId, liveTokens);
        }

        // Keep only the last 100 events in memory
        if (eventBuffer.length > 100) {
          eventBuffer.shift();
        }

        // Store events on the session for later retrieval
        this.sessionEvents.set(sessionId, [...eventBuffer]);

        // Capture text output for progress callbacks
        const text = (msg.text as string) ?? (msg.content as string) ?? '';
        if (msgType === 'text' && text) {
          this.sessionText.set(
            sessionId,
            (this.sessionText.get(sessionId) ?? '') + text,
          );
          if (this.onOutput) {
            this.onOutput(sessionId, text);
          }
        }
      }

      // Generator completed normally
      this.handleExit(sessionId, 0);
    } catch (err) {
      // Generator stopped (error or abort)
      this.sessionEvents.set(sessionId, [...eventBuffer]);

      const errMsg = (err as Error).message ?? '';
      if (errMsg.includes('abort') || errMsg.includes('AbortError')) {
        // Intentionally stopped — don't retry
        this.handleExit(sessionId, null);
      } else if (retryCount < this.maxRetries) {
        // Retry on unexpected errors
        const newRetry = retryCount + 1;
        if (this.onOutput) {
          this.onOutput(sessionId, `\n[zelto: retrying (attempt ${newRetry}/${this.maxRetries})]\n`);
        }
        try {
          const { sessionId: newId } = await this.startWithRetry(spec, newRetry);
          // Resolve the old session's exit promise via the new session
          const newCode = await this.waitForExit(newId);
          this.handleExit(sessionId, newCode);
        } catch {
          this.handleExit(sessionId, 1);
        }
      } else {
        // Max retries exceeded
        if (this.onOutput) {
          this.onOutput(sessionId, `\n[zelto: max retries (${this.maxRetries}) exceeded]\n`);
        }
        this.handleExit(sessionId, 1);
      }
    }
  }

  // ─── Timeout Handling ──────────────────────────────────────────────────────

  private handleTimeout(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (this.onOutput) {
      this.onOutput(sessionId, `\n[zelto: timeout after ${this.timeoutMs}ms]\n`);
    }

    // Abort the generator
    session.abortController.abort();
    this.handleExit(sessionId, null);
  }

  // ─── Exit Handling ─────────────────────────────────────────────────────────

  private handleExit(sessionId: string, exitCode: number | null): void {
    // Clear timeout
    const timeout = this.timeouts.get(sessionId);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(sessionId);
    }

    // Clear progress interval
    const progressInterval = this.progressIntervals.get(sessionId);
    if (progressInterval) {
      clearInterval(progressInterval);
      this.progressIntervals.delete(sessionId);
    }

    // Record the exit on the session state so a later waitForExit() call can
    // resolve immediately instead of waiting forever.
    const session = this.sessions.get(sessionId);
    if (session) {
      session.exited = true;
      session.exitCode = exitCode;
    }

    // Resolve the exit promise
    const resolve = this.exitResolvers.get(sessionId);
    if (resolve) {
      resolve(exitCode);
      this.exitResolvers.delete(sessionId);
    }
  }

  async resume(
    _sessionId: string,
    _patch: string,
    _opts?: { runId?: string },
  ): Promise<{ sessionId: string }> {
    // Read the session's event history to rebuild context
    const existingEvents = this.sessionEvents.get(_sessionId);
    const contextSummary =
      existingEvents && existingEvents.length > 0
        ? `Previous run had ${existingEvents.length} events. Last event: ${existingEvents[existingEvents.length - 1]?.type}`
        : 'No previous events found.';

    // Start a new query with the patch appended to the context
    const combinedPrompt = `${contextSummary}\n\n${_patch}`;

    const abortController = new AbortController();

    const warm = await startup({
      options: {
        cwd: this.cwd,
        permissionMode: this.permissionMode,
        // Same as start(): the controller is what actually stops the child
        // process, so it has to reach the SDK.
        abortController,
        // ADR-130：续跑仍属同一轮，runId 照样交给 agent 环境。
        ...(_opts?.runId ? { env: { ...(this.env ?? {}), ZELTO_RUN_ID: _opts.runId } } : {}),
      },
    });

    const gen = warm.query(combinedPrompt);
    const newSessionId = `sdk-resume-${Date.now()}`;

    this.sessions.set(newSessionId, {
      sessionId: newSessionId,
      startedAt: new Date().toISOString(),
      abortController,
      retryCount: 0,
      exited: false,
      exitCode: null,
    });

    const done = this.consumeGenerator(newSessionId, { sliceId: _sessionId, prompt: combinedPrompt }, gen, 0).catch(() => {});
    this.trackDrain(newSessionId, done);

    return { sessionId: newSessionId };
  }

  /**
   * Continue the same agent conversation with arbitrary instructions (ADR-055).
   *
   * SDK 适配器没有「同一个会话」的概念（见 `getAgentSessionId` 的说明），
   * 所以它续的是**同一份工作区的上下文**，不是字面上的同一段对话：
   * 提示词里带上上一轮的事件摘要，让 agent 知道「上次做到哪儿了」。
   * 这比从头跑强：至少不用重新摸索已经摸清的东西。
   */
  async continueSession(
    sessionId: string,
    instructions: string,
    _opts?: { runId?: string },
  ): Promise<{ sessionId: string }> {
    const existingEvents = this.sessionEvents.get(sessionId);
    const contextSummary =
      existingEvents && existingEvents.length > 0
        ? `Previous run had ${existingEvents.length} events. Last event: ${existingEvents[existingEvents.length - 1]?.type}`
        : 'No previous events found.';

    const combinedPrompt = `${contextSummary}\n\n${instructions}`;

    const abortController = new AbortController();
    // ADR-130：续跑仍属同一轮 —— 调用方给了 runId 就注入 agent 环境。
    const envForRun = _opts?.runId
      ? { env: { ...(this.env ?? {}), ZELTO_RUN_ID: _opts.runId } }
      : {};
    const warm = await startup({
      options: {
        cwd: this.cwd,
        permissionMode: this.permissionMode,
        abortController,
        ...envForRun,
      },
    });

    const gen = warm.query(combinedPrompt);
    const newSessionId = `sdk-continue-${Date.now()}`;

    this.sessions.set(newSessionId, {
      sessionId: newSessionId,
      startedAt: new Date().toISOString(),
      abortController,
      retryCount: 0,
      exited: false,
      exitCode: null,
    });

    const done = this.consumeGenerator(newSessionId, { sliceId: sessionId, prompt: combinedPrompt }, gen, 0).catch(() => {});
    this.trackDrain(newSessionId, done);

    return { sessionId: newSessionId };
  }

  /**
   * Get the agent's output text for a session.
   *
   * The SDK adapter keeps the full message history; the text messages make up
   * the agent's answer.
   */
  getOutput(sessionId: string): string {
    const text = this.sessionText.get(sessionId);
    if (text) return text;
    const events = this.sessionEvents.get(sessionId) ?? [];
    const parts: string[] = [];
    for (const e of events) {
      const payload = e.payload as Record<string, unknown> | undefined;
      if (!payload) continue;
      if (payload.type === 'text') {
        const text = (payload.text as string) ?? '';
        if (text) parts.push(text);
      } else if (typeof payload.result === 'string') {
        parts.push(payload.result);
      }
    }
    return parts.join('\n');
  }

  /**
   * The agent-side conversation id.
   *
   * The SDK adapter does not expose the underlying conversation id, so it
   * cannot be continued verbatim (ADR-013 §3.4).
   */
  getAgentSessionId(_sessionId: string): string | null {
    return null;
  }

  /**
   * 本次会话花了多少钱（ADR-035）。
   *
   * SDK 只在 `result` 消息里报花费；没收到就返回 null ——
   * 意味着「没测到」，而不是「零」。把两者混同会让预算闸门变成一道假闸门。
   */
  getUsage(sessionId: string): AdapterUsage | null {
    return this.sessionUsage.get(sessionId) ?? null;
  }

  /**
   * ZD-007：运行中的累计用量。
   *
   * 金额由 token × 单价折算（SDK 的 assistant 消息只给 token，不给金额）。
   * 没有单价 → 返回 null（「测不到」），不猜金额。
   */
  getLiveUsage(sessionId: string): AdapterUsage | null {
    const tokens = this.sessionLiveTokens.get(sessionId);
    const price = this.pricePerKToken;
    if (!tokens || !price) return null;

    const inputCost = (tokens.inputTokens / 1000) * price.input;
    const outputCost = (tokens.outputTokens / 1000) * price.output;
    const costUsd = inputCost + outputCost;
    if (!Number.isFinite(costUsd) || costUsd < 0) return null;

    const usage: AdapterUsage = { costUsd };
    if (tokens.inputTokens > 0) usage.inputTokens = tokens.inputTokens;
    if (tokens.outputTokens > 0) usage.outputTokens = tokens.outputTokens;
    if (tokens.model) usage.model = tokens.model;
    return usage;
  }

  /**
   * ZD-007：从一条 SDK 消息里累加 token。
   *
   * SDK 的形状：assistant 消息的 `message.usage` 里带 `input_tokens` /
   * `output_tokens`；`result` 消息带 `usage`（同样的字段）+
   * `total_cost_usd`（最终金额）。
   *
   * 这里**只认** `message.usage` 与顶层 `usage` 两处 ——
   * 免得把 `result` 消息里那份最终 usage 与中途累加的重复计入。
   * 所以 `result` 消息不参与累加（金额由 `getUsage` 单独报）。
   *
   * 返回累加后的累计 token；这条消息没带 token 时返回 null（不更新）。
   */
  private accumulateLiveTokens(
    sessionId: string,
    msg: Record<string, unknown>,
  ): LiveTokenCount | null {
    const msgType = typeof msg.type === 'string' ? msg.type : '';

    // `result` 消息的 usage 是**最终**用量（与中途累加重复）—— 不参与累加。
    if (msgType === 'result') return null;

    const inner = asRecord(msg.message);
    const usage = inner ? asRecord(inner.usage) : asRecord(msg.usage);
    if (!usage) return null;

    const inputTokens = firstFiniteNumber(usage.input_tokens, usage.inputTokens);
    const outputTokens = firstFiniteNumber(usage.output_tokens, usage.outputTokens);
    if (inputTokens === null && outputTokens === null) return null;

    const prev = this.sessionLiveTokens.get(sessionId);
    const next: LiveTokenCount = {
      inputTokens: (prev?.inputTokens ?? 0) + (inputTokens ?? 0),
      outputTokens: (prev?.outputTokens ?? 0) + (outputTokens ?? 0),
      model: prev?.model ?? (typeof msg.model === 'string' ? msg.model : undefined),
    };
    return next;
  }

  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found`);
    }

    // Clear timeout
    const timeout = this.timeouts.get(sessionId);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(sessionId);
    }

    // Clear progress interval
    const progressInterval = this.progressIntervals.get(sessionId);
    if (progressInterval) {
      clearInterval(progressInterval);
      this.progressIntervals.delete(sessionId);
    }

    // Abort the generator to stop the agent. The controller is wired into the
    // SDK, so this tears down the spawned Claude Code process.
    session.abortController.abort();
    this.handleExit(sessionId, null);
    this.sessions.delete(sessionId);

    // Wait for the generator loop to unwind so the child process is really
    // gone before we return — otherwise the caller (and the test process)
    // still has a live `claude.exe` holding the event loop open.
    await this.waitForDrain(sessionId, 5_000);
  }

  /**
   * Wait until a session's generator loop has unwound, or until the timeout
   * elapses. Never rejects — a stuck teardown must not mask the stop() result.
   */
  private async waitForDrain(sessionId: string, timeoutMs: number): Promise<void> {
    if (this.drainedSessions.has(sessionId)) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.drainResolvers.delete(sessionId);
        resolve();
      }, timeoutMs);
      this.drainResolvers.set(sessionId, () => {
        clearTimeout(timer);
        resolve();
      });
      // The loop may have unwound between the check above and the registration.
      if (this.drainedSessions.has(sessionId)) {
        clearTimeout(timer);
        this.drainResolvers.delete(sessionId);
        resolve();
      }
    });
  }

  async events(sessionId: string): Promise<AsyncIterable<EventEnvelope>> {
    const events = this.sessionEvents.get(sessionId) ?? [];
    return {
      [Symbol.asyncIterator](): AsyncIterator<EventEnvelope> {
        let index = 0;
        return {
          next(): Promise<IteratorResult<EventEnvelope>> {
            if (index < events.length) {
              return Promise.resolve({ value: events[index++], done: false });
            }
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
  }

  /** Get the exit status — resolves when the generator completes */
  async waitForExit(sessionId: string): Promise<number | null> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    // The session may already have ended before waitForExit() was called —
    // resolve immediately rather than hanging forever.
    if (session.exited) {
      return session.exitCode;
    }

    return new Promise<number | null>((resolve) => {
      this.exitResolvers.set(sessionId, resolve);
    });
  }

  // ─── Health / Status ───────────────────────────────────────────────────────

  /**
   * Check if an agent session is still alive.
   * Returns true if the session exists and hasn't resolved yet.
   */
  isSessionAlive(sessionId: string): boolean {
    return this.sessions.has(sessionId) && !this.exitResolvers.has(sessionId);
  }

  /**
   * Get the last N event summaries for a session.
   */
  getRecentEvents(sessionId: string, count: number = 10): EventEnvelope[] {
    const events = this.sessionEvents.get(sessionId) ?? [];
    return events.slice(-count);
  }
}
