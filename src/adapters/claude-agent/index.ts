// ClaudeAgentAdapter — ExecutorAdapter implementation for Claude Code CLI
//
// Spawns `npx claude-code` (or configured agent command) as a child process,
// passing ZELTO_BUNDLE, ZELTO_SLICE_ID, and ZELTO_PROJECT_ROOT env vars.

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { type ExecutorAdapter, type AdapterMeta } from '../../core/ports/executor.js';
import type { EventEnvelope } from '../../core/events/index.js';

interface ClaudeAgentAdapterOptions {
  /** Path to the agent binary (default: 'npx claude-code') */
  agentCommand?: string;
  /** Working directory for spawned processes (default: process.cwd()) */
  cwd?: string;
  /** Environment variables to pass (default: process.env) */
  env?: NodeJS.ProcessEnv;
}

const ADAPTER_META: AdapterMeta = {
  version: '1.0.0',
  description: 'Claude Code CLI adapter — spawns npx claude-code as child process',
  capabilities: {
    resume: false,
    events: false,
    modelSelection: false,
  },
};

interface SessionState {
  child: ChildProcess;
  startedAt: string;
}

export class ClaudeAgentAdapter implements ExecutorAdapter {
  readonly name = 'claude-agent';
  readonly metadata: AdapterMeta = ADAPTER_META;

  private readonly agentCommand: string;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly sessions = new Map<string, SessionState>();

  constructor(options: ClaudeAgentAdapterOptions = {}) {
    this.agentCommand = options.agentCommand ?? 'npx claude-code';
    this.cwd = options.cwd ?? process.cwd();
    this.env = options.env ?? process.env;
  }

  async start(spec: { sliceId: string; prompt: string; model?: string }): Promise<{ sessionId: string }> {
    const sessionId = `claude-agent-${spec.sliceId}-${Date.now()}`;

    // Build args: if prompt is a file path (bundle), pass it as the prompt file
    const bundlePath = spec.prompt;

    const child = spawn(this.agentCommand, [], {
      cwd: this.cwd,
      stdio: ['inherit', 'inherit', 'inherit'],
      shell: true,
      env: {
        ...this.env,
        ZELTO_BUNDLE: bundlePath,
        ZELTO_SLICE_ID: spec.sliceId,
        ZELTO_PROJECT_ROOT: this.cwd,
      },
    });

    this.sessions.set(sessionId, {
      child,
      startedAt: new Date().toISOString(),
    });

    // Clean up on exit
    child.on('close', () => {
      this.sessions.delete(sessionId);
    });

    return { sessionId };
  }

  async resume(_sessionId: string, _patch: string): Promise<void> {
    throw new Error('resume not supported by ClaudeAgentAdapter');
  }

  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found`);
    }
    session.child.kill('SIGTERM');
    // Give it a moment, then SIGKILL
    setTimeout(() => {
      try { session.child.kill('SIGKILL'); } catch { /* already dead */ }
    }, 5000);
  }

  async events(_sessionId: string): Promise<AsyncIterable<EventEnvelope>> {
    throw new Error('events streaming not supported by ClaudeAgentAdapter');
  }

  /** Get exit code promise for a session — used by CLI to await completion */
  waitForExit(sessionId: string): Promise<number | null> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return Promise.resolve(null);
    }
    return new Promise<number | null>((resolve) => {
      session.child.on('close', (code) => resolve(code));
      session.child.on('error', () => resolve(1));
    });
  }
}
