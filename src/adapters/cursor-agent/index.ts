// CursorAgentAdapter — ExecutorAdapter implementation for Cursor CLI (cursor-agent)
//
// 与 ClaudeAgentAdapter 的分工：
//
//   ClaudeAgentAdapter  →  `claude` CLI，stdout 是一个 JSON 对象（--output-format json）
//   CursorAgentAdapter  →  `cursor-agent` CLI，stdout 是 **NDJSON 事件流**
//                          （--output-format stream-json）
//
// 为什么 Cursor 侧要单独一个适配器而不是「换个命令就行」：
//
//   1. **协议不同**：Cursor 逐行吐 NDJSON（assistant / tool_call / result …），
//      而 Claude Code 一次性吐一个 JSON。逐写判定的「进展」信号因此来源不同
//      （Cursor 的 tool_call 事件就是进展）；
//   2. **续跑标识不同**：Claude Code 由 zelto 生成 `--session-id`；
//      Cursor 的会话 id 是 agent 自己发的（`system/init` 里的 `session_id`），
//      续跑用 `--resume <session_id>` —— zelto 不能预先指定；
//   3. **用量口径不同**：Cursor 报 token，**不报美元**。
//
// ── 用量口径（ADR-035 的语义，重要）──────────────────────────────
//
// Cursor 的 `result` 事件带 `usage: {inputTokens, outputTokens, ...}`，
// **没有** `costUsd`。zelto 的 `AdapterUsage.costUsd` 是**必填**字段。
//
// 这里**返回 null**（=「没测到」），而不是 0：
//
//   把「没测到」写成「零」，会让预算闸门变成一道**假闸门** ——
//   它显示「这一轮没花钱」，而实际上 Cursor 侧是按额度订阅的。
//   null 的语义是「没测到」，记账层能把它与「真的是零」区分开
//   （见 `run-support.ts` 的 `recordAdapterUsage`）。
//
// C1: 状态只在文件里（.zelto/sessions/<sessionId>.json）
// C2: 只用 Node 内置模块
// C4: 每个动作写 append-only 事件（由 CLI 层负责）

import { spawn, type ChildProcess } from 'node:child_process';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { type ExecutorAdapter, type AdapterMeta, type AdapterUsage } from '../../core/ports/executor.js';
import type { EventEnvelope } from '../../core/events/index.js';
import { killProcessTreeGracefully } from '../process-tree.js';
import {
  loadSession,
  saveSession,
  type PersistentSessionData,
} from '../session-store.js';
import { readProcessTable, findDescendants, findPidsByCmdline } from '../../core/sched/process-table.js';

/** 睡一会儿（毫秒）—— 只用于「等 agent 进程起来」这种轮询。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Cursor 事件流协议 ─────────────────────────────────────────────────────

/**
 * Cursor `--output-format stream-json` 的一行事件。
 *
 * 形状来自 cursor-agent 2026.09.18 的实测（事件类型清单）：
 *
 *   {type:"system",  subtype:"init",     session_id, model, cwd, apiKeySource}
 *   {type:"user",    message:{role:"user", content:[{type:"text",text}]}}
 *   {type:"assistant", message:{role:"assistant", content:[{type:"text",text}]}}
 *   {type:"tool_call", subtype:"started"|"completed", call_id, tool_call}
 *   {type:"thinking", subtype:"delta"|"completed", text}
 *   {type:"result",  subtype:"success", is_error, result, usage?, session_id}
 *
 * 字段全部是「可能缺」的 —— 判定只读它读得到的，不假设它一定在。
 */
export interface CursorStreamEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  cwd?: string;
  apiKeySource?: string;
  message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
  text?: string;
  call_id?: string;
  tool_call?: unknown;
  result?: string;
  is_error?: boolean;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

/** 从一行 NDJSON 里解出事件对象；解不出（噪声行）返回 null。 */
export function parseCursorEvent(line: string): CursorStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as CursorStreamEvent;
  } catch {
    return null;
  }
}

/**
 * 从一条 assistant 事件里取文本。
 *
 * `assistant` 事件的文本在 `message.content[].text` 里；
 * `--stream-partial-output` 打开时每个 delta 都是一条独立事件。
 */
export function extractCursorText(event: CursorStreamEvent): string {
  const content = event.message?.content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content) {
    if (part && typeof part.text === 'string') text += part.text;
  }
  return text;
}

