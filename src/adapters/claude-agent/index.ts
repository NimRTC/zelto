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
import { tmpdir, platform } from 'node:os';
import { type ExecutorAdapter, type AdapterMeta, type AdapterUsage } from '../../core/ports/executor.js';
import type { EventEnvelope } from '../../core/events/index.js';
import { extractClaudeJson, extractClaudeResult, parseClaudeUsage } from '../usage-parse.js';
import { killProcessTree, killProcessTreeGracefully } from '../process-tree.js';
import { readProcessTable, findDescendants, findPidsByCmdline } from '../../core/sched/process-table.js';

/** 睡一会儿（毫秒）—— 只用于「等 agent 进程起来」这种轮询。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 是不是一个普通对象（非 null、非数组）—— 解析 NDJSON 时用。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 取第一个可用的有限数字（snake_case 与 camelCase 都认）。 */
function firstNumber(...values: unknown[]): number | null {
  for (const v of values) {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseFloat(v) : Number.NaN;
    if (Number.isFinite(n)) return n;
  }
  return null;
}

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
   * 心跳 —— 最后活动时间（ISO）。
   *
   * D-30：`--detach` 的后台监视器随主进程退出而死，只剩一个永远 `running`
   * 的空壳。任何后来的 zelto 调用（`tasks` / `status` / `watchdog` / Web）
   * 都要能回答「它多久没动了」—— 靠的就是这个字段。
   * 每次有输出、每次心跳 tick 都刷新它（见 spawn 里的数据回调与心跳定时器）。
   */
  lastActivityAt?: string;
  /** 最后一条 agent 输出的时间（输出是副产品，心跳才是「还管着」的证据） */
  lastOutputAt?: string;
  /** 跑这条会话的 agent 子进程 pid —— 没了它就没法判定进程死活 */
  pid?: number;
  /**
   * **真正的 agent 进程** pid（Windows 上与 `pid` 不同）。
   *
   * `pid` 记的是外层 `cmd.exe`（`shell: true` 的必然结果），
   * 真正的 agent（`claude.exe`）是它的孙进程。外层退出后 agent 还活着，
   * 但按 `pid` 判就是「死了」→ 看门狗误判 → 在同一个 worktree 上
   * 又起一个 agent，两个 agent 互相覆盖（实测于 nimrtc-zelto v2-input-binder）。
   *
   * 所以活性判定以本字段为准；它没记上时退回到「看整棵进程树」。
   */
  agentPid?: number;
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
  /**
   * 本轮的运行身份（ADR-129 / ADR-130）。跑在 zelto 之外起的会话没有它 → null。
   *
   * 续跑（`resume` / `continueSession`）从这里读回 —— 一轮的 runId 整轮不变，
   * 续跑出来的新会话仍得用同一个值注入 `ZELTO_RUN_ID`，否则续跑期间的
   * `policy.decision` 全落成 `run: null`，追溯链在那一段断掉。
   */
  runId?: string | null;
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
   * 用 `--output-format stream-json --verbose` 跑（ZD-007 阶段2）。
   *
   * 开着时 stdout 是 **NDJSON**（逐行 JSON 事件），agent **运行中**就会
   * 逐条吐出 `assistant` 消息（各带 `message.usage`），于是适配器能在
   * agent 还没退出时累加 token、`getLiveUsage` 报出累计花费 —— 运行中
   * 预算拦截才对 shell 适配器生效。
   *
   * 默认关（保持 `json` 一次性输出）。前提：配了 `pricePerKToken`，
   * 否则只累加 token、报不出金额（仍然拦不了）。
   */
  streamJson?: boolean;
  /**
   * 每 1k token 的单价（ZD-007）。用于把运行中累加的 token 折成金额。
   * 没有它 `getLiveUsage` 报不出金额（返回 null = 「测不到」），不猜。
   */
  pricePerKToken?: { input: number; output: number };
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
    // ADR-133：C9 主判定点在 agent 侧的 PreToolUse 钩子。
    writeGuard: 'hook',
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

/**
 * Flags appended when the agent command is Claude Code.
 *
 * `--output-format json` 让 Claude Code 把本次运行汇报成一个 JSON 对象
 * （其中含 `result` / `total_cost_usd` / `usage`），适配器才能上报真实花费
 * （ADR-035 §3.2）。代价是 stdout 一次性到达，不再逐块流式回调 ——
 * ADR 已把这条记为「不是缺陷」。
 */
function claudeCodeFlags(extra: string[] = [], streamJson = false): string {
  // ZD-007 阶段2：stream-json 让 stdout 变成 NDJSON 逐行事件，
  // agent 运行中就能报用量；代价是必须同时给 `--verbose`（否则
  // Claude Code 直接报错退出）。`--include-partial-messages` 不是必需的
  // （我们只要 `assistant` 消息里的 usage，不要 token 级增量），不加。
  const outputFlags = streamJson
    ? ['--output-format', 'stream-json', '--verbose']
    : ['--output-format', 'json'];
  return [
    '--print',
    '--permission-mode',
    'bypassPermissions',
    ...outputFlags,
    ...extra,
  ].join(' ');
}

