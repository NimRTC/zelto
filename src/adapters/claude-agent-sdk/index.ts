// ClaudeAgentSdkAdapter — ExecutorAdapter implementation using the Claude Agent SDK
//
// Unlike the shell-spawn adapter, this uses the SDK's programmatic API:
//   - startup() → warmQuery.query(prompt) → AsyncGenerator of SDKMessage events
//   - Supports budget limits (maxBudgetUsd), max turns, and permission modes
//   - Supports session resume via session IDs
//   - Streams real-time events from the agent session
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
}

const ADAPTER_META: AdapterMeta = {
  version: '1.0.0',
  description:
    'Claude Agent SDK adapter — programmatic agent control with budget, events, and resume',
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

  /** Active sessions keyed by sessionId */
  private readonly sessions = new Map<string, SdkSessionState>();

  constructor(options: ClaudeAgentSdkAdapterOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.maxBudgetUsd = options.maxBudgetUsd;
    this.maxTurns = options.maxTurns;
    this.model = options.model;
    this.claudeCodePath = options.claudeCodePath;
    this.permissionMode = options.permissionMode ?? 'bypassPermissions';
    this.env = options.env;
  }

  async start(spec: {
    sliceId: string;
    prompt: string;
    model?: string;
  }): Promise<{ sessionId: string }> {
    const sessionId = `sdk-${spec.sliceId}-${Date.now()}`;

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

    // Start the agent session via SDK
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const warm = await startup({ options: sdkOptions as any });

    // Send the prompt
    const gen = warm.query(spec.prompt);

    // Store session state (the generator runs asynchronously)
    this.sessions.set(sessionId, {
      sessionId,
      startedAt: new Date().toISOString(),
      abortController,
    });

    // Start consuming the generator in the background
    // The consumer stores the last few messages for event streaming
    this.consumeGenerator(sessionId, gen).catch((err) => {
      // If the session was intentionally stopped, ignore the error
      if ((err as Error).message?.includes('abort') || (err as Error).message?.includes('AbortError')) {
        return;
      }
      console.error(`[sdk-adapter] Session ${sessionId} error:`, err);
    });

    return { sessionId };
  }

  /**
   * Consume the AsyncGenerator from query() and store events.
   * This runs in the background while the agent works.
   */
  private async consumeGenerator(
    sessionId: string,
    gen: AsyncGenerator<unknown, void>,
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
      }
    } catch (err) {
      // Generator stopped (normal end or abort)
      this.sessionEvents.set(sessionId, [...eventBuffer]);
      throw err;
    }
  }

  /** Buffer of events per session, for the events() method */
  private readonly sessionEvents = new Map<string, EventEnvelope[]>();

  async resume(_sessionId: string, _patch: string): Promise<void> {
    // Resume is supported via SDK's session resume mechanism.
    // The SDK can resume a previous session by session UUID.
    // For now, we re-start with additional context in the prompt.
    //
    // In a full implementation, this would use the SDK's session persistence
    // to restore the agent's state and inject the patch as additional context.

    // Read the session's event history to rebuild context
    const existingEvents = this.sessionEvents.get(_sessionId);
    const contextSummary =
      existingEvents && existingEvents.length > 0
        ? `Previous run had ${existingEvents.length} events. Last event: ${existingEvents[existingEvents.length - 1]?.type}`
        : 'No previous events found.';

    // Start a new query with the patch appended to the context
    const combinedPrompt = `${contextSummary}\n\n${_patch}`;

    const warm = await startup({
      options: {
        cwd: this.cwd,
        permissionMode: this.permissionMode,
      },
    });

    const gen = warm.query(combinedPrompt);
    const newSessionId = `sdk-resume-${Date.now()}`;

    this.sessions.set(newSessionId, {
      sessionId: newSessionId,
      startedAt: new Date().toISOString(),
      abortController: new AbortController(),
    });

    this.consumeGenerator(newSessionId, gen).catch(() => {});
  }

  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found`);
    }

    // Abort the generator to stop the agent
    session.abortController.abort();
    this.sessions.delete(sessionId);
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

    // Wait for the generator to complete (or be aborted)
    // We do this by polling the session events for a terminal event
    return new Promise<number | null>((resolve) => {
      const check = () => {
        const events = this.sessionEvents.get(sessionId) ?? [];
        const lastEvent = events[events.length - 1];

        if (lastEvent?.type === 'run.finished') {
          resolve(0);
        } else if (lastEvent?.type === 'run.aborted') {
          resolve(1);
        } else if (!this.sessions.has(sessionId)) {
          resolve(null);
        } else {
          // Still running — check again in 500ms
          setTimeout(check, 500);
        }
      };
      check();
    });
  }
}
