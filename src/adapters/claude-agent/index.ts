// ClaudeAgentAdapter — ExecutorAdapter implementation for Claude Code CLI
//
// Spawns `npx claude-code` (or configured agent command) as a child process,
// passing the bundle instructions via --print for non-interactive execution.
//
// Features:
// - Session persistence to .zelto/sessions/ for crash recovery
// - Configurable timeout (kills agent if it exceeds time limit)
// - Configurable retry (re-spawns on failure up to maxRetries)
// - Output capture for event logging
// - Temp file cleanup on exit

import { spawn, type ChildProcess } from 'node:child_process';
import { join, dirname } from 'node:path';
import {
  readFileSync, writeFileSync, mkdtempSync, rmSync,
  existsSync, mkdirSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { type ExecutorAdapter, type AdapterMeta } from '../../core/ports/executor.js';
import type { EventEnvelope } from '../../core/events/index.js';

// ─── Session Persistence ─────────────────────────────────────────────────────

const SESSIONS_DIR = '.zelto/sessions';

export interface PersistentSessionData {
  sessionId: string;
  sliceId: string;
  agentCommand: string;
  startedAt: string;
  status: 'running' | 'completed' | 'failed' | 'timeout' | 'killed';
  exitCode: number | null;
  timeoutMs: number | null;
  retryCount: number;
  maxRetries: number;
  prompt: string;        // original bundle path for retry
  output: string[];
}

function sessionPath(sessionId: string): string {
  return join(SESSIONS_DIR, `${sessionId}.json`);
}

function saveSession(data: PersistentSessionData): void {
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true });
  }
  writeFileSync(sessionPath(data.sessionId), JSON.stringify(data, null, 2), 'utf-8');
}

function loadSession(sessionId: string): PersistentSessionData | null {
  const path = sessionPath(sessionId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as PersistentSessionData;
  } catch {
    return null;
  }
}

// ─── Options ─────────────────────────────────────────────────────────────────

interface ClaudeAgentAdapterOptions {
  /** Path to the agent binary (default: 'npx claude-code') */
  agentCommand?: string;
  /** Working directory for spawned processes (default: process.cwd()) */
  cwd?: string;
  /** Environment variables to pass (default: process.env) */
  env?: NodeJS.ProcessEnv;
  /** Maximum time in ms before killing the agent (default: 900000 = 15 min) */
  timeoutMs?: number;
  /** Maximum number of retries on failure (default: 2) */
  maxRetries?: number;
  /**
   * Optional callback for real-time output from the agent.
   * Called with each line of stdout/stderr as it arrives.
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
  description: 'Claude Code CLI adapter — spawns npx claude-code with session persistence, timeout, and retry',
  capabilities: {
    resume: false,
    events: false,
    modelSelection: false,
  },
};

interface SessionState {
  child: ChildProcess;
  startedAt: string;
  sliceId: string;
  retryCount: number;
  output: string[];
}

export class ClaudeAgentAdapter implements ExecutorAdapter {
  readonly name = 'claude-agent';
  readonly metadata: AdapterMeta = ADAPTER_META;

  private readonly agentCommand: string;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly useClaudeCodeFlags: boolean;
  private readonly onOutput?: (sessionId: string, text: string) => void;
  private readonly onProgress?: (sessionId: string, elapsedMs: number, status: string) => void;
  private readonly sessions = new Map<string, SessionState>();
  private timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private progressIntervals = new Map<string, ReturnType<typeof setInterval>>();

  constructor(options: ClaudeAgentAdapterOptions = {}) {
    this.agentCommand = options.agentCommand ?? 'npx claude-code';
    this.cwd = options.cwd ?? process.cwd();
    this.env = options.env ?? process.env;
    this.timeoutMs = options.timeoutMs ?? 900_000; // 15 minutes default
    this.maxRetries = options.maxRetries ?? 2;
    this.onOutput = options.onOutput;
    this.onProgress = options.onProgress;
    // Detect if the command is Claude Code (npx or direct binary)
    this.useClaudeCodeFlags = /claude(-code)?\b/.test(this.agentCommand);
  }

  // ─── Session Recovery ──────────────────────────────────────────────────────

  /**
   * Recover sessions that were left in 'running' state from a previous zelto instance.
   * Call this on startup if needed.
   * Returns list of recovered session IDs.
   */
  recoverRunningSessions(): string[] {
    if (!existsSync(SESSIONS_DIR)) return [];

    const recovered: string[] = [];
    for (const file of readdirSync(SESSIONS_DIR)) {
      if (!file.endsWith('.json')) continue;
      const sessionId = file.slice(0, -5);
      const data = loadSession(sessionId);
      if (data && data.status === 'running') {
        // Mark as failed since the process died with us
        data.status = 'failed';
        data.exitCode = null;
        data.output.push('[zelto: session orphaned on restart]');
        saveSession(data);
        recovered.push(sessionId);
      }
    }
    return recovered;
  }

