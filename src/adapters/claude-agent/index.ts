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

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
  /**
   * Agent-side session id (the Claude Code session uuid).
   *
   * zelto generates it at start time and passes it via `--session-id`, so that
   * the very same conversation can be continued later with `--resume`.
   * Null for agents whose command does not support the flag.
   */
  agentSessionId: string | null;
  /** Working directory the agent ran in — resume must use the same one. */
  cwd: string;
  /** zelto session this one continues (null for a fresh start). */
  resumedFrom: string | null;
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
  version: '2.2.0',
  description: 'Claude Code CLI adapter — spawns npx claude-code with session persistence, timeout, retry, and same-session resume',
  capabilities: {
    resume: true,
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
  /** True once the child has exited — waitForExit resolves immediately then. */
  exited: boolean;
  exitCode: number | null;
}

/** Flags appended when the agent command is Claude Code. */
function claudeCodeFlags(extra: string[] = []): string {
  return ['--print', '--permission-mode', 'bypassPermissions', ...extra].join(' ');
}

export class ClaudeAgentAdapter implements ExecutorAdapter {
  readonly name = 'claude-agent';
  readonly metadata: AdapterMeta = ADAPTER_META;

  private readonly agentCommand: string;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly onOutput?: (sessionId: string, text: string) => void;
  private readonly onProgress?: (sessionId: string, elapsedMs: number, status: string) => void;
  private readonly sessions = new Map<string, SessionState>();
  /** Live session records — the in-memory twin of the persisted session file. */
  private readonly sessionData = new Map<string, PersistentSessionData>();
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

    // Every run gets its own agent-side session id up front, so that the very
    // same conversation can be continued later with `--resume` (ADR-013 §3.4).
    const agentSessionId = randomUUID();

