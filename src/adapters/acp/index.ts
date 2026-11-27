// ACP 适配器 —— `ExecutorAdapter` 的 ACP 实现（ADR-133）
//
// 与 `CursorAgentAdapter` 的分工：
//
//   CursorAgentAdapter  →  `cursor-agent` CLI，stdout 是 **NDJSON 事件流**
//   AcpAdapter          →  任何 ACP agent 子进程，stdio 上是 **JSON-RPC**
//
// 为什么 ACP 更硬（对 C9 而言）：
//
//   Cursor/Claude/Codex 路线 —— zelto 往 agent 的目录里**装钩子**，
//   等 agent 主动来问。钩子装不上 = 闸门静默失效（ADR-083 踩过）。
//
//   ACP 路线 —— agent 通过 `session/request_permission` **主动来问**，
//   zelto 在回调里答。**不回答 = 拒绝**（协议语义自带 fail closed），
//   不依赖任何一家的配置默认值。
//
// ── 分层（ADR-083 §1 的同一条纪律）───────────────────────────────
//
//   ACP request_permission ──▶ normalizeAcpToolCall ──▶ 统一载荷
//                                                          │
//                                                          ▼
//                                           judgeWriteTargets ← 不变量
//                                                          │
//                                                          ▼
//   ACP response ◀── renderAcpPermission ◀──────────────── 统一判决
//
// **本文件不做任何判定** —— 判定在 `src/hook/acp.ts` 与 `src/hook/pretool.ts`。
// adapter 只负责把 ACP 的东西搬进搬出。
//
// ── 硬规则（ADR-133 决策四）─────────────────────────────────────
//
// 1. **永不发 `allow_always`**；
// 2. **每次判定都写一条 `policy.decision`**（C4），`harness` 记 `acp:<command>`；
// 3. **版本不匹配就拒绝**（ADR-133 已决：不降级）。
//
// C1: 状态只在文件里（.zelto/sessions/<sessionId>.json）
// C2: 本文件在 src/adapters/，允许第三方依赖；core/ 不受影响
// C3: 判定确定性 —— 判定内核不触网、不调模型

import { spawn, type ChildProcess } from 'node:child_process';
import { platform } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { client, type ClientApp, type ClientContext } from '@agentclientprotocol/sdk';

import { type ExecutorAdapter, type AdapterMeta, type AdapterUsage } from '../../core/ports/executor.js';
import type { EventEnvelope } from '../../core/events/index.js';
import {
  judgeAcpPermission,
  renderAcpPermission,
  type AcpPermissionOption,
  type AcpToolCall,
} from '../../hook/acp.js';
import {
  appendDecisionEvent,
  buildContext,
  type PreToolContext,
} from '../../hook/pretool.js';
import { killProcessTreeGracefully } from '../process-tree.js';
import { loadSession, saveSession, type PersistentSessionData } from '../session-store.js';
import { PROTOCOL_VERSION, createAcpStream, isSupportedProtocolVersion, protocolVersionError } from './protocol.js';
import { extractAcpCost, extractAcpText, isProgressUpdate } from './events.js';

/** ACP 适配器选项。 */
export interface AcpAdapterOptions {
  /** agent 命令（默认 `cursor-agent acp`） */
  agentCommand?: string;
  /** 工作目录（通常是切片的 worktree） */
  cwd?: string;
  /** 环境变量 */
  env?: NodeJS.ProcessEnv;
  /** 空转超时（毫秒）—— 没有进展就这么久就杀掉 */
  timeoutMs?: number;
  /** 失败重试次数 */
  maxRetries?: number;
  /** 主仓库根 —— policy / 预约 / 事件流都在这里 */
  projectRoot?: string;
  /** 切片 id —— permission 回调判定时用 */
  sliceId?: string | null;
  /** 本轮 runId（ADR-130）—— 判定事件据此归属轮次 */
  runId?: string | null;
  /** 实时输出回调 */
  onOutput?: (sessionId: string, text: string) => void;
  /** 进展回调 */
  onProgress?: (sessionId: string, elapsedMs: number, status: string) => void;
}

/** ACP 默认的命令名。 */
export const DEFAULT_ACP_COMMAND = 'cursor-agent acp';

const ADAPTER_META: AdapterMeta = {
  version: '1.0.0',
  description:
    'ACP adapter — spawns an ACP agent over stdio JSON-RPC, session lifecycle, permission callback as C9 write guard, idle timeout, process-tree teardown',
  capabilities: {
    resume: true,
    events: false,
    modelSelection: false,
    // ADR-133：C9 的主判定点是 ACP 的 permission 回调，**不是** hook。
    writeGuard: 'permission',
  },
};