  // ─── Start ─────────────────────────────────────────────────────────────────

  async start(spec: { sliceId: string; prompt: string; model?: string }): Promise<{ sessionId: string }> {
    return this.startWithRetry(spec, 0);
  }

  private async startWithRetry(
    spec: { sliceId: string; prompt: string; model?: string },
    retryCount: number,
  ): Promise<{ sessionId: string }> {
    const sessionId = `claude-agent-${spec.sliceId}-${Date.now()}${retryCount > 0 ? `-retry-${retryCount}` : ''}`;

    // Read the bundle file to extract the instructions text
    const bundlePath = spec.prompt;
    let instructions: string;
    try {
      const bundleContent = readFileSync(bundlePath, 'utf-8');
      const bundle = JSON.parse(bundleContent);
      instructions = bundle.instructions ?? bundleContent;
    } catch {
      instructions = spec.prompt;
    }

    // Write instructions to a temp file
    const tmpDir = mkdtempSync(join(tmpdir(), 'zelto-prompt-'));
    const tmpFile = join(tmpDir, `${spec.sliceId}.txt`);
    writeFileSync(tmpFile, instructions, 'utf-8');

    // Create persistent session data
    const sessionData: PersistentSessionData = {
      sessionId,
      sliceId: spec.sliceId,
      agentCommand: this.agentCommand,
      startedAt: new Date().toISOString(),
      status: 'running',
      exitCode: null,
      timeoutMs: this.timeoutMs,
      retryCount,
      maxRetries: this.maxRetries,
      prompt: bundlePath,
      output: [],
    };
    saveSession(sessionData);

    // Spawn with --print for non-interactive execution
    // Use --permission-mode bypassPermissions since zelto's own policy system governs access
    // Build spawn env: copy parent env but strip ANTHROPIC_MODEL to avoid
    // model-recognition warnings in Claude Code (the warning is non-fatal but noisy)
    const spawnEnv: NodeJS.ProcessEnv = { ...this.env };
    delete spawnEnv.ANTHROPIC_MODEL;

    // Add Claude Code-specific flags only when running Claude Code
    const claudeFlags = this.useClaudeCodeFlags
      ? ' --print --permission-mode bypassPermissions'
      : '';

    const child = spawn(
      `${this.agentCommand}${claudeFlags} < "${tmpFile}"`,
      [],
      {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
        env: {
          ...spawnEnv,
          ZELTO_BUNDLE: bundlePath,
          ZELTO_SLICE_ID: spec.sliceId,
          ZELTO_PROJECT_ROOT: this.cwd,
          ZELTO_SESSION_ID: sessionId,
        },
      },
    );

    // Capture stdout
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      state.output.push(text);
      sessionData.output.push(text);
      if (this.onOutput) {
        this.onOutput(sessionId, text);
      }
    });

    // Capture stderr
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      state.output.push(text);
      sessionData.output.push(text);
      if (this.onOutput) {
        this.onOutput(sessionId, text);
      }
    });

    const state: SessionState = {
      child,
      startedAt: sessionData.startedAt,
      sliceId: spec.sliceId,
      retryCount,
      output: [],
    };

    this.sessions.set(sessionId, state);

    // Set timeout
    const timeout = setTimeout(() => {
      this.handleTimeout(sessionId);
    }, this.timeoutMs);
    this.timeouts.set(sessionId, timeout);

    // Start progress reporting interval (every 5 seconds)
    if (this.onProgress) {
      const startedAt = Date.parse(sessionData.startedAt);
      const progressInterval = setInterval(() => {
        if (!this.sessions.has(sessionId)) {
          clearInterval(progressInterval);
          return;
        }
        const elapsed = Date.now() - startedAt;
        this.onProgress!(sessionId, elapsed, 'running');
      }, 5000);
      this.progressIntervals.set(sessionId, progressInterval);
    }

    // Clean up temp file on exit
    const cleanup = () => {
      try { rmSync(tmpDir, { force: true, recursive: true }); } catch { /* ignore */ }
    };
    child.on('exit', cleanup);
    child.on('error', cleanup);

    // Track exit
    child.on('close', (code) => {
      this.handleExit(sessionId, code);
    });

    return { sessionId };
  }

  // ─── Timeout Handling ──────────────────────────────────────────────────────

  private handleTimeout(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const data = loadSession(sessionId);
    if (data && data.status === 'running') {
      data.status = 'timeout';
      data.output.push(`[zelto: timeout after ${this.timeoutMs}ms]`);
      saveSession(data);
    }

    if (this.onOutput) {
      this.onOutput(sessionId, `\n[zelto: timeout after ${this.timeoutMs}ms]\n`);
    }

    // Kill gracefully first, then force
    session.child.kill('SIGTERM');
    setTimeout(() => {
      try { session.child.kill('SIGKILL'); } catch { /* already dead */ }
    }, 3000);
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

    // Update persistent session
    const data = loadSession(sessionId);
    if (data) {
      data.exitCode = exitCode;
      data.status = exitCode === 0 ? 'completed' : 'failed';
      saveSession(data);
    }
  }

  // ─── Resume ────────────────────────────────────────────────────────────────

  async resume(_sessionId: string, _patch: string): Promise<void> {
    throw new Error('resume not supported by ClaudeAgentAdapter');
  }

  // ─── Stop ──────────────────────────────────────────────────────────────────

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

    // Update persistent session
    const data = loadSession(sessionId);
    if (data && data.status === 'running') {
      data.status = 'killed';
      data.output.push('[zelto: session stopped by user]');
      saveSession(data);
    }

    session.child.kill('SIGTERM');
    setTimeout(() => {
      try { session.child.kill('SIGKILL'); } catch { /* already dead */ }
    }, 5000);
  }

  // ─── Events ────────────────────────────────────────────────────────────────

  async events(_sessionId: string): Promise<AsyncIterable<EventEnvelope>> {
    throw new Error('events streaming not supported by ClaudeAgentAdapter');
  }

  // ─── Wait For Exit ─────────────────────────────────────────────────────────

  /**
   * Get exit code promise for a session.
   * Supports retry: if exit code != 0 and retries remain, auto-restarts.
   */
  waitForExit(sessionId: string): Promise<number | null> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return Promise.resolve(null);
    }

    return new Promise<number | null>((resolve) => {
      const checkExit = async (code: number | null) => {
        if (code === 0) {
          resolve(0);
          return;
        }

        // Check if we should retry
        if (code !== null && code !== 0 && session.retryCount < this.maxRetries) {
          const data = loadSession(sessionId);
          if (!data || !data.prompt) {
            resolve(code);
            return;
          }

          const newRetry = session.retryCount + 1;
          // Start retry using the original prompt from session data
          try {
            const { sessionId: newId } = await this.startWithRetry(
              { sliceId: session.sliceId, prompt: data.prompt },
              newRetry,
            );
            // Wait on the new session
            const newCode = await this.waitForExit(newId);
            resolve(newCode);
          } catch {
            resolve(code);
          }
          return;
        }

        resolve(code);
      };

      session.child.on('close', checkExit);
      session.child.on('error', () => checkExit(1));
    });
  }

  // ─── Session Status (query) ────────────────────────────────────────────────

  /** Get the status of a session from persistent storage */
  getSessionStatus(sessionId: string): PersistentSessionData | null {
    return loadSession(sessionId);
  }

  /** List all persisted sessions for a slice */
  listSliceSessions(sliceId: string): PersistentSessionData[] {
    if (!existsSync(SESSIONS_DIR)) return [];
    const sessions: PersistentSessionData[] = [];
    for (const file of readdirSync(SESSIONS_DIR)) {
      if (!file.endsWith('.json')) continue;
      const data = loadSession(file.slice(0, -5));
      if (data && data.sliceId === sliceId) {
        sessions.push(data);
      }
    }
    return sessions.sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
  }

  /**
   * Check if an agent session is still alive.
   * Returns true if the session exists and the child process is still running.
   */
  isSessionAlive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    try {
      return session.child.exitCode === null && session.child.killed === false;
    } catch {
      return false;
    }
  }

  /**
   * Get recent output lines from a running session.
   * Returns the last N lines of captured output.
   */
  getRecentOutput(sessionId: string, maxLines: number = 20): string[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    const allOutput = session.output.join('').split('\n');
    return allOutput.slice(-maxLines);
  }

  /**
   * Check if the agent command is available on this system.
   * Returns null if available, or an error message if not.
   */
  static async checkAgentAvailable(agentCommand: string): Promise<string | null> {
    try {
      const { execSync } = await import('node:child_process');
      const cmd = agentCommand.split(' ')[0]; // Get the base command
      execSync(`${process.platform === 'win32' ? 'where' : 'which'} ${cmd}`, {
        stdio: 'ignore',
        timeout: 5000,
      });
      return null;
    } catch {
      return `Agent command "${agentCommand}" not found. Install it or update .zelto/config.yaml agent.command.`;
    }
  }
}