/**
 * 从一条 `result` 事件里取用量。
 *
 * **没有美元** —— Cursor 只报 token。所以返回的 `AdapterUsage` 里
 * `costUsd` 是 0 且由调用方决定怎么用；本适配器的 `getUsage()`
 * 直接返回 null（见文件头的说明）。
 */
export function extractCursorTokens(
  event: CursorStreamEvent,
): { inputTokens?: number; outputTokens?: number } | null {
  const usage = event.usage;
  if (!usage || typeof usage !== 'object') return null;
  const out: { inputTokens?: number; outputTokens?: number } = {};
  if (typeof usage.inputTokens === 'number' && Number.isFinite(usage.inputTokens)) {
    out.inputTokens = usage.inputTokens;
  }
  if (typeof usage.outputTokens === 'number' && Number.isFinite(usage.outputTokens)) {
    out.outputTokens = usage.outputTokens;
  }
  if (out.inputTokens === undefined && out.outputTokens === undefined) return null;
  return out;
}

// ─── 选项 ──────────────────────────────────────────────────────────────────

/**
 * 透传给 Cursor CLI 的网关参数（ADR-090）。
 *
 * 三种凭证方式都在这一个形状里表达，**适配器不关心用户用的是哪一种**：
 *
 * | 用户方式 | 传入 |
 * |---|---|
 * | 本地 `cursor-agent login` | 什么都不传（默认） |
 * | API key | `apiKey`（通常来自环境变量） |
 * | 自建/企业网关 | `endpoint`（必要时再加 `apiKey`） |
 */
export interface CursorGatewayOptions {
  /** 自定义 API 端点 → `--endpoint <url>` */
  endpoint?: string;
  /** API key → `--api-key <key>`。**不要在日志里打印它。** */
  apiKey?: string;
}

export interface CursorAgentAdapterOptions {
  /** agent 命令（默认 `cursor-agent`） */
  agentCommand?: string;
  /** 工作目录（通常是切片的 worktree） */
  cwd?: string;
  /** 环境变量 */
  env?: NodeJS.ProcessEnv;
  /** 空转超时（毫秒）—— 没有进展就这么久就杀掉 */
  timeoutMs?: number;
  /** 失败重试次数 */
  maxRetries?: number;
  /** 模型覆盖（`--model`） */
  model?: string;
  /** 网关 / 凭证透传（ADR-090） */
  gateway?: CursorGatewayOptions;
  /** 实时输出回调 */
  onOutput?: (sessionId: string, text: string) => void;
  /** 进展回调 */
  onProgress?: (sessionId: string, elapsedMs: number, status: string) => void;
}

const ADAPTER_META: AdapterMeta = {
  version: '1.0.0',
  description:
    'Cursor CLI adapter — spawns cursor-agent with --output-format stream-json, NDJSON event parsing, session persistence, idle timeout, process-tree teardown',
  capabilities: {
    resume: true,
    events: false,
    modelSelection: true,
    // ADR-140：Cursor CLI 的续跑是真续（同一进程、同一会话）。
    sessionContinuation: 'load-resume',
    // ADR-133：C9 主判定点在 agent 侧的 preToolUse 钩子。
    writeGuard: 'hook',
  },
};

/** Cursor 默认的命令名（PATH 上通常是 `cursor-agent`）。 */
export const DEFAULT_CURSOR_COMMAND = 'cursor-agent';

interface SessionState {
  child: ChildProcess;
  startedAt: string;
  sliceId: string;
  retryCount: number;
  output: string[];
  exited: boolean;
  exitCode: number | null;
  /** agent 侧会话 id（`system/init` 里的 `session_id`）—— 续跑靠它 */
  agentSessionId: string | null;
  /** agent 报告的模型名 */
  model: string | null;
  /** token 用量（result 事件里的 usage） */
  usage: { inputTokens?: number; outputTokens?: number } | null;
  /** 终止状态（超时 / 被杀）—— 退出码说不了这件事 */
  terminated: 'timeout' | 'killed' | null;
}

