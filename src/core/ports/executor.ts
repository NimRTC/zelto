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
   * @returns A session identifier
   */
  start(spec: { sliceId: string; prompt: string; model?: string }): Promise<{ sessionId: string }>;

  /**
   * Resume an existing agent session with additional context.
   *
   * The agent continues the *same* conversation, so the agent-side session id
   * must be preserved (see ADR-013 §3.4). Adapters that cannot truly resume
   * must throw rather than silently start a fresh conversation.
   *
   * @param sessionId — The zelto session to resume
   * @param patch — Additional instructions or context to inject
   * @returns The zelto session id of the continued session
   */
  resume(sessionId: string, patch: string): Promise<{ sessionId: string }>;

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
   */
  continueSession?(sessionId: string, instructions: string): Promise<{ sessionId: string }>;

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