/** 一次 ACP 运行的状态。 */
interface AcpSessionState {
  child: ChildProcess;
  /** ACP 侧会话 id（`session/new` 返回的）—— 续跑靠它 */
  acpSessionId: string | null;
  startedAt: string;
  sliceId: string;
  output: string[];
  exited: boolean;
  exitCode: number | null;
  /** 终止状态（超时 / 被杀）—— 退出码说不了这件事 */
  terminated: 'timeout' | 'killed' | null;
  /** 本轮 runId（ADR-130） */
  runId: string | null;
  /** 判定上下文（构造一次，判定时复用） */
  ctx: PreToolContext;
  /** agent 报出来的累计花费（美元）；没报就是 null */
  costUsd: number | null;
}

export class AcpAdapter implements ExecutorAdapter {
  readonly name = 'acp';
  readonly metadata: AdapterMeta = ADAPTER_META;

  private readonly agentCommand: string;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly projectRoot: string;
  private readonly sliceId: string | null;
  private readonly onOutput?: (sessionId: string, text: string) => void;
  private readonly onProgress?: (sessionId: string, elapsedMs: number, status: string) => void;

  private readonly sessions = new Map<string, AcpSessionState>();
  private readonly sessionData = new Map<string, PersistentSessionData>();
  private readonly timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly progressIntervals = new Map<string, ReturnType<typeof setInterval>>();

  constructor(options: AcpAdapterOptions = {}) {
    this.agentCommand = options.agentCommand ?? DEFAULT_ACP_COMMAND;
    this.cwd = options.cwd ?? process.cwd();
    this.env = options.env ?? process.env;
    this.timeoutMs = options.timeoutMs ?? 900_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.projectRoot = options.projectRoot ?? process.cwd();
    this.sliceId = options.sliceId ?? null;
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
    const sessionId = `acp-${spec.sliceId}-${Date.now()}`;
    const instructions = this.readInstructions(spec.prompt);
    return this.spawn({
      sessionId,
      sliceId: spec.sliceId,
      instructions,
      bundlePath: spec.prompt,
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
    runId: string | null;
  }): { sessionId: string } {
    const { sessionId, sliceId, instructions, bundlePath } = opts;
    const workDir = this.cwd;

    const nowIso = new Date().toISOString();
    const sessionData: PersistentSessionData = {
      sessionId,
      sliceId,
      agentCommand: this.agentCommand,
      startedAt: nowIso,
      status: 'running',
      exitCode: null,
      timeoutMs: this.timeoutMs,
      retryCount: 0,
      maxRetries: this.maxRetries,
      prompt: bundlePath,
      output: [],
      lastActivityAt: nowIso,
      agentSessionId: null,
      cwd: workDir,
      resumedFrom: null,
      runId: opts.runId,
    };
    saveSession(sessionData);
    this.sessionData.set(sessionId, sessionData);

    // 判定上下文 —— permission 回调每次都用它。
    //
    // **构造一次**（不每次回调重建）：写集预约与策略在这一轮里不变，
    // 而 `buildContext` 会去读盘。构造一次 = 判据在整轮里**稳定**，
    // 也避免每个 permission 请求都读一遍 policy。
    const ctx = this.buildJudgeContext(sliceId);

    const child = spawn(this.agentCommand, [], {
      cwd: workDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
      detached: platform() !== 'win32',
      env: {
        ...this.env,
        ZELTO_BUNDLE: bundlePath,
        ZELTO_SLICE_ID: sliceId,
        ZELTO_PROJECT_ROOT: this.projectRoot,
        ZELTO_SESSION_ID: sessionId,
        ...(opts.runId ? { ZELTO_RUN_ID: opts.runId } : {}),
      },
    });

    const state: AcpSessionState = {
      child,
      acpSessionId: null,
      startedAt: nowIso,
      sliceId,
      output: [],
      exited: false,
      exitCode: null,
      terminated: null,
      runId: opts.runId,
      ctx,
      costUsd: null,
    };
    this.sessions.set(sessionId, state);

    // stderr：ACP 的 stdout 是协议流，stderr 是日志 —— 收进输出缓冲。
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      state.output.push(text);
      sessionData.output.push(text);
      this.touchActivity(sessionId);
    });