/**
 * Cursor CLI 的旗标。
 *
 * - `-p`（--print）：非交互模式，**拥有全部工具**（含写文件与 shell）
 * - `--output-format stream-json`：逐行吐 NDJSON 事件
 * - `--stream-partial-output`：assistant 文本按 delta 逐块吐
 *   （不开的话，最后一条 assistant 事件才有完整文本）
 * - `--force`：允许执行命令（zelto 自己的策略层才是闸门）
 * - `--trust`：信任当前工作区，避免交互式询问
 *
 * **不用 `-y` / `--yolo`**：⚠️ 它**不是** `--force` 的更激进版本 ——
 * 实测 cursor-agent 2026.09.18 的 `approval-mode-setting.ts`：
 * `const t = e.force || e.yolo` —— 两者**完全等价**，都产出
 * `run-everything`。
 *
 * 所以「因为 --yolo 更危险所以不用它」是错的论证。
 * 不用它的理由只是**可读性**：`--force` 是正式名字，
 * 而 `--yolo` 这个别名容易被误读成「跳过一切检查」。
 *
 * **`run-everything` 不会绕过 zelto 的 hook**（C9 成立）：
 * 实查 `te()` —— `preToolUse` 在工具执行路径上**无条件**先跑，
 * `permission === "deny"` 直接 reject，与 approval mode 无关。
 * 关掉的只是 Cursor 自己的确认询问。
 *
 * ── 凭据透传（ADR-090）──────────────────────────────────────────
 *
 * `endpoint` → `--endpoint <url>`；`apiKey` → `--api-key <key>`。
 * 两者都**可选**：都没给时完全退回 CLI 默认（本地登录态 + 官方端点），
 * 行为与 ADR-087 落地时完全一致 —— 向后兼容。
 */
export function cursorFlags(extra: string[] = [], gateway: CursorGatewayOptions = {}): string {
  const flags: string[] = [
    '-p',
    '--output-format',
    'stream-json',
    '--stream-partial-output',
    '--force',
    '--trust',
  ];

  // 端点/密钥放在固定旗标之后 —— 与 cursor-agent --help 的「可选参数在末尾」一致。
  if (gateway.endpoint) {
    flags.push('--endpoint', shellQuote(gateway.endpoint));
  }
  if (gateway.apiKey) {
    flags.push('--api-key', shellQuote(gateway.apiKey));
  }

  flags.push(...extra);
  return flags.join(' ');
}

/**
 * 给要拼进 shell 命令行的值加引号。
 *
 * 为什么必须加：`cursorFlags()` 的产出是拼进 `spawn(cmd, { shell: true })`
 * 的**一整个字符串**，路径 / URL 里出现空格或 `&`、`|` 会被 shell 拆开
 * 甚至执行 —— 端点 URL 来自配置文件，属于不可信输入（C5 的同一思路：
 * 配置不能越权）。
 *
 * POSIX 用单引号（内部单引号走 `'\''` 拼接）；
 * Windows cmd 不认单引号，用双引号（内部双引号转义为 `""`）。
 */