    return this.spawn({
      sessionId,
      sliceId: spec.sliceId,
      instructions,
      bundlePath,
      retryCount,
      agentSessionId,
      resumeAgentSessionId: null,
      resumedFromZelto: null,
    });
  }

  /**
   * Spawn the agent process.
   *
   * Shared by `start` (fresh conversation) and `resume` (continuation).
   * `agentSessionId` is the Claude Code conversation id; `resumeFrom` is the
   * agent-side id to continue — when set, `--resume` is used instead of
   * `--session-id`.
   */
  private spawn(opts: {
    sessionId: string;
    sliceId: string;
    instructions: string;
    bundlePath: string;
    retryCount: number;
    agentSessionId: string;
    /** Agent-side conversation id to continue (null → fresh conversation). */
    resumeAgentSessionId: string | null;
    /** zelto session this one continues (null → fresh start). */
    resumedFromZelto: string | null;
    cwd?: string;
    agentCommand?: string;
  }): { sessionId: string } {
    const { sessionId, sliceId, instructions, bundlePath, retryCount, agentSessionId } = opts;
    const workDir = opts.cwd ?? this.cwd;
    // Resume must use the very same agent command as the original run —
    // otherwise the continuation would talk to a different agent.
    const agentCommand = opts.agentCommand ?? this.agentCommand;
    const isClaudeCode = /claude(-code)?\b/.test(agentCommand);

    // Write instructions to a temp file
    const tmpDir = mkdtempSync(join(tmpdir(), 'zelto-prompt-'));
    const tmpFile = join(tmpDir, `${sliceId}.txt`);
    writeFileSync(tmpFile, instructions, 'utf-8');

    // Create persistent session data
    const sessionData: PersistentSessionData = {
      sessionId,
      sliceId,
      agentCommand,
      startedAt: new Date().toISOString(),
      status: 'running',
      exitCode: null,
      timeoutMs: this.timeoutMs,
      retryCount,
      maxRetries: this.maxRetries,
      prompt: bundlePath,
      output: [],
      agentSessionId,
      cwd: workDir,
      resumedFrom: opts.resumedFromZelto,
    };
    saveSession(sessionData);
    // Keep the live object in memory so the output collected while running is
    // not lost when the session is finalised (C1 — the file is the truth).
    this.sessionData.set(sessionId, sessionData);

    // Spawn with --print for non-interactive execution
    // Use --permission-mode bypassPermissions since zelto's own policy system governs access
    // Build spawn env: copy parent env but strip ANTHROPIC_MODEL to avoid
    // model-recognition warnings in Claude Code (the warning is non-fatal but noisy)
    const spawnEnv: NodeJS.ProcessEnv = { ...this.env };
    delete spawnEnv.ANTHROPIC_MODEL;

    // Add Claude Code-specific flags only when running Claude Code.
    // Continuing a conversation uses `--resume <agentSessionId>`; a fresh run
    // pins the conversation id with `--session-id <agentSessionId>`.
    const claudeFlags = isClaudeCode
      ? ' ' + claudeCodeFlags(
          opts.resumeAgentSessionId
            ? ['--resume', opts.resumeAgentSessionId]
            : ['--session-id', agentSessionId],
        )
      : '';

    const child = spawn(
      `${agentCommand}${claudeFlags} < "${tmpFile}"`,
      [],
      {
        cwd: workDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
        env: {
          ...spawnEnv,
          ZELTO_BUNDLE: bundlePath,
          ZELTO_SLICE_ID: sliceId,
          ZELTO_PROJECT_ROOT: workDir,
          ZELTO_SESSION_ID: sessionId,
          ZELTO_AGENT_SESSION_ID: agentSessionId,
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
      sliceId,
      retryCount,
      output: [],
      exited: false,
      exitCode: null,
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

    const data = this.sessionData.get(sessionId) ?? loadSession(sessionId);
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

    // Update persistent session — use the live record so the output captured
    // while running is preserved (the file on disk still holds the empty
    // array written at start).
    const data = this.sessionData.get(sessionId) ?? loadSession(sessionId);
    if (data) {
      data.exitCode = exitCode;
      data.status = exitCode === 0 ? 'completed' : 'failed';
      saveSession(data);
    }

    const state = this.sessions.get(sessionId);
    if (state) {
      state.exited = true;
      state.exitCode = exitCode;
    }
  }

  // ─── Resume ────────────────────────────────────────────────────────────────

  /**
   * Continue the same agent conversation.
   *
   * The agent-side session id is reused with `--resume`, so the agent keeps
   * the context of the previous run (ADR-013 §3.4). The working directory
   * stays the slice's worktree, so the write-set reservation is unaffected
   * (C9).
   */
  async resume(sessionId: string, patch: string): Promise<{ sessionId: string }> {
    const data = this.sessionData.get(sessionId) ?? loadSession(sessionId);
    if (!data) {
      throw new Error(`Session "${sessionId}" not found — cannot resume`);
    }
    if (!data.agentSessionId) {
      throw new Error(
        `Session "${sessionId}" has no agent-side session id — cannot continue the same conversation`,
      );
    }

    const newSessionId = `claude-agent-${data.sliceId}-${Date.now()}-resume`;
    const instructions = [
      'You previously asked a question and the human answered it.',
      '',
      'The answer is:',
      patch,
      '',
      'Continue the work in this same session. If anything is still unclear, ask again using the question marker.',
    ].join('\n');

    return this.spawn({
      sessionId: newSessionId,
      sliceId: data.sliceId,
      instructions,
      bundlePath: data.prompt,
      retryCount: data.retryCount,
      agentSessionId: data.agentSessionId,
      resumeAgentSessionId: data.agentSessionId,
      resumedFromZelto: sessionId,
      cwd: data.cwd || this.cwd,
      agentCommand: data.agentCommand || this.agentCommand,
    });
  }

  // ─── Output ────────────────────────────────────────────────────────────────

  /**
   * Get the agent's output text for a session.
   *
   * Prefers the in-memory record (complete) and falls back to the persisted
   * file (survives a restart).
   */
  getOutput(sessionId: string): string {
    const data = this.sessionData.get(sessionId) ?? loadSession(sessionId);
    if (!data) return '';
    return data.output.join('');
  }

  /** The agent-side conversation id (the Claude Code session uuid). */
  getAgentSessionId(sessionId: string): string | null {
    const data = this.sessionData.get(sessionId) ?? loadSession(sessionId);
    return data?.agentSessionId ?? null;
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
    const data = this.sessionData.get(sessionId) ?? loadSession(sessionId);
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

    // The child may already have exited before waitForExit was called
    // (the resume path spawns and then waits) — resolve immediately.
    if (session.exited) {
      return Promise.resolve(session.exitCode);
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

          // A resumed session must NOT be auto-retried from the original
          // bundle: that would restart the slice from scratch and throw away
          // the human's answer. The human decides what to do next.
          if (data.resumedFrom) {
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
   *
   * `where` / `which` only find executables on PATH — shell built-ins such as
   * `echo` are reported by neither. Since the agent is spawned through a shell
   * (`shell: true`), built-ins do run. So when the PATH lookup fails we fall
   * back to asking the shell whether it knows the command.
   */
  static async checkAgentAvailable(agentCommand: string): Promise<string | null> {
    const cmd = agentCommand.split(' ')[0]; // Get the base command
    const lookup = process.platform === 'win32' ? 'where' : 'which';

    try {
      execSync(`${lookup} ${cmd}`, { stdio: 'ignore', timeout: 5000 });
      return null;
    } catch {
      // Not on PATH — check whether the shell can resolve it anyway.
      if (this.isShellResolvable(cmd)) return null;
      return `Agent command "${agentCommand}" not found. Install it or update .zelto/config.yaml agent.command.`;
    }
  }

  /**
   * Whether the platform's shell can run the given command, even though it is
   * not an executable on PATH.
   *
   * Windows: cmd.exe has a fixed set of built-ins; a command outside that set
   * is genuinely missing. POSIX: `command -v` resolves built-ins, functions and
   * aliases without executing them.
   */
  private static isShellResolvable(cmd: string): boolean {
    if (process.platform === 'win32') {
      const builtins = new Set([
        'assoc', 'break', 'call', 'cd', 'chdir', 'cls', 'color', 'copy',
        'date', 'del', 'dir', 'echo', 'endlocal', 'erase', 'exit', 'for',
        'ftype', 'goto', 'if', 'md', 'mkdir', 'mklink', 'move', 'path',
        'pause', 'popd', 'prompt', 'pushd', 'rd', 'rmdir', 'rem', 'ren',
        'rename', 'set', 'setlocal', 'shift', 'start', 'time', 'title',
        'type', 'ver', 'verify', 'vol',
      ]);
      return builtins.has(cmd.toLowerCase());
    }

    try {
      execSync(`sh -c "command -v ${cmd} >/dev/null 2>&1"`, { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
}