/**
 * 一行 stderr 是不是 Claude Code 的启动噪声（ADR-074）。
 *
 * 判据：以 `[claude-code:` 开头的诊断行（如 `unrecognized_model`）。
 * 实测于 nimrtc-zelto：接自定义网关时 `ANTHROPIC_MODEL=deepseek-v4-flash-anthropic`
 * 不在 Claude Code 内置模型表里，它每次启动都打一行
 * `[claude-code:unrecognized_model] {...}` —— **一次都没导致失败**
 * （退出码 0、结果完整），只是把会话文件的「最后一条输出」霸占成了噪声。
 *
 * 多行块里只要混有真实输出，就不算噪声（返回 false）。
 */
export function isStartupNoise(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;
  return lines.every((l) => l.trim().startsWith('[claude-code:'));
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
  /** ZD-007 阶段2：用 stream-json 跑（运行中可报用量） */
  private readonly streamJson: boolean;
  /** ZD-007：单价，用于把运行中累加的 token 折成金额 */
  private readonly pricePerKToken?: { input: number; output: number };
  /**
   * ZD-007：运行中累计的 token（按会话记）。
   *
   * 只累加 `assistant` 消息里的 `message.usage` —— `result` 消息的 usage
   * 是**最终**用量（与中途累加重复，且它自带 `total_cost_usd`，由
   * `getUsage` 单独报），所以不参与累加。
   */
  private readonly sessionLiveTokens = new Map<string, { input: number; output: number; model?: string }>();
  /** 每个会话尚未成型的 stdout 尾巴（按行切分用，跨 chunk 拼行）。 */
  private readonly ndjsonBuffers = new Map<string, string>();
  /** 已处理到的「stream 模式下已解析的最后一条 result」，用于去重。 */
  private readonly lastStreamResult = new Map<string, Record<string, unknown>>();
  private readonly sessions = new Map<string, SessionState>();
  /**
   * 尚未落盘的启动噪声（`[claude-code:*]` 行），按会话记。
   * 运行成功 → 丢弃；运行失败 → 补回会话输出（ADR-074，见 spawn 的 stderr 处理）。
   */
  private readonly pendingNoise = new Map<string, string[]>();
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
    this.streamJson = options.streamJson ?? false;
    this.pricePerKToken = options.pricePerKToken;
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
      // ADR-130：本轮身份原样传下去，hook 事件据此归属轮次
      runId: spec.runId ?? null,
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
    /**
     * 本轮 runId（ADR-130）；null / 缺省 → 不注入 `ZELTO_RUN_ID`
     * （hook 事件如实留空，不凭空造一个）。
     */
    runId?: string | null;
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
    const nowIso = new Date().toISOString();
    const sessionData: PersistentSessionData = {
      sessionId,
      sliceId,
      agentCommand,
      startedAt: nowIso,
      status: 'running',
      exitCode: null,
      timeoutMs: this.timeoutMs,
      retryCount,
      maxRetries: this.maxRetries,
      prompt: bundlePath,
      output: [],
      lastActivityAt: nowIso,
      lastOutputAt: undefined,
      pid: undefined,
      agentSessionId,
      cwd: workDir,
      resumedFrom: opts.resumedFromZelto,
      // ADR-130：本轮身份随会话落盘 —— 续跑（resume / continueSession）
      // 从会话文件读回它，保证同一轮里所有判定事件归属同一个 runId。
      runId: opts.runId ?? null,
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
          this.streamJson,
        )
      : '';

    const child = spawn(
      `${agentCommand}${claudeFlags} < "${tmpFile}"`,
      [],
      {
        cwd: workDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
        // POSIX 上把子进程放进独立进程组（ADR-055）：这样
        // `killProcessTree` 才能用 `kill(-pid)` 一次干掉
        // npx / node / agent 整条链，而不是只杀 shell。
        // Windows 上这个标志会另开一个控制台窗口，所以只在 POSIX 开。
        detached: platform() !== 'win32',
        env: {
          ...spawnEnv,
          ZELTO_BUNDLE: bundlePath,
          ZELTO_SLICE_ID: sliceId,
          ZELTO_PROJECT_ROOT: workDir,
          ZELTO_SESSION_ID: sessionId,
          ZELTO_AGENT_SESSION_ID: agentSessionId,
          // ADR-130：本轮身份交给 agent 的子进程（hook 从这里取）
          ...(opts.runId ? { ZELTO_RUN_ID: opts.runId } : {}),
        },
      },
    );

    // Capture stdout
    //
    // 注意（实测 nimrtc-v14 v3-n4-d6-connectivity，2026-11-22）：
    //   Claude Code 用 `--output-format json` 跑 —— stdout **一次性**到达，
    //   整轮运行里 `output` 只有最后那个 JSON blob。
    //   所以「运行期间 output 是空的」**不是缺陷**，是 `--output-format json`
    //   的必然结果（见 claudeCodeFlags 的说明）。
    //
    //   想在运行期间看到 agent 在干什么，要看**事件流**（每次工具调用
    //   都被 hook 判过并写了事件），不是看 stdout —— 见
    //   `core/activity/liveness.ts` 的 `readEventProgress`。
    const touchActivity = (): void => {
      const now = new Date().toISOString();
      sessionData.lastOutputAt = now;
      sessionData.lastActivityAt = now;
      // D-55：输出就是「有进展」—— 空转的倒计时要重新开始。
      this.resetIdleTimer(sessionId);
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      state.output.push(text);
      sessionData.output.push(text);
      touchActivity();
      // ZD-007 阶段2：stream-json 模式下逐行解析，累加运行中用量。
      if (this.streamJson) {
        this.consumeNdjson(sessionId, text);
      }
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

    // Capture stderr
    //
    // ADR-074：Claude Code 的启动噪声（`[claude-code:<tag>] …`，例如
    // `unrecognized_model` —— 自定义网关下 ANTHROPIC_MODEL 不匹配内置表时
    // 它每次启动都会打一行）**不是失败**：运行照常完成、退出码 0。
    // 但它会霸占会话文件的「最后一条输出」，驾驶舱于是把一条噪声显示成
    // 「进度」。处理方式：运行中先压着，**失败时**再补回输出；
    // 成功时丢弃 —— 成功的事实由 `run.finished` 与退出码记录，不需要噪声陪葬。
    const pendingNoise: string[] = [];
    this.pendingNoise.set(sessionId, pendingNoise);
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      state.output.push(text);
      const noiseOnly = isStartupNoise(text);
      if (noiseOnly) {
        pendingNoise.push(text);
      } else {
        // 噪声之后有真实输出：噪声先补回**会话文件**，保持输出顺序
        // （内存里的输出不补 —— 它服务的是本轮 `onOutput`，噪声已经在界面上被压掉了）
        if (pendingNoise.length > 0) {
          sessionData.output.push(...pendingNoise.splice(0));
        }
        sessionData.output.push(text);
        touchActivity();
      }
      if (this.onOutput && !noiseOnly) {
        this.onOutput(sessionId, text);
      }
    });

    // D-30 心跳：pid + 最后活动时间落盘，后来的任何 zelto 调用都能判定活性。
    // 只在内存里记 = 主进程一退就全丢，这正是假死的来源。
    sessionData.pid = child.pid ?? undefined;
    sessionData.lastActivityAt = nowIso;
    saveSession(sessionData);

    // 定位**真正的 agent 进程** pid（见 PersistentSessionData.agentPid 的说明）。
    //
    // `child.pid` 是外层 cmd.exe 的 pid（`shell: true` 的必然结果），
    // 真正的 agent 是孙进程。外层退出后 agent 还活着 ——
    // 按 `child.pid` 判会误判「死了」，看门狗据此重跑，
    // 于是在同一个 worktree 上起了第二个 agent，两者互相覆盖产出。
    //
    // 找法：agent 命令行里有本次会话独有的 `--session-id <uuid>`，
    // 按这个特征在进程表里反查，比「猜第几层子进程」可靠。
    void this.resolveAgentPid(sessionId, agentSessionId, child.pid);

    // D-55：这里是**空转超时**（idle timeout），不是绝对超时。
    //
    // 病灶（实测于 nimrtc-zelto v3-chrome-waterfall，2026-11-17）：
    //   原先是「起跑后 1800s 一刀切」。而这个 agent 在被砍的前 30 秒
    //   **还在改文件** —— 它不是做不完，是「做得完但总时长超过上限」。
    //   于是一轮 30 分钟的工作被砍掉、续跑、再砍、再续跑 ——
    //   三轮 90 分钟、token 大把烧掉，产物仍未过门禁。
    //
    //   绝对超时惩罚的是「做得久」，而超时真正该抓的是「卡住不动」。
    //   所以倒计时改成：**没有进展**才走。每有一次进展（输出、
    //   工具调用、hook 判定）就重新开始计时。
    //
    // 「进展」从哪来（两个真实信号）：
    //   1. agent 的 stdout/stderr —— 见上面的 `touchActivity`；
    //   2. **工具调用** —— CLI 层看到切片事件流有新事件就调
    //      `adapter.markProgress(sessionId)`（见 executor.ts 的说明）。
    //      这一条是关键：Claude Code 跑的是 `--output-format json`，
    //      stdout 直到最后才有内容 —— 只看输出的话，
    //      「正在连续调用工具的 agent」会被误判成卡住。
    //
    // 上限不变（还是配置里的 `agent.timeout`），但语义从「总时长」
    // 变成「无进展时长」。进展一直有 → 永远不砍。
    this.resetIdleTimer(sessionId);

    // Start progress reporting interval (every 5 seconds)
    // D-30 心跳落盘：不管有没有 onProgress，都每 5 秒把 lastActivityAt 写进
    // 会话文件 —— 这是「还活着」的唯一跨进程证据。主进程退了，文件还在，
    // 后来的 zelto 调用才能判定「它多久没动了」。
    {
      const heartbeat = setInterval(() => {
        if (!this.sessions.has(sessionId)) {
          clearInterval(heartbeat);
          return;
        }
        const data = this.sessionData.get(sessionId);
        if (data && data.status === 'running') {
          data.lastActivityAt = new Date().toISOString();
          try {
            saveSession(data);
          } catch { /* 心跳写盘失败不阻断运行 */ }
        }
        if (this.onProgress) {
          const startedAt = Date.parse(sessionData.startedAt);
          const elapsed = Date.now() - startedAt;
          this.onProgress(sessionId, elapsed, 'running');
        }
      }, 5000);
      // ADR-125：心跳**不许**拖住进程退出。
      //
      // 病灶（实测 nimrtc-v14 v4-d5-audio-dtx，2026-11-26）：监督进程
      // 收尾全部做完（切片已退回 frozen、预约已释放、日志写了「退出」），
      // 进程却一直挂在进程表上 —— 因为收尾完成后这个方法还被调用过一次
      // （收尾流水线里的预算核对会 `markProgress` → `resetIdleTimer` →
      // 重建心跳），一个没 `unref` 的 `setInterval` 让事件循环永远不空，
      // `process.exit` 之后的自然退出永远不到来。
      //
      // 心跳的职责是「落盘活性证据」，不是「让进程活着」——
      // 进程该不该活由 supervise 的收尾负责，不由一个定时器决定。
      (heartbeat as unknown as { unref?: () => void }).unref?.();
      this.progressIntervals.set(sessionId, heartbeat);
    }

    // Clean up temp file on exit
    const cleanup = () => {
      try { rmSync(tmpDir, { force: true, recursive: true }); } catch { /* ignore */ }
    };
    child.on('exit', cleanup);
    child.on('error', cleanup);

    // 记录退出码 —— 记在 `exit` 上，**不是** `close`（D-59）。
    //
    // 病灶（实测 nimrtc-zelto v3-weaknet-verdict，2026-11-18）：
    //   agent **成功跑完了**（活干完、总结也写了），但监督进程判它「结果不明」，
    //   按失败处理 → 重试一轮 → 白烧一轮 token。
    //
    // 根因：`close` 事件要等 **stdio 全部关闭**（stdout/stderr 的 EOF）。
    //   而 agent 在 worktree 里起了**后台进程**（ctest / cmake），
    //   那些进程**继承了 agent 的 stdout 管道** —— 它们不退出，管道就不 EOF，
    //   `close` 永远不来。
    //
    //   `exit` 事件只等**进程本身**退出，stdio 还没关时就到了。
    //   这才是「agent 跑完了」的正确信号。
    //
    // 两个都挂：`close` 作为兜底（万一 `exit` 没来），
    // 但用 `exited` 守卫，保证只处理一次。
    let exitHandled = false;
    const onExit = (code: number | null): void => {
      if (exitHandled) return;
      exitHandled = true;
      this.handleExit(sessionId, code);
    };
    child.on('exit', onExit);
    child.on('close', onExit);

    return { sessionId };
  }

  // ─── Timeout Handling ──────────────────────────────────────────────────────

  /**
   * 找出真正的 agent 进程 pid，记进会话文件。
   *
   * 判据：命令行里含 `--session-id <本次会话 uuid>`。
   * 这个 uuid 是 zelto 生成的、每次运行独有，所以反查它是精确的 ——
   * 不会误认成别人的 agent，也不会漏掉自己的。
   *
   * 找不到就退而求其次：取包装进程的后代里、**最深的那个**
   * （agent 一定是链条末端）。仍然找不到就不写 ——
   * 活性判定会退回到「看整棵进程树」，不会因此误判。
   */
  private async resolveAgentPid(
    sessionId: string,
    agentSessionId: string,
    wrapperPid: number | undefined,
  ): Promise<void> {
    const needle = `--session-id ${agentSessionId}`;
    // agent 起来要时间：轮询几次，每次间隔 1s，最多 ~8s。
    for (let attempt = 0; attempt < 8; attempt++) {
      await sleep(1000);
      const data = this.sessionData.get(sessionId);
      if (!data || data.status !== 'running') return; // 已经结束了，不必再找

      const pids = await findPidsByCmdline(needle);
      if (pids.length > 0) {
        // 排除包装进程本身（cmd.exe 的命令行里也有这个参数）。
        const real = pids.find((p) => p !== wrapperPid) ?? pids[0];
        data.agentPid = real;
        try {
          saveSession(data);
        } catch { /* 写盘失败不阻断运行 */ }
        return;
      }
    }

    // 兜底：取包装进程的最深后代。
    if (wrapperPid === undefined) return;
    const rows = await readProcessTable();
    if (rows.length === 0) return;
    const descendants = findDescendants(rows, wrapperPid);
    if (descendants.length === 0) return;
    // 深度 = 沿 ppid 链的长度；最深的就是离包装进程最远的那个。
    const depthOf = (pid: number): number => {
      const byPid = new Map(rows.map((r) => [r.pid, r]));
      let d = 0;
      let cur = byPid.get(pid);
      while (cur && cur.ppid !== 0 && cur.ppid !== cur.pid && d < 32) {
        cur = byPid.get(cur.ppid);
        d++;
      }
      return d;
    };
    let deepest = descendants[0];
    let deepestDepth = depthOf(deepest.pid);
    for (const d of descendants) {
      const depth = depthOf(d.pid);
      if (depth > deepestDepth) {
        deepest = d;
        deepestDepth = depth;
      }
    }
    const data = this.sessionData.get(sessionId);
    if (!data || data.status !== 'running') return;
    data.agentPid = deepest.pid;
    try {
      saveSession(data);
    } catch { /* 写盘失败不阻断运行 */ }
  }

  /**
   * 重新开始「无进展」倒计时（D-55）。
   *
   * 每次有进展（输出 / 工具调用）就调一次。倒计时归零 → `handleTimeout`
   * → 标记 `status = 'timeout'` 并杀掉整棵进程树。
   *
   * 会话已经不在了（跑完了）就什么都不做 —— 不给已结束的会话留定时器。
   */
  private resetIdleTimer(sessionId: string): void {
    const existing = this.timeouts.get(sessionId);
    if (existing) clearTimeout(existing);
    if (!this.sessions.has(sessionId)) {
      this.timeouts.delete(sessionId);
      return;
    }
    const timer = setTimeout(() => {
      this.handleTimeout(sessionId);
    }, this.timeoutMs);
    // 定时器不能拖住进程退出（主进程 process.exit 时要能走）
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timeouts.set(sessionId, timer);
  }

  /**
   * 外部报告「这一轮有进展」（D-55）。
   *
   * 谁调它：CLI 层（前台跑与后台监督进程）在**看到切片事件流有新事件**时
   * —— 那些事件是 agent 的 PreToolUse hook 写的，每调用一次工具就有一条。
   * 这条通道是必需的：Claude Code 跑 `--output-format json`，
   * stdout 直到最后才有内容，只看输出会把「正在连续调用工具的 agent」
   * 误判成卡住。
   *
   * 没实现的适配器不受影响（可选能力）。
   */
  markProgress(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return;
    this.resetIdleTimer(sessionId);
  }

  private handleTimeout(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const data = this.sessionData.get(sessionId) ?? loadSession(sessionId);
    if (data && data.status === 'running') {
      data.status = 'timeout';
      // D-55：措辞要准 —— 是「无进展超时」，不是「跑太久」。
      // 说成「跑太久」会让人去调小上限，而正确反应是「agent 卡住了」。
      data.output.push(`[zelto: no progress for ${this.timeoutMs}ms — killed]`);
      saveSession(data);
    }

    if (this.onOutput) {
      this.onOutput(sessionId, `\n[zelto: no progress for ${this.timeoutMs}ms — killed]\n`);
    }

    // Kill the whole process tree — not just the shell wrapper (ADR-055).
    // 只杀 shell 的话，agent 会变成孤儿继续跑：继续改文件、继续烧 token，
    // 而 zelto 已经判了「失败」并准备重试 —— 两个 agent 抢同一批文件。
    //
    // ── 但光靠包装 pid 还不够 ────────────────────────────────────────
    // 实测（nimrtc-zelto v2-input-binder，2026-11-17）：
    // 超时点 `taskkill /pid <包装pid> /T` **没杀掉真正的 agent**。
    // 包装 cmd.exe 早就退出了（`/T` 按它当时的子进程树算，
    // 而 agent 是它的孙进程），于是 taskkill 找不到人，
    // 真正的 agent（pid 28072）继续跑：继续改文件、继续发 policy.decision，
    // 而 zelto 已经把它判成 timeout 并准备重试 —— 两个 agent 抢同一批文件。
    //
    // 所以这里必须**两个 pid 都杀**：包装 pid（杀管道与后代）
    // 与 `agentPid`（杀 agent 本人）。
    this.killSessionTree(sessionId, session.child.pid);
  }

  /**
   * 杀掉一次运行涉及的全部进程：包装进程树 + 真正的 agent。
   *
   * 为什么要两个都杀（实测于 nimrtc-zelto v2-input-binder，2026-11-17）：
   *
   *   `child.pid` 是外层 `cmd.exe`（`shell: true` 的必然结果）。
   *   `taskkill /pid <cmd.exe> /T` 杀的是**它当时的子进程树** ——
   *   而 cmd.exe 通常在 npx 启动后不久就退出了，它的树里已经没有 agent 了，
   *   `npx`/`node`/`claude` 是被**孤儿收养**后继续跑的独立进程。
   *
   *   结果：超时判定生效了（status=timeout），agent 却没死。
   *   它继续改文件、继续烧 token，而 zelto 已经在同一 worktree 上重试 ——
   *   两个 agent 抢同一批文件，产出互相覆盖。
   *
   *   `agentPid` 是按 `--session-id <uuid>` 反查进程表拿到的 agent 本人 pid
   *   （见 `resolveAgentPid`）。它必须被单独杀一次。
   */
  private killSessionTree(sessionId: string, wrapperPid: number | undefined): void {
    const data = this.sessionData.get(sessionId) ?? loadSession(sessionId);
    const agentPid = typeof data?.agentPid === 'number' ? data.agentPid : undefined;

    // 包装进程树（含 npx / cmd 等中间层）
    killProcessTreeGracefully(wrapperPid);

    // agent 本人 —— 包装树杀不到它时，它是唯一的兜底。
    if (agentPid && agentPid !== wrapperPid) {
      killProcessTreeGracefully(agentPid);
    }
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
      // 超时是「超时」，不是「失败」（ADR-055）：被信号杀掉时 exitCode 是
      // null，原来这里一律写成 failed，把「跑超时了」和「agent 报错退出」
      // 混成同一件事 —— 前者重试有意义，后者往往没意义。
      if (data.status === 'timeout') {
        data.status = 'timeout';
      } else {
        data.status = exitCode === 0 ? 'completed' : 'failed';
        // ADR-074：启动噪声（`[claude-code:*]`）在成功时丢弃、失败时补回。
        // 成功时保留它只会霸占「最后一条输出」，让下一轮的人以为是当代进度。
        const noise = this.pendingNoise.get(sessionId);
        this.pendingNoise.delete(sessionId);
        if (noise && noise.length > 0 && exitCode !== 0) data.output.push(...noise);
      }
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
  async resume(
    sessionId: string,
    patch: string,
    opts?: { runId?: string },
  ): Promise<{ sessionId: string }> {
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
      // ADR-130：续跑仍属同一轮 —— 调用方确认过就用它，否则从会话文件读回。
      // `sessionData` 里那份可能是**运行期间刚建、还没带 runId 的旧对象**，
      // 数据里没有时再读一次文件。
      runId: opts?.runId ?? data.runId ?? loadSession(sessionId)?.runId ?? null,
    });
  }

  /**
   * Continue the same agent conversation with arbitrary instructions (ADR-055).
   *
   * 与 `resume()` 的区别只在**提示词**：resume 是问答回路（「你问的问题，
   * 人这么答」），continueSession 是超时重试（「接着上次做」）。两者共用
   * 同一条 `--resume` 通道 —— 同一个 agent 会话、同一份上下文、同一个
   * worktree（写集预约不受影响）。
   *
   * 续跑与从头跑的区别很大：超时被杀时 agent 已经做掉的工作留在
   * worktree 里，从头跑等于把那些工作重做一遍，还把上下文清零。
   */
  async continueSession(
    sessionId: string,
    instructions: string,
    opts?: { runId?: string },
  ): Promise<{ sessionId: string }> {
    const data = this.sessionData.get(sessionId) ?? loadSession(sessionId);
    if (!data) {
      throw new Error(`Session "${sessionId}" not found — cannot continue`);
    }
    if (!data.agentSessionId) {
      throw new Error(
        `Session "${sessionId}" has no agent-side session id — cannot continue the same conversation`,
      );
    }

    const newSessionId = `claude-agent-${data.sliceId}-${Date.now()}-continue`;

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
      // ADR-130：续跑仍属同一轮 —— 调用方显式给了 runId 就用它，
      // 否则从会话文件读回（数据里没有就再读一次文件，见 resume() 的说明）。
      runId: opts?.runId ?? data.runId ?? loadSession(sessionId)?.runId ?? null,
    });
  }

  // ─── Output ────────────────────────────────────────────────────────────────

  /**
   * Get the agent's output text for a session.
   *
   * Prefers the in-memory record (complete) and falls back to the persisted
   * file (survives a restart).
   *
   * Claude Code 的 json 输出模式下，stdout 整个是一个 JSON 对象，回答在
   * `result` 字段 —— 问答回路依赖这段文本，所以优先取它。
   * 解析不出 JSON（CLI 报错、非 Claude Code 命令）时**退回原始 stdout 文本**，
   * 不吞输出（ADR-035 §3.2）。
   */
  getOutput(sessionId: string): string {
    const raw = this.getRawOutput(sessionId);
    // 回答与成本是两个独立需求，各走各的提取器 —— 免得「拿到了成本、丢了答案」。
    const result = extractClaudeResult(raw);
    if (result !== null) return result;
    return raw;
  }

  /** The agent-side conversation id (the Claude Code session uuid). */
  getAgentSessionId(sessionId: string): string | null {
    const data = this.sessionData.get(sessionId) ?? loadSession(sessionId);
    return data?.agentSessionId ?? null;
  }

  /**
   * 本次会话花了多少钱（ADR-035）。
   *
   * 只在 Claude Code 的 json 输出里报得出 —— 拿不到就返回 null，
   * 意思是「没测到」，而不是「零」。把两者混同会让预算闸门变成一道假闸门。
   */
  getUsage(sessionId: string): AdapterUsage | null {
    const json = extractClaudeJson(this.getRawOutput(sessionId));
    if (!json) return null;
    return parseClaudeUsage(json);
  }

  /**
   * ZD-007 阶段2：运行中的累计用量。
   *
   * 只在 `streamJson` 模式下有值（json 模式中途拿不到）。金额由
   * 累计 token × 单价折算；没有单价 → 返回 null（「测不到」），不猜。
   *
   * 没有 `streamJson` 或还没收到任何 assistant 消息 → null，
   * 语义是「测不到」而非「零」。
   */
  getLiveUsage(sessionId: string): AdapterUsage | null {
    if (!this.streamJson) return null;
    const tokens = this.sessionLiveTokens.get(sessionId);
    if (!tokens) return null;

    // 有最终 result（自带 total_cost_usd）时优先用它 —— 比估算准。
    const finalResult = this.lastStreamResult.get(sessionId);
    if (finalResult) {
      const exact = parseClaudeUsage(finalResult);
      if (exact) return exact;
    }

    const price = this.pricePerKToken;
    if (!price) return null;
    const costUsd =
      (tokens.input / 1000) * price.input + (tokens.output / 1000) * price.output;
    if (!Number.isFinite(costUsd) || costUsd < 0) return null;

    const usage: AdapterUsage = { costUsd };
    if (tokens.input > 0) usage.inputTokens = tokens.input;
    if (tokens.output > 0) usage.outputTokens = tokens.output;
    if (tokens.model) usage.model = tokens.model;
    return usage;
  }

  /**
   * ZD-007 阶段2：消费 stream-json 的一段 stdout（NDJSON，逐行 JSON 事件）。
   *
   * 跨 chunk 拼行：一段 chunk 可能把一行 JSON 切成两半，缓冲区里留住
   * 不完整的尾巴，下次拼上再解析。逐行 parse 成功的：
   * - `assistant` 消息 → 累加 `message.usage` 的 input/output token；
   * - `result` 消息 → 存下来（自带 `total_cost_usd`），供 `getLiveUsage`
   *   在有最终金额时优先用精确值。
   *
   * 解析失败的行直接跳过（可能是空行、日志前缀、非 JSON）—— 不抛错，
   * 也不因此中断 agent。
   */
  private consumeNdjson(sessionId: string, chunk: string): void {
    let buffer = (this.ndjsonBuffers.get(sessionId) ?? '') + chunk;
    let newlineIdx = buffer.indexOf('\n');
    while (newlineIdx >= 0) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (line.length > 0) this.consumeNdjsonLine(sessionId, line);
      newlineIdx = buffer.indexOf('\n');
    }
    this.ndjsonBuffers.set(sessionId, buffer);
  }

  /** 解析 NDJSON 的一行：assistant → 累加 token；result → 记最终金额。 */
  private consumeNdjsonLine(sessionId: string, line: string): void {
    let msg: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        msg = parsed as Record<string, unknown>;
      }
    } catch {
      return; // 非 JSON 行（日志 / 空行）—— 跳过
    }
    if (!msg) return;

    const type = typeof msg.type === 'string' ? msg.type : '';

    if (type === 'result') {
      // 记录最终 result（含 total_cost_usd），供 getLiveUsage 用精确金额。
      if ('total_cost_usd' in msg) this.lastStreamResult.set(sessionId, msg);
      return; // result 的 usage 是最终值，不参与累加
    }

    if (type !== 'assistant') return;

    // 形状：{ type:'assistant', message: { usage: { input_tokens, output_tokens } }, ... }
    const inner = isRecord(msg.message) ? msg.message : null;
    const usage = inner && isRecord(inner.usage) ? inner.usage : isRecord(msg.usage) ? msg.usage : null;
    if (!usage) return;

    const inputTokens = firstNumber(usage.input_tokens, usage.inputTokens) ?? 0;
    const outputTokens = firstNumber(usage.output_tokens, usage.outputTokens) ?? 0;
    if (inputTokens === 0 && outputTokens === 0) return;

    const prev = this.sessionLiveTokens.get(sessionId) ?? { input: 0, output: 0 };
    const model = prev.model ?? (typeof msg.model === 'string' ? msg.model : undefined);
    this.sessionLiveTokens.set(sessionId, {
      input: prev.input + inputTokens,
      output: prev.output + outputTokens,
      ...(model ? { model } : {}),
    });
  }

  /** 会话的原始 stdout 文本（内存优先，回落到持久化文件） */
  private getRawOutput(sessionId: string): string {
    const data = this.sessionData.get(sessionId) ?? loadSession(sessionId);
    if (!data) return '';
    return data.output.join('');
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
    // Kill the whole tree — the shell wrapper alone would leave the agent
    // running as an orphan (ADR-055). 包装 pid 与 agent 本人 pid 都要杀。
    this.killSessionTree(sessionId, session.child.pid);
  }

  // ─── Events ────────────────────────────────────────────────────────────────

  async events(_sessionId: string): Promise<AsyncIterable<EventEnvelope>> {
    throw new Error('events streaming not supported by ClaudeAgentAdapter');
  }

  // ─── Wait For Exit ─────────────────────────────────────────────────────────

  /**
   * Get exit code promise for a session.
   * Supports retry: if exit code != 0 and retries remain, auto-restarts.
   *
   * **超时不走这里的内部重试**（ADR-055 决策 C，实测缺陷 D-25）。
   *
   * 原来的做法：非零退出 → 适配器内部 `startWithRetry` → 用**原始 bundle**
   * + **新的 agentSessionId** 重启。那是从头再来 —— agent 的上下文被清零，
   * 它已经摸清的东西（改到一半的代码、跑了一半的测试、读过的一堆源码）
   * 全部作废，正是 ADR-055 明确要避免的事。
   *
   * 而且它把 CLI 层的续跑逻辑**短路**了：适配器内部已经把重试链走完
   * （实测跑到 `-retry-2`），`core-slice.ts` 里的 `continueSession`
   * （真正的 ADR-055 续跑）根本没机会执行。
   *
   * **怎么认出「这是超时」**：不能用退出码 —— Windows 上 `taskkill` 杀掉
   * 进程树后，shell 包装返回的是**非零码**（1），不是 null。实测：
   * 超时的 exitCode 是 1，与「agent 自己报错退出」在退出码上**完全一样**。
   *
   * 唯一可靠的信号是适配器**自己**记的 `status === 'timeout'` ——
   * `handleTimeout` 在杀进程树之前就写好了（ADR-055 决策 B）。
   *
   * 超时交回 CLI 层之后，那里的 `resumeForRetry` 会用
   * `--resume <agentSessionId>` 续同一个会话。非零退出码（agent 逻辑崩了）
   * 仍然走内部重试 —— 那重来一遍是合理的。
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

        const data = loadSession(sessionId);

        // 超时 → 不在这里重试。交给 CLI 层走 ADR-055 的续跑路径
        // （`continueSession`）—— 见上面那段说明。
        if (data?.status === 'timeout') {
          resolve(code);
          return;
        }

        // Check if we should retry
        if (code !== null && code !== 0 && session.retryCount < this.maxRetries) {
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
  static async checkAgentAvailable(
    agentCommand: string,
    configuredCommand?: string,
  ): Promise<string | null> {
    const cmd = agentCommand.split(' ')[0]; // Get the base command
    const lookup = process.platform === 'win32' ? 'where' : 'which';

    try {
      execSync(`${lookup} ${cmd}`, { stdio: 'ignore', timeout: 5000 });
      return null;
    } catch {
      // Not on PATH — check whether the shell can resolve it anyway.
      if (this.isShellResolvable(cmd)) return null;
      return describeMissingAgent(agentCommand, configuredCommand);
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

/**
 * 描述「agent 命令找不到」这件事，并且**指向正确的那条命令**。
 *
 * 缺陷 D-27（第二轮演练）：`zelto run <id> --agent claude-code` 拼错时，
 * 错误信息只说「没找到」，还让人去改 `.zelto/config.yaml agent.command` ——
 * 而**配置里的命令是对的**（`npx @anthropic-ai/claude-code`），
 * 是命令行这一次的临时覆盖拼错了。
 *
 * 人看到「改 config.yaml」会去改一个**本来没问题**的文件，
 * 改完还是错 —— **错误信息把人引向错误的方向**。
 *
 * 所以这里要说清三件事：
 *   1. 哪个命令找不到
 *   2. **当前配置里的命令是什么**（那才是可用的那条）
 *   3. 这次错在哪 —— 命令行覆盖 vs 配置本身
 *
 * 纯函数（无 IO），便于单测。
 */
export function describeMissingAgent(
  agentCommand: string,
  configuredCommand?: string,
): string {
  const base = `Agent command "${agentCommand}" not found.`;

  // 没有配置里的命令可比（或两者相同）→ 只能让人去装 / 去改配置
  if (!configuredCommand || configuredCommand === agentCommand) {
    return `${base} Install it or update .zelto/config.yaml agent.command.`;
  }

  // 配置里的命令与这次用的不同 → 是命令行这次的覆盖拼错了
  return (
    `${base}\n` +
    `  当前配置里的命令是：${configuredCommand}` +
    `\n  这次用的是命令行传的 --agent（与配置不同）。` +
    `\n  改掉 --agent 的拼写，或去掉 --agent 用配置里的命令。`
  );
}