function shellQuote(value: string): string {
  if (platform() === 'win32') {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class CursorAgentAdapter implements ExecutorAdapter {
  readonly name = 'cursor-agent';
  readonly metadata: AdapterMeta = ADAPTER_META;

  private readonly agentCommand: string;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly model?: string;
  /** 网关 / 凭证（ADR-090）；空对象 = 全用 CLI 默认 */
  private readonly gateway: CursorGatewayOptions;
  private readonly onOutput?: (sessionId: string, text: string) => void;
  private readonly onProgress?: (sessionId: string, elapsedMs: number, status: string) => void;
  private readonly sessions = new Map<string, SessionState>();
  private readonly sessionData = new Map<string, PersistentSessionData>();
  private readonly timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly progressIntervals = new Map<string, ReturnType<typeof setInterval>>();
  /** 尚未落盘的 stdout 缓冲（NDJSON 行可能半行到达） */
  private readonly lineBuffers = new Map<string, string>();

  constructor(options: CursorAgentAdapterOptions = {}) {
    this.agentCommand = options.agentCommand ?? DEFAULT_CURSOR_COMMAND;
    this.cwd = options.cwd ?? process.cwd();
    this.env = options.env ?? process.env;
    this.timeoutMs = options.timeoutMs ?? 900_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.model = options.model;
    this.gateway = options.gateway ?? {};
    this.onOutput = options.onOutput;
    this.onProgress = options.onProgress;
  }

  // ─── 启动 ────────────────────────────────────────────────────────────────

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
    const sessionId = `cursor-agent-${spec.sliceId}-${Date.now()}${
      retryCount > 0 ? `-retry-${retryCount}` : ''
    }`;

    const instructions = this.readInstructions(spec.prompt);
    const model = spec.model ?? this.model ?? null;

    return this.spawn({
      sessionId,
      sliceId: spec.sliceId,
      instructions,
      bundlePath: spec.prompt,
      retryCount,
      model,
      resumeAgentSessionId: null,
      resumedFromZelto: null,
      // ADR-130：本轮身份原样传下去，hook 事件据此归属轮次
      runId: spec.runId ?? null,
    });
  }

  /**
   * 读出要发给 agent 的提示词。
   *
   * bundle 是 JSON（`{instructions: "..."}`）；读不出就当它是纯文本。
   */
  private readInstructions(prompt: string): string {
    try {
      const raw = readFileSync(prompt, 'utf-8');
      const bundle = JSON.parse(raw) as { instructions?: unknown };
      if (typeof bundle.instructions === 'string') return bundle.instructions;
      return raw;
    } catch {
      return prompt;
    }
  }

  private spawn(opts: {
    sessionId: string;
    sliceId: string;
    instructions: string;
    bundlePath: string;
    retryCount: number;
    model: string | null;
    /** agent 侧会话 id（要续跑的那个）；null = 全新会话 */
    resumeAgentSessionId: string | null;
    /** 本会话续的是哪个 zelto 会话 */
    resumedFromZelto: string | null;
    cwd?: string;
    agentCommand?: string;
    /** 本轮 runId（ADR-130）；null → 不注入 `ZELTO_RUN_ID`。 */
    runId?: string | null;
  }): { sessionId: string } {
    const { sessionId, sliceId, instructions, bundlePath, retryCount } = opts;
    const workDir = opts.cwd ?? this.cwd;
    const agentCommand = opts.agentCommand ?? this.agentCommand;

    // 提示词走 **stdin** —— 不是命令行参数。
    //
    // 为什么：bundle 可能很大（几万个字符），塞进命令行会撞 Windows 的
    // 32767 字符命令行上限，而且会在进程表里留下整段提示词。
    // Cursor CLI 在 headless + 非 TTY stdin 下会读 stdin 作为提示词。
    const tmpDir = mkdtempSync(join(tmpdir(), 'zelto-cursor-prompt-'));
    const tmpFile = join(tmpDir, `${sliceId}.txt`);
    writeFileSync(tmpFile, instructions, 'utf-8');

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
      // Cursor 的会话 id 由 agent 自己发 —— 起跑时还没有。
      agentSessionId: opts.resumeAgentSessionId,
      cwd: workDir,
      resumedFrom: opts.resumedFromZelto,
      // ADR-130：本轮身份随会话落盘，续跑时读回。
      runId: opts.runId ?? null,
    };
    saveSession(sessionData);
    this.sessionData.set(sessionId, sessionData);

    const extra: string[] = [];
    if (opts.resumeAgentSessionId) {
      extra.push('--resume', opts.resumeAgentSessionId);
    }
    if (opts.model) extra.push('--model', opts.model);

    const flags = cursorFlags(extra, this.gateway);

    // Windows 上 `.cmd` 只能经 shell 起 —— `shell: true` 是必须的。
    // POSIX 上用 `detached` 建独立进程组，好让 kill(-pgid) 一次杀整棵树（ADR-055）。
    const child = spawn(`${agentCommand} ${flags}`, [], {
      cwd: workDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
      detached: platform() !== 'win32',
      env: {
        ...this.env,
        ZELTO_BUNDLE: bundlePath,
        ZELTO_SLICE_ID: sliceId,
        ZELTO_PROJECT_ROOT: workDir,
        ZELTO_SESSION_ID: sessionId,
        ZELTO_AGENT_SESSION_ID: opts.resumeAgentSessionId ?? '',
        // ADR-130：本轮 runId 进 agent 环境 —— hook 判定据此归属到这一轮
        ...(opts.runId ? { ZELTO_RUN_ID: opts.runId } : {}),
      },
    });

    const state: SessionState = {
      child,
      startedAt: sessionData.startedAt,
      sliceId,
      retryCount,
      output: [],
      exited: false,
      exitCode: null,
      agentSessionId: opts.resumeAgentSessionId,
      model: opts.model,
      usage: null,
      terminated: null,
    };
    this.sessions.set(sessionId, state);
    this.lineBuffers.set(sessionId, '');

    // ── 提示词进 stdin ──
    //
    // 写完就 end —— Cursor 读到 EOF 才开始跑。
    // 写失败（agent 立刻退了）不该炸掉 start：退出的原因由 exit 事件说。
    try {
      child.stdin?.end(tmpFile ? readFileSync(tmpFile, 'utf-8') : instructions);
    } catch {
      // 忽略 —— 退出码会说明发生了什么
    }

    const touchActivity = (): void => {
      const now = new Date().toISOString();
      sessionData.lastOutputAt = now;
      sessionData.lastActivityAt = now;
      // D-55：输出就是「有进展」—— 空转倒计时重新开始。
      this.resetIdleTimer(sessionId);
    };

    // ── stdout：NDJSON 事件流 ──
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      state.output.push(text);
      sessionData.output.push(text);
      touchActivity();
      this.consumeEvents(sessionId, text, state, sessionData);
      if (this.onOutput) this.onOutput(sessionId, text);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      state.output.push(text);
      sessionData.output.push(text);
      touchActivity();
      if (this.onOutput) this.onOutput(sessionId, text);
    });

    // 心跳落盘（跨进程判活性的唯一证据，D-30）
    sessionData.pid = child.pid ?? undefined;
    sessionData.lastActivityAt = nowIso;
    saveSession(sessionData);

    // 定位真正的 agent 进程（Windows 上 child.pid 是 cmd.exe 的 pid）。
    void this.resolveAgentPid(sessionId, child.pid);

    // 空转超时（D-55）：没有进展才杀。
    this.resetIdleTimer(sessionId);

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
          } catch {
            /* 心跳写盘失败不阻断运行 */
          }
        }
        if (this.onProgress) {
          const startedAt = Date.parse(sessionData.startedAt);
          this.onProgress(sessionId, Date.now() - startedAt, 'running');
        }
      }, 5000);
      // ADR-125：心跳不许拖住进程退出 —— 它只负责落盘活性证据。
      (heartbeat as unknown as { unref?: () => void }).unref?.();
      this.progressIntervals.set(sessionId, heartbeat);
    }

    const cleanup = (): void => {
      try {
        rmSync(tmpDir, { force: true, recursive: true });
      } catch {
        /* ignore */
      }
    };
    child.on('exit', cleanup);
    child.on('error', cleanup);

    // 退出码记在 `exit` 上，不是 `close`（D-59）：
    // `close` 要等 stdio 全部关闭，agent 起的后台进程继承了管道就永远不来。
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

  // ─── 事件流解析 ──────────────────────────────────────────────────────────

  /**
   * 消化一段 stdout（可能包含多行、也可能只有半行）。
   *
   * 事件语义：
   * - `system/init` → 记下 agent 侧会话 id（续跑靠它）
   * - `assistant`  → 文本增量（进输出缓冲）
   * - `tool_call`  → **进展信号**：agent 在动（用于空转超时）
   * - `result`     → 收尾事件：文本结果 + token 用量
   */
  private consumeEvents(
    sessionId: string,
    chunk: string,
    state: SessionState,
    sessionData: PersistentSessionData,
  ): void {
    const buffer = (this.lineBuffers.get(sessionId) ?? '') + chunk;
    const lines = buffer.split(/\r?\n/);
    // 最后一段可能是半行 —— 留着等下一批。
    this.lineBuffers.set(sessionId, lines.pop() ?? '');

    for (const line of lines) {
      const event = parseCursorEvent(line);
      if (!event) continue;

      if (event.type === 'system' && event.subtype === 'init') {
        if (typeof event.session_id === 'string' && event.session_id) {
          state.agentSessionId = event.session_id;
          sessionData.agentSessionId = event.session_id;
          try {
            saveSession(sessionData);
          } catch {
            /* 写盘失败不阻断运行 */
          }
        }
        if (typeof event.model === 'string' && event.model) {
          state.model = event.model;
        }
        continue;
      }

      if (event.type === 'tool_call') {
        // 工具调用 = agent 在动 = 有进展。
        this.resetIdleTimer(sessionId);
        continue;
      }

      if (event.type === 'result') {
        const tokens = extractCursorTokens(event);
        if (tokens) state.usage = tokens;
        if (typeof event.result === 'string' && event.result) {
          state.output.push(event.result);
          sessionData.output.push(event.result);
        }
      }
    }
  }

  // ─── 进程 pid ─────────────────────────────────────────────────────────────

  /**
   * 找出真正的 agent 进程 pid，记进会话文件。
   *
   * Windows 上 `child.pid` 是 `cmd.exe` 的 pid，真正的 `node.exe`（跑 cursor-agent
   * 的）是它的后代。外层退出后 agent 还活着 —— 按 `child.pid` 判会误判「死了」，
   * 看门狗据此重跑，于是在同一个 worktree 上起了第二个 agent（D-51 / D-30）。
   *
   * 找法：agent 命令行里有本次会话独有的 `--resume <sessionId>`，
   * 或者新会话时**没有**独有标记 —— 所以先用 `--resume` 找，找不到再取
   * 包装进程的最深后代（agent 一定是链条末端）。
   */
  private async resolveAgentPid(sessionId: string, wrapperPid: number | undefined): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;

    // 续跑时命令行里有 `--resume <sessionId>` —— 精确认它。
    if (state.agentSessionId) {
      for (let attempt = 0; attempt < 8; attempt++) {
        await sleep(1000);
        const data = this.sessionData.get(sessionId);
        if (!data || data.status !== 'running') return;

        const pids = await findPidsByCmdline(`--resume ${state.agentSessionId}`);
        if (pids.length > 0) {
          const real = pids.find((p) => p !== wrapperPid) ?? pids[0];
          data.agentPid = real;
          try {
            saveSession(data);
          } catch {
            /* 写盘失败不阻断运行 */
          }
          return;
        }
      }
    }

    // 兜底：取包装进程的最深后代。
    if (wrapperPid === undefined) return;
    const rows = await readProcessTable();
    if (rows.length === 0) return;
    const descendants = findDescendants(rows, wrapperPid);
    if (descendants.length === 0) return;

    const byPid = new Map(rows.map((r) => [r.pid, r]));
    const depthOf = (pid: number): number => {
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
    } catch {
      /* 写盘失败不阻断运行 */
    }
  }

  // ─── 超时 ────────────────────────────────────────────────────────────────

  /** 重新开始「无进展」倒计时（D-55）。 */
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
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timeouts.set(sessionId, timer);
  }

  /** 外部报告「这一轮有进展」（D-55）—— CLI 层看到切片事件流有新事件时调。 */
  markProgress(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return;
    this.resetIdleTimer(sessionId);
  }

  private handleTimeout(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.terminated = 'timeout';

    const data = this.sessionData.get(sessionId) ?? loadSession(sessionId);
    if (data && data.status === 'running') {
      data.status = 'timeout';
      data.output.push(`[zelto: no progress for ${this.timeoutMs}ms — killed]`);
      saveSession(data);
    }
    if (this.onOutput) {
      this.onOutput(sessionId, `\n[zelto: no progress for ${this.timeoutMs}ms — killed]\n`);
    }
    this.killSessionTree(sessionId, session.child.pid);
  }

  /**
   * 杀掉这次运行涉及的全部进程。
   *
   * 包装 pid 与 agent 本人 pid **都要杀**（ADR-055）：
   * 只杀包装进程的话，agent 会变孤儿继续跑 —— 继续改文件、继续烧 token，
   * 而 zelto 已经判失败并准备重试，两个 agent 抢同一批文件。
   */
  private killSessionTree(sessionId: string, wrapperPid: number | undefined): void {
    const data = this.sessionData.get(sessionId) ?? loadSession(sessionId);
    const agentPid = typeof data?.agentPid === 'number' ? data.agentPid : undefined;

    killProcessTreeGracefully(wrapperPid);
    if (agentPid && agentPid !== wrapperPid) {
      killProcessTreeGracefully(agentPid);
    }
  }

  // ─── 退出 ────────────────────────────────────────────────────────────────

  private handleExit(sessionId: string, exitCode: number | null): void {
    const timeout = this.timeouts.get(sessionId);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(sessionId);
    }
    const interval = this.progressIntervals.get(sessionId);
    if (interval) {
      clearInterval(interval);
      this.progressIntervals.delete(sessionId);
    }

    const data = this.sessionData.get(sessionId) ?? loadSession(sessionId);
    if (data) {
      data.exitCode = exitCode;
      if (data.status === 'timeout') {
        data.status = 'timeout';
      } else {
        data.status = exitCode === 0 ? 'completed' : 'failed';
      }
      // agent 侧会话 id：事件流里没拿到（agent 崩在 init 之前）就清掉 ——
      // 留着一个不存在的 id，续跑时会拿着它去 `--resume`，必然失败。
      const state = this.sessions.get(sessionId);
      if (state?.agentSessionId) data.agentSessionId = state.agentSessionId;
      saveSession(data);
    }

    const state = this.sessions.get(sessionId);
    if (state) {
      state.exited = true;
      state.exitCode = exitCode;
    }
  }

  // ─── 续跑 ────────────────────────────────────────────────────────────────

  /**
   * 问答回路：把人的回答喂回同一个 agent 会话。
   *
   * Cursor 的会话 id 是 agent 自己发的（`system/init`）——
   * 拿不到就**不能续**（不同于 Claude Code 可以预先指定 `--session-id`）。
   * 这里宁可抛错，也不静默开一个新会话：
   * 静默开新会话 = 上下文清零 = agent 已经做掉的事全作废（ADR-013 §3.4）。
   */
  async resume(
    sessionId: string,
    patch: string,
    opts?: { runId?: string },
  ): Promise<{ sessionId: string }> {
    const data = this.sessionData.get(sessionId) ?? loadSession(sessionId);
    if (!data) throw new Error(`Session "${sessionId}" not found — cannot resume`);

    const agentSessionId = this.sessions.get(sessionId)?.agentSessionId ?? data.agentSessionId;
    if (!agentSessionId) {
      throw new Error(
        `Session "${sessionId}" has no Cursor chat id — cannot continue the same conversation ` +
          `(the agent never reported one; it likely failed before initialization)`,
      );
    }

    const newSessionId = `cursor-agent-${data.sliceId}-${Date.now()}-resume`;
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
      model: this.sessions.get(sessionId)?.model ?? null,
      resumeAgentSessionId: agentSessionId,
      resumedFromZelto: sessionId,
      cwd: data.cwd || this.cwd,
      agentCommand: data.agentCommand || this.agentCommand,
      // ADR-130：续跑仍属同一轮 —— 调用方确认过就用它，否则沿用会话记录的那个。
      runId: opts?.runId ?? data.runId ?? null,
    });
  }

  /** 续同一个会话，但提示词是任意的（超时重试：「接着上次做」）。 */
  async continueSession(
    sessionId: string,
    instructions: string,
    opts?: { runId?: string },
  ): Promise<{ sessionId: string }> {
    const data = this.sessionData.get(sessionId) ?? loadSession(sessionId);
    if (!data) throw new Error(`Session "${sessionId}" not found — cannot continue`);

    const agentSessionId = this.sessions.get(sessionId)?.agentSessionId ?? data.agentSessionId;
    if (!agentSessionId) {
      throw new Error(
        `Session "${sessionId}" has no Cursor chat id — cannot continue the same conversation`,
      );
    }

    const newSessionId = `cursor-agent-${data.sliceId}-${Date.now()}-continue`;
    return this.spawn({
      sessionId: newSessionId,
      sliceId: data.sliceId,
      instructions,
      bundlePath: data.prompt,
      retryCount: data.retryCount,
      model: this.sessions.get(sessionId)?.model ?? null,
      resumeAgentSessionId: agentSessionId,
      resumedFromZelto: sessionId,
      cwd: data.cwd || this.cwd,
      agentCommand: data.agentCommand || this.agentCommand,
      // ADR-130：续跑仍属同一轮 —— 调用方显式给了 runId 就用它，
      // 否则沿用会话文件里记的那一个；都没记录才不注入（不凭空造一个）。
      runId: opts?.runId ?? data.runId ?? null,
    });
  }

  // ─── 输出 ────────────────────────────────────────────────────────────────

  /**
   * agent 的最终回答文本。
   *
   * 取 `result` 事件的 `result` 字段；取不到就退回原始 stdout。
   */
  getOutput(sessionId: string): string {
    const state = this.sessions.get(sessionId);
    const raw = state?.output.join('') ?? this.getRawOutput(sessionId);
    const result = this.extractResultText(raw);
    if (result !== null) return result;
    return raw;
  }

  /** 从 stdout 里找出 `result` 事件的文本。 */
  private extractResultText(raw: string): string | null {
    for (const line of raw.split(/\r?\n/)) {
      const event = parseCursorEvent(line);
      if (!event) continue;
      if (event.type === 'result' && typeof event.result === 'string' && event.result) {
        return event.result;
      }
    }
    return null;
  }

  /** agent 侧会话 id（Cursor 的 chat id）—— 续跑靠它。 */
  getAgentSessionId(sessionId: string): string | null {
    const state = this.sessions.get(sessionId);
    if (state?.agentSessionId) return state.agentSessionId;
    const data = this.sessionData.get(sessionId) ?? loadSession(sessionId);
    return data?.agentSessionId ?? null;
  }

  /**
   * 本次会话花了多少钱。
   *
   * **返回 null** —— Cursor 报 token，但不报美元（ADR-035 的语义）。
   *
   * 为什么不返回 0：0 的含义是「确实没花钱」，
   * 而 Cursor 侧是按额度订阅的，「返回 0」等于**谎报零成本** ——
   * 预算闸门会因此变成一道假闸门。
   * null = 「没测到」，记账层能把它与「真的是零」区分开。
   */
  getUsage(_sessionId: string): AdapterUsage | null {
    return null;
  }

  /** Cursor 侧的 token 用量（不含美元）—— 供记账层/看板参考。 */
  getTokenUsage(sessionId: string): { inputTokens?: number; outputTokens?: number } | null {
    return this.sessions.get(sessionId)?.usage ?? null;
  }

  private getRawOutput(sessionId: string): string {
    const data = this.sessionData.get(sessionId) ?? loadSession(sessionId);
    if (!data) return '';
    return data.output.join('');
  }

  // ─── 停止 ────────────────────────────────────────────────────────────────

  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" not found`);

    const timeout = this.timeouts.get(sessionId);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(sessionId);
    }
    const interval = this.progressIntervals.get(sessionId);
    if (interval) {
      clearInterval(interval);
      this.progressIntervals.delete(sessionId);
    }

    const data = this.sessionData.get(sessionId) ?? loadSession(sessionId);
    if (data && data.status === 'running') {
      data.status = 'killed';
      data.output.push('[zelto: session stopped by user]');
      saveSession(data);
    }
    session.terminated = 'killed';

    session.child.kill('SIGTERM');
    this.killSessionTree(sessionId, session.child.pid);
  }

  // ─── 事件 ────────────────────────────────────────────────────────────────

  async events(_sessionId: string): Promise<AsyncIterable<EventEnvelope>> {
    throw new Error('events streaming not supported by CursorAgentAdapter');
  }

  // ─── 等待退出 ────────────────────────────────────────────────────────────

  /**
   * 等这次运行结束，返回退出码。
   *
   * **超时不走这里的内部重试**（与 ClaudeAgentAdapter 同口径，ADR-055 决策 C）：
   * 超时交回 CLI 层走 `continueSession` 续同一个会话；非零退出码
   * （agent 逻辑崩了）仍然走内部重试 —— 那重来一遍是合理的。
   */
  waitForExit(sessionId: string): Promise<number | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return Promise.resolve(null);
    if (session.exited) return Promise.resolve(session.exitCode);

    return new Promise<number | null>((resolve) => {
      const checkExit = async (code: number | null): Promise<void> => {
        if (code === 0) {
          resolve(0);
          return;
        }

        const data = this.sessionData.get(sessionId) ?? loadSession(sessionId);

        // 超时 → 不在这里重试。交给 CLI 层走续跑路径。
        if (data?.status === 'timeout') {
          resolve(code);
          return;
        }

        if (code !== null && code !== 0 && session.retryCount < this.maxRetries) {
          if (!data || !data.prompt) {
            resolve(code);
            return;
          }
          // 续跑过的会话不自动重试 —— 人来决定下一步。
          if (data.resumedFrom) {
            resolve(code);
            return;
          }

          const newRetry = session.retryCount + 1;
          try {
            const { sessionId: newId } = await this.startWithRetry(
              { sliceId: session.sliceId, prompt: data.prompt },
              newRetry,
            );
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

  // ─── 查询 ────────────────────────────────────────────────────────────────

  getSessionStatus(sessionId: string): PersistentSessionData | null {
    return loadSession(sessionId);
  }

  isSessionAlive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    try {
      return session.child.exitCode === null && session.child.killed === false;
    } catch {
      return false;
    }
  }

  getRecentOutput(sessionId: string, maxLines = 20): string[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return session.output.join('').split('\n').slice(-maxLines);
  }
}