    void this.connect(sessionId, state, sessionData, instructions);

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
      (heartbeat as unknown as { unref?: () => void }).unref?.();
      this.progressIntervals.set(sessionId, heartbeat);
    }

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

  /**
   * 构造判定上下文。
   *
   * 复用 `src/hook/pretool.ts` 的 `buildContext` —— 判定输入的来源
   * 与 hook 路线**完全同源**（同一个写集预约、同一份 policy、同一套保护域）。
   */
  private buildJudgeContext(sliceId: string): PreToolContext {
    return buildContext({
      projectRoot: this.projectRoot,
      worktreeRoot: this.cwd,
      sliceId,
      harness: 'claude-code',
      runId: null,
    });
  }

  /**
   * 建立 ACP 连接并跑完这一轮。
   *
   * 流程：`initialize` → 版本校验 → `session/new` → `session/prompt`。
   */
  private async connect(
    sessionId: string,
    state: AcpSessionState,
    sessionData: PersistentSessionData,
    instructions: string,
  ): Promise<void> {
    const child = state.child;
    if (!child.stdin || !child.stdout) {
      this.failSession(sessionId, 'ACP agent 子进程没有可用的 stdio');
      return;
    }

    let app: ClientApp;
    try {
      app = client({ name: 'zelto' });
    } catch (err) {
      this.failSession(sessionId, `创建 ACP client 失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // ── permission 回调：C9 的主判定点 ────────────────────────────
    //
    // agent 要动工具就来问；我们按写集预约答。
    // **判定不在这里** —— 归一化与判决都在 `src/hook/acp.ts`。
    app.onRequest('session/request_permission', (ctx) => {
      const params = ctx.params;
      const toolCall: AcpToolCall = {
        kind: params.toolCall.kind ?? undefined,
        name: params.toolCall.name ?? undefined,
        rawInput: params.toolCall.rawInput,
        locations: params.toolCall.locations ?? undefined,
      };
      const options: AcpPermissionOption[] = params.options.map((o) => ({
        optionId: o.optionId,
        name: o.name,
        kind: o.kind,
      }));

      const verdict = judgeAcpPermission(toolCall, state.ctx);
      const outcome = renderAcpPermission(verdict, options);

      // C4：每次判定都留证据。`harness` 记真实来源（`acp:<command>`），
      // 不硬编码成某一家（ADR-083 §6 的「写假账」同形状）。
      const eventSlice = state.ctx.sliceId ?? '_acp';
      appendDecisionEvent(
        this.projectRoot,
        eventSlice,
        {
          decision: verdict.decision,
          ruleId: verdict.ruleId,
          basis: verdict.basis,
          reason: verdict.reason,
          path: verdict.path,
          targets: verdict.targets,
          tool: toolCall.name ?? toolCall.kind ?? 'unknown',
          policyVersion: state.ctx.policyVersion,
          harness: `acp:${this.agentCommand}`,
          sliceId: state.ctx.sliceId,
        },
        state.runId,
      );

      return { outcome: outcome.outcome };
    });

    // ── session/update：输出文本 + 进展信号 ───────────────────────
    app.onNotification('session/update', (ctx) => {
      const update = ctx.params.update;
      const text = extractAcpText(update);
      if (text) {
        state.output.push(text);
        sessionData.output.push(text);
        if (this.onOutput) this.onOutput(sessionId, text);
      }
      // 进展信号：任何 tool_call / tool_call_update 都算「agent 在动」。
      // 这比 hook 路线直接 —— hook 路线要靠 hook 进程写事件来喂。
      if (isProgressUpdate(update)) {
        this.touchActivity(sessionId);
      }
      // 用量：agent 报了才有，没报就是「没测到」（不谎报 0）。
      const cost = extractAcpCost(update);
      if (cost !== null) {
        state.costUsd = cost;
        sessionData.costUsd = cost;
      }
    });

    const stream = createAcpStream(child.stdin, child.stdout);
    const connection = app.connect(stream);

    try {
      const init = await connection.agent.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'zelto', version: ADAPTER_META.version },
      });

      // ── 版本校验（ADR-133 已决：拒绝，不降级）──────────────────
      //
      // 必须在建会话**之前**做 —— 一个说不同版本方言的 agent，它的
      // `session/request_permission` 语义未必与我们的理解一致，
      // 而我们要靠这个语义拦越界写入。
      if (!isSupportedProtocolVersion(init?.protocolVersion)) {
        const message = protocolVersionError(init?.protocolVersion);
        this.failSession(sessionId, message);
        return;
      }

      const session = await connection.agent.buildSession(this.cwd).start();
      state.acpSessionId = session.sessionId;
      sessionData.agentSessionId = session.sessionId;
      try {
        saveSession(sessionData);
      } catch {
        /* 写盘失败不阻断运行 */
      }

      await session.prompt(instructions);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.failSession(sessionId, `ACP 会话失败：${message}`);
    } finally {
      connection.close();
      // 关掉子进程的 stdin —— agent 靠 stdin 结束知道自己该退出了。
      //
      // 不关的话 agent 会一直挂着等下一条消息，zelto 这边只能靠
      // 空转超时把它杀掉 —— 那会把「正常跑完」误判成「超时失败」，
      // 还会留下一具尸体进程（ADR-055 的老问题）。
      try {
        child.stdin?.end();
      } catch {
        /* 已经关了 */
      }
    }
  }

  // ─── 事件流解析 ──────────────────────────────────────────────────────────

  private touchActivity(sessionId: string): void {
    const data = this.sessionData.get(sessionId);
    if (data) {
      data.lastOutputAt = new Date().toISOString();
      data.lastActivityAt = data.lastOutputAt;
    }
    this.resetIdleTimer(sessionId);
  }

  // ─── 超时 ────────────────────────────────────────────────────────────────

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

  private killSessionTree(sessionId: string, wrapperPid: number | undefined): void {
    const data = this.sessionData.get(sessionId) ?? loadSession(sessionId);
    const agentPid = typeof data?.agentPid === 'number' ? data.agentPid : undefined;
    killProcessTreeGracefully(wrapperPid);
    if (agentPid && agentPid !== wrapperPid) {
      killProcessTreeGracefully(agentPid);
    }
  }

  // ─── 失败与退出 ──────────────────────────────────────────────────────────

  private failSession(sessionId: string, reason: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.output.push(`[zelto: ${reason}]`);
      if (this.onOutput) this.onOutput(sessionId, `[zelto: ${reason}]`);
    }
    const data = this.sessionData.get(sessionId) ?? loadSession(sessionId);
    if (data && data.status === 'running') {
      data.status = 'failed';
      data.output.push(`[zelto: ${reason}]`);
      saveSession(data);
    }
  }

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
      } else if (data.status === 'running') {
        data.status = exitCode === 0 ? 'completed' : 'failed';
      }
      const state = this.sessions.get(sessionId);
      if (state?.acpSessionId) data.agentSessionId = state.acpSessionId;
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
   * 问答回路：把人的回答喂回同一个 ACP 会话。
   *
   * ACP 的会话 id 由 agent 发的（`session/new` 返回）——
   * 拿不到就**不能**续（不同于 Claude Code 可以预先指定 `--session-id`）。
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

    const acpSessionId = this.sessions.get(sessionId)?.acpSessionId ?? data.agentSessionId;
    if (!acpSessionId) {
      throw new Error(
        `Session "${sessionId}" has no ACP session id — cannot continue the same conversation ` +
          `(the agent never reported one; it likely failed before session/new)`,
      );
    }

    const newSessionId = `acp-${data.sliceId}-${Date.now()}-resume`;
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

    const acpSessionId = this.sessions.get(sessionId)?.acpSessionId ?? data.agentSessionId;
    if (!acpSessionId) {
      throw new Error(
        `Session "${sessionId}" has no ACP session id — cannot continue the same conversation`,
      );
    }

    const newSessionId = `acp-${data.sliceId}-${Date.now()}-continue`;
    return this.spawn({
      sessionId: newSessionId,
      sliceId: data.sliceId,
      instructions,
      bundlePath: data.prompt,
      runId: opts?.runId ?? data.runId ?? null,
    });
  }

  // ─── 输出 ────────────────────────────────────────────────────────────────

  getOutput(sessionId: string): string {
    const state = this.sessions.get(sessionId);
    if (state) return state.output.join('');
    const data = this.sessionData.get(sessionId) ?? loadSession(sessionId);
    return data?.output.join('') ?? '';
  }

  /** agent 侧会话 id —— 续跑靠它。 */
  getAgentSessionId(sessionId: string): string | null {
    const state = this.sessions.get(sessionId);
    if (state?.acpSessionId) return state.acpSessionId;
    const data = this.sessionData.get(sessionId) ?? loadSession(sessionId);
    return data?.agentSessionId ?? null;
  }

  /**
   * 本次会话花了多少钱。
   *
   * **没测到就返回 null**（ADR-035 口径）。
   *
   * ACP v1 的 `usage_update` 里 `cost` 是**可选**的 ——
   * agent 报了我们才有，没报就是「没测到」。
   * 谎报 0 会让预算闸门变成一道**假闸门**（0 的含义是「确实没花钱」，
   * 而这里是「agent 没报」）。
   */
  getUsage(sessionId: string): AdapterUsage | null {
    const state = this.sessions.get(sessionId);
    const cost = state?.costUsd ?? this.sessionData.get(sessionId)?.costUsd ?? null;
    if (cost === null) return null;
    return { costUsd: cost };
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
    throw new Error('events streaming not supported by AcpAdapter');
  }

  // ─── 等待退出 ────────────────────────────────────────────────────────────

  waitForExit(sessionId: string): Promise<number | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return Promise.resolve(null);
    if (session.exited) return Promise.resolve(session.exitCode);

    return new Promise<number | null>((resolve) => {
      session.child.on('close', (code) => resolve(code));
      session.child.on('error', () => resolve(1));
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
