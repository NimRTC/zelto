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
   * @param sessionId — The session to resume
   * @param patch — Additional instructions or context to inject
   */
  resume(sessionId: string, patch: string): Promise<void>;

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
