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
import { type ExecutorAdapter, type AdapterMeta } from '../../core/ports/executor.js';
import type { EventEnvelope, EventType } from '../../core/events/index.js';

export interface ClaudeAgentSdkAdapterOptions {
  /** Working directory for the agent session (default: process.cwd()) */
  cwd?: string;
  /** Maximum budget in USD (default: no limit) */
  maxBudgetUsd?: number;
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
  /** Resolve functions for waitForExit promises, keyed by sessionId */
  private readonly exitResolvers = new Map<string, (code: number | null) => void>();
  /** Resolvers for "the generator loop has fully unwound", keyed by sessionId */
  private readonly drainResolvers = new Map<string, () => void>();
  /** Sessions whose generator loop has already fully unwound */
  private readonly drainedSessions = new Set<string>();

  constructor(options: ClaudeAgentSdkAdapterOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.maxBudgetUsd = options.maxBudgetUsd;
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
  }): Promise<{ sessionId: string }> {
    return this.startWithRetry(spec, 0);
  }

  private async startWithRetry(
    spec: { sliceId: string; prompt: string; model?: string },
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

  async resume(_sessionId: string, _patch: string): Promise<{ sessionId: string }> {
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
