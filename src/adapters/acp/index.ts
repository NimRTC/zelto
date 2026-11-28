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
  type PreToolVerdict,
} from '../../hook/pretool.js';
import { killProcessTreeGracefully } from '../process-tree.js';
import { loadSession, saveSession, type PersistentSessionData } from '../session-store.js';
import {
  PROTOCOL_VERSION,
  createAcpStream,
  isSupportedProtocolVersion,
  parseAcpSessionContinuation,
  protocolVersionError,
  type AcpSessionContinuation,
} from './protocol.js';
import { detectAuthRequired, extractAuthMethods, type AcpAuthMethod } from './auth.js';
import {
  buildFallbackContinueInstructions,
  buildFallbackResumeInstructions,
  decideSessionMode,
  describeSessionMode,
  type AcpSessionMode,
} from './continuation.js';
import { extractAcpCost, extractAcpText, isProgressUpdate } from './events.js';
// ADR-143：启动阶段（只从真实信号来，绝不用计时器）
import {
  DEFAULT_STARTUP_TIMEOUT_MS,
  clearPhaseOnFirstOutput,
  shouldExemptIdleTimeout,
  type AcpStartupPhase,
} from './startup-phase.js';
import {
  PendingPermissionRegistry,
  TERMINATED_BASIS,
  renderSettlementOutcome,
  type TerminationReason,
} from './permission.js';
import { addGrant, hasGrant, loadGrants, type AlwaysGrant } from './always-grants.js';
import { promptAlwaysAllow } from './always-prompt.js';
import { judgeAlwaysGrant } from '../../hook/acp-always.js';

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
  /**
   * 启动阶段的**上界**（毫秒）—— ADR-143。
   *
   * 启动阶段**豁免**空转超时（决策四），代价是「启动卡住」不再被
   * 空转超时杀。这个上界就是那道兜底。
   *
   * **它不决定阶段是什么** —— 阶段只由协议信号推进
   * （T3 的「never a timer」）；它只是给「启动总共多久」一个上界。
   */
  startupTimeoutMs?: number;
  /** 失败重试次数 */
  maxRetries?: number;
  /** 主仓库根 —— policy / 预约 / 事件流都在这里 */
  projectRoot?: string;
  /** 切片 id —— permission 回调判定时用 */
  sliceId?: string | null;
  /** 本轮 runId（ADR-130）—— 判定事件据此归属轮次 */
  runId?: string | null;
  /**
   * 「以后都允许」的白名单（ADR-133 补充）。
   *
   * **缺省为空 = 关闭** —— 默认行为与之前完全一致（永不放开）。
   * 用户要放开就明确列出那些路径/目录/glob。
   */
  alwaysAllowPaths?: string[];
  /**
   * 「以后都允许」的提问方式（ADR-133 补充）—— 缺省用 `promptAlwaysAllow`。
   *
   * **为什么要能替换**：这个提问会**阻塞**在 readline 上等人回答。
   * 而「阻塞中的 permission 回调」正是 ADR-141 要结算的那种状态 ——
   * 没有这个口子，那条路径就**测不了**（默认实现非 TTY 时立刻返回）。
   *
   * 也给未来别的界面（网页驾驶舱）留了接法。
   */
  promptAlwaysAllow?: (path: string) => Promise<'once' | 'always' | 'reject'>;
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
    // ADR-140：ACP 的续跑能力上限 —— 真续（session/resume | session/load）。
    // 实际用哪条取决于那个 agent 在 initialize 回包里声明了什么。
    sessionContinuation: 'load-resume',
    // ADR-133：C9 的主判定点是 ACP 的 permission 回调，**不是** hook。
    writeGuard: 'permission',
  },
};

/** 一次 ACP 运行的状态。 */
interface AcpSessionState {
  /** 会话 id（zelto 侧的 session key）—— 计时器重算要用 */
  sessionId: string;
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
  /**
   * 续跑时**实际用哪条**通道（ADR-140 决策五）—— 事件负载里的 `sessionMode`。
   *
   * `'resume'` —— 发了 `session/resume`（真续，上下文在）
   * `'load'`   —— 发了 `session/load`（真续，历史回放）
   * `'new'`    —— 退回 `session/new`（**上下文丢了**）
   */
  sessionMode: AcpSessionMode;
  /**
   * 「会话已建立、通道已知」的信号（ADR-140）。
   *
   * 续跑方（`resume()` / `continueSession()`）要**等**这个信号才能知道
   * 走的是哪条通道 —— 因为「真续 vs 新会话」这件事必须在**人看到之前**
   * 说出来（决策二），也必须进 `run.resumed` 的负载（决策五）。
   *
   * **一定会兑现**：`connect()` 的每一条退出路径都 resolve 它
   * （失败时按 `'new'` 兑现）—— 续跑方不会永远挂着。
   */
  sessionModeReady: Promise<AcpSessionMode>;
  /** 兑现 `sessionModeReady` 的函数（只兑现一次）。 */
  resolveSessionMode: (mode: AcpSessionMode) => void;
  /**
   * 挂起的 `session/request_permission` 请求（ADR-141）。
   *
   * **为什么按会话记**：终止是**会话**级的事实（这个会话的 agent 死了），
   * 不是进程号的事实。
   */
  pendingPermissions: PendingPermissionRegistry;
  /**
   * 启动阶段（ADR-143）—— 只从真实信号来，绝不用计时器。
   *
   * `null` = 不在启动阶段（agent 已经能干别的了）。
   *
   * **为什么需要它**：ACP agent 的启动阶段**不发 `tool_call`** ——
   * 初始化模型连接、加载 MCP server、鉴权、读项目上下文，这些都不是
   * 工具调用，是 agent **进程内部**的事。没有这个字段，
   * **正常启动但比较慢**的 agent 会被空转超时**误杀**（白跑一轮）。
   */
  startupPhase: AcpStartupPhase | null;
  /**
   * 是否已经收到过 `session/update` 通知（ADR-143 决策三）。
   *
   * 收到第一条 → 阶段清空（「provider 能干别的了」）。
   */
  sawFirstUpdate: boolean;
  /**
   * 启动阶段的**上界计时器**（ADR-143 决策四的代价）。
   *
   * 启动阶段**豁免**空转超时 —— 代价是「agent 卡在启动」不再被
   * 空转超时杀。这个计时器就是那个**上界**：启动阶段总共不超过这么久。
   *
   * 撤掉函数 —— 阶段结束时（收到第一条 `session/update`）调用。
   */
  startupDeadlineClear: (() => void) | null;
  /**
   * 这一轮**失败**的原因（ADR-143 落地补充）。
   *
   * ## 为什么需要它
   *
   * 失败是 zelto 这一侧判定的（请求超时、鉴权失败、协议版本不符……），
   * 而**子进程可能自己正常退出**（退出码 0）。
   *
   * 那时若只看退出码 → 「这一轮失败了」会被读成「这一轮成功了」。
   * 后果是实打实的：CLI 走进「成功」分支，门禁照跑，签字照走 ——
   * 而实际上 agent 一行代码都没写。
   *
   * **所以退出码要由「退出码 + 失败记录」一起判**，不能只看退出码。
   */
  failure: string | null;
}

export class AcpAdapter implements ExecutorAdapter {
  readonly name = 'acp';
  readonly metadata: AdapterMeta = ADAPTER_META;

  private readonly agentCommand: string;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  /**
   * 启动阶段的上界（毫秒）—— ADR-143 决策四的兜底。
   *
   * **为什么与 `timeoutMs` 分开**：两者管的是**不同的东西** ——
   * - `startupTimeoutMs`：「它**根本没起步**」（启动阶段）；
   * - `timeoutMs`：「它在跑，但**没有进展**」（工作阶段）。
   *
   * 混成一个 → 事后审计分不清「agent 干到一半卡住」与「agent 连话都没说上」。
   */
  private readonly startupTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly projectRoot: string;
  private readonly sliceId: string | null;
  private readonly alwaysAllowPaths: string[];
  private readonly promptAlwaysAllow: (path: string) => Promise<'once' | 'always' | 'reject'>;
  private readonly onOutput?: (sessionId: string, text: string) => void;
  private readonly onProgress?: (sessionId: string, elapsedMs: number, status: string) => void;

  private readonly sessions = new Map<string, AcpSessionState>();
  private readonly sessionData = new Map<string, PersistentSessionData>();
  private readonly timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * 启动阶段的上界计时器（ADR-143）—— 按会话记。
   *
   * **为什么与 `timeouts`（空转超时）分开记**：两者是**不同**的停机，
   * 触发时写出的状态与提示也不同 —— 混在一张表里就没法分清
   * 「启动卡住」与「跑着没进展」。
   */
  private readonly startupTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly progressIntervals = new Map<string, ReturnType<typeof setInterval>>();

  constructor(options: AcpAdapterOptions = {}) {
    this.agentCommand = options.agentCommand ?? DEFAULT_ACP_COMMAND;
    this.cwd = options.cwd ?? process.cwd();
    this.env = options.env ?? process.env;
    this.timeoutMs = options.timeoutMs ?? 900_000;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? 2;
    this.projectRoot = options.projectRoot ?? process.cwd();
    this.sliceId = options.sliceId ?? null;
    this.alwaysAllowPaths = options.alwaysAllowPaths ?? [];
    this.promptAlwaysAllow =
      options.promptAlwaysAllow ??
      ((path: string) => promptAlwaysAllow(path));
    this.onOutput = options.onOutput;
    this.onProgress = options.onProgress;
  }

  // ─── 启动 ────────────────────────────────────────────────────────────────

  /**
   * 「以后都允许」的授权流程（ADR-133 补充）。
   *
   * 三步：
   *
   *   1. **查已有的授权记忆** —— 有就直接放行，不再问人；
   *   2. **问人能不能放开** —— 判定在 `src/hook/acp-always.ts`：
   *      路径必须在**当前切片的写集内** + **用户配置的白名单内**
   *      （白名单缺省为空 = 关闭）；
   *   3. **人选了「以后都允许」就记账** —— 记在 **zelto 这边**
   *      （`.zelto/locks/always-<sliceId>.json`），
   *      **不是** agent 的 `.cursor/permissions.json`。
   *
   * **对 agent 始终回 `allow_once`** —— 见 `always-grants.ts` 的文件头：
   * agent 收到 `allow_always` 会自己持久化，之后不再问 zelto，
   * 逐写判定就被绕过了。
   */
  private async handleAlwaysGrant(
    toolCall: AcpToolCall,
    state: AcpSessionState,
    options: AcpPermissionOption[],
    verdict: PreToolVerdict,
  ): Promise<{ verdict: PreToolVerdict; basis: string; reason: string }> {
    // 1. 查已有的授权记忆。
    //
    // 只在**本次判定放行**的路径上查 —— 授权记忆记的是确切路径。
    const sliceId = state.ctx.sliceId;
    if (!sliceId) {
      return { verdict, basis: verdict.basis, reason: verdict.reason };
    }

    const grants: AlwaysGrant[] = loadGrants(this.projectRoot, sliceId);
    const targets = verdict.targets;
    if (targets.length === 1 && hasGrant(grants, targets[0])) {
      return {
        verdict: {
          ...verdict,
          basis: 'acp:always-granted',
          reason: `路径 "${targets[0]}" 已被授权「以后都允许」（本次切片内）。`,
        },
        basis: 'acp:always-granted',
        reason: `路径 "${targets[0]}" 已被授权「以后都允许」（本次切片内）。`,
      };
    }

    // 2. 问人能不能放开。
    //
    // 判定在 hook 层：写集内 + 白名单内才允许问。
    // 白名单缺省为空 → `eligible: false` → 直接返回，**不打扰人**。
    const decision = judgeAlwaysGrant(targets, state.ctx, this.alwaysAllowPaths);
    if (!decision.eligible) {
      return { verdict, basis: verdict.basis, reason: verdict.reason };
    }

    // 3. 问人。
    //
    // 非 TTY → `promptAlwaysAllow` 直接返回 'once'（不放开），
    // 见 `always-prompt.ts` 的文件头。
    const choice = await this.promptAlwaysAllow(decision.path);

    if (choice === 'always') {
      addGrant(this.projectRoot, sliceId, {
        path: decision.path,
        source: `acp:${this.agentCommand}`,
      });
      const reason = `路径 "${decision.path}" 已授权「以后都允许」（本次切片内）。`;
      return {
        verdict: { ...verdict, basis: 'acp:always-granted', reason },
        basis: 'acp:always-granted',
        reason,
      };
    }

    if (choice === 'reject') {
      return {
        verdict: {
          ...verdict,
          decision: 'deny',
          basis: 'acp:always-rejected',
          ruleId: 'acp:always-rejected',
          reason: `人拒绝了对路径 "${decision.path}" 的写入。`,
        },
        basis: 'acp:always-rejected',
        reason: `人拒绝了对路径 "${decision.path}" 的写入。`,
      };
    }

    // 'once' —— 与之前完全一致。
    return { verdict, basis: verdict.basis, reason: verdict.reason };
  }

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
    /**
     * 要续的 ACP 会话 id（ADR-140）—— 非 null 时走 `session/resume` /
     * `session/load`（真续），null 时走 `session/new`。
     */
    resumeAcpSessionId?: string | null;
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
      // ADR-143：会话一落盘就是「启动中（进程已起）」——
      // 跨进程看（`zelto status` / 驾驶舱）时立刻知道它在启动，
      // 而不是只看到一个「running 但不知道在干什么」的会话。
      startupPhase: 'launch',
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

    let resolveSessionMode: (mode: AcpSessionMode) => void = () => {};
    const sessionModeReady = new Promise<AcpSessionMode>((resolve) => {
      resolveSessionMode = resolve;
    });

    const state: AcpSessionState = {
      sessionId,
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
      sessionMode: 'new',
      sessionModeReady,
      resolveSessionMode,
      pendingPermissions: new PendingPermissionRegistry(),
      // ADR-143：spawn 之后、`initialize` 发出之前 = 'launch'。
      // 这是**协议事实**（子进程已起、还没握手），不是计时器推出来的。
      startupPhase: 'launch',
      sawFirstUpdate: false,
      startupDeadlineClear: null,
      failure: null,
    };
    this.sessions.set(sessionId, state);

    // stderr：ACP 的 stdout 是协议流，stderr 是日志 —— 收进输出缓冲。
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      state.output.push(text);
      sessionData.output.push(text);
      this.touchActivity(sessionId);
    });

    void this.connect(sessionId, state, sessionData, instructions, opts.resumeAcpSessionId ?? null);

    // ADR-143：启动阶段的**上界**（决策四的兜底）——
    // 启动阶段豁免了空转超时，所以「它根本没起步」这条路径由它兜。
    this.armStartupDeadline(state);

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
   * 流程：`initialize` → 版本校验 → 建会话 → `session/prompt`。
   *
   * **建会话**这一步按 agent 声明的能力分三条路（ADR-140）：
   *
   * ```
   * 有 resumeAcpSessionId？
   *   agent 声明 sessionCapabilities.resume → session/resume（真续，首选）
   *   agent 声明 agentCapabilities.loadSession → session/load（真续，次选）
   *   都不支持 → session/new（退回）+ 明确告知人「上下文丢了」
   * 没有 resumeAcpSessionId（首轮）→ session/new
   * ```
   *
   * **为什么 `session/resume` 优先于 `session/load`**：`session/load` 会把
   * 整个对话历史回放给 client，而 zelto 的提问检测是纯字符串解析 ——
   * 回放出来的旧问题标记会被再解析一次 → 无限挂起。
   */
  /**
   * 发一个**带超时**的协议请求（ADR-143 决策五）。
   *
   * ## 为什么需要它
   *
   * 启动阶段豁免了空转超时（决策四）—— 代价是：
   * 「agent 卡在 `initialize` 不回包 → 空转计时器不管它 → **永远不杀**」。
   *
   * ## 只用于**握手请求**（决策五的「请求级超时」）
   *
   * `initialize` / `session/new` / `session/load` / `session/resume`
   * —— 它们的语义是「建立连接」，**必须很快回来**。
   *
   * **`session/prompt` 不用它** —— 因为在 ACP 里 `session/prompt` 是
   * **整轮**的时长（agent 干完活才回 `stopReason`），给它套一个
   * `timeoutMs` 会把**长轮次**（有进展但做得久）也杀掉 ——
   * 那与 ADR-055 的空转超时语义冲突。
   *
   * `session/prompt` 的兜底是**启动阶段的上界**（见 `startupTimeoutMs`）：
   * 启动阶段一结束（收到第一条 `session/update`）就换成空转超时接管。
   *
   * ## 为什么这不是重复
   *
   * 两者管的是**不同的东西**：
   * - 请求级超时：管「**这一把握手请求**有没有回来」；
   * - 空转超时：管「**这一轮工作**有没有在推进」。
   *
   * @param request 发请求的函数
   * @param label 请求名（超时信息里要说清是哪一把）
   */
  private async requestWithTimeout<T>(
    request: () => Promise<T>,
    label: string,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        request(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`ACP 请求超时（${label}）：${this.timeoutMs}ms 没有回包`));
          }, this.timeoutMs);
          (timer as unknown as { unref?: () => void }).unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 启动阶段的**上界计时器**（ADR-143 决策四的代价）。
   *
   * ## 为什么需要它
   *
   * 启动阶段**豁免**空转超时 —— 代价是：
   * 「握手完了但 agent 一个字都不说」→ 空转计时器不管它 → **永远不杀**。
   *
   * 这个计时器就是那个**上界**。它**不决定阶段是什么** —— 阶段只由
   * 协议信号推进（T3 的「never a timer」）；它只是给「启动阶段总共
   * 多久」一个上界。
   *
   * ## 与空转超时的交接点
   *
   * 收到**第一条** `session/update` → 阶段清空 → **撤掉**这个计时器
   * （`state.startupDeadlineClear`）—— 之后由空转超时接管。
   *
   * **为什么不让两个计时器同时活着**：那会出现「同一时刻两个都能触发」
   * → 「谁先写状态」变成竞态（状态可能是 timeout 也可能是 failed），
   * 判定不确定（C3 要求确定性判定）。
   */
  private armStartupDeadline(state: AcpSessionState): void {
    const sessionId = state.sessionId;
    const clear = (): void => {
      const existing = this.startupTimeouts.get(sessionId);
      if (existing) {
        clearTimeout(existing);
        this.startupTimeouts.delete(sessionId);
      }
      state.startupDeadlineClear = null;
    };

    state.startupDeadlineClear = clear;

    const timer = setTimeout(() => {
      this.handleStartupTimeout(sessionId);
    }, this.startupTimeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.startupTimeouts.set(sessionId, timer);
  }

  /**
   * 启动阶段超时 —— 启动卡住（不是「跑着没进展」）。
   *
   * **为什么单独一个出口**：两种停机是**不同的事** ——
   * - 空转超时：「它在跑，但**没有进展**」（工作阶段）；
   * - 启动超时：「它**根本没起步**」（启动阶段）。
   *
   * 混成同一个事件 → 事后审计分不清「agent 干到一半卡住」与
   * 「agent 连话都没说上」。人看到的提示也不同。
   */
  private handleStartupTimeout(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    // 已经在工作阶段了 → 不归这条管（空转超时才是那儿的判据）。
    if (session.startupPhase === null) return;

    session.terminated = 'timeout';

    // ADR-141：先结算挂起的 permission 请求，再杀进程。
    this.settlePendingPermissions(sessionId, 'timeout');

    const data = this.sessionData.get(sessionId) ?? loadSession(sessionId);
    if (data && data.status === 'running') {
      data.status = 'timeout';
      data.output.push(
        `[zelto: startup timeout — no output within ${this.startupTimeoutMs}ms — killed]`,
      );
      saveSession(data);
    }
    if (this.onOutput) {
      this.onOutput(
        sessionId,
        `\n[zelto: startup timeout — no output within ${this.startupTimeoutMs}ms — killed]\n`,
      );
    }
    this.killSessionTree(sessionId, session.child.pid);
  }

  private async connect(
    sessionId: string,
    state: AcpSessionState,
    sessionData: PersistentSessionData,
    instructions: string,
    resumeAcpSessionId: string | null,
  ): Promise<void> {
    const child = state.child;
    if (!child.stdin || !child.stdout) {
      this.failSession(sessionId, 'ACP agent 子进程没有可用的 stdio');
      state.resolveSessionMode(state.sessionMode);
      return;
    }

    let app: ClientApp;
    try {
      app = client({ name: 'zelto' });
    } catch (err) {
      this.failSession(sessionId, `创建 ACP client 失败：${err instanceof Error ? err.message : String(err)}`);
      state.resolveSessionMode(state.sessionMode);
      return;
    }

    // ── permission 回调：C9 的主判定点 ────────────────────────────
    //
    // agent 要动工具就来问；我们按写集预约答。
    // **判定不在这里** —— 归一化与判决都在 `src/hook/acp.ts`。
    //
    // 「以后都允许」也在这里处理（ADR-133 补充），但**判定**同样在 hook 层
    // （`src/hook/acp-always.ts`），这里只做「问人」与「记账」。
    //
    // **关键**：对 agent **永远回 `allow_once`** —— 绝不回 `allow_always`。
    // 因为 agent 收到 `allow_always` 会写进自己的 `.cursor/permissions.json`，
    // 之后同类操作**不再问 zelto** → 逐写判定被绕过、且跨切片存活。
    // 「以后都允许」的记忆记在 **zelto 这边**（`always-grants.ts`）。
    app.onRequest('session/request_permission', async (ctx) => {
      const params = ctx.params;
      const toolCall: AcpToolCall = {
        kind: params.toolCall.kind ?? undefined,
        name: params.toolCall.name ?? undefined,
        rawInput: params.toolCall.rawInput,
        locations: params.toolCall.locations ?? undefined,
        // 实测（2026-11-27）：cursor-agent 把**写入路径放在 title 里**
        // （形如 `` Edit `src/foo.ts` ``），`rawInput` 整个字段都没有。
        // 不带过来 → zelto 判不出写目标 → 把每一次写都拒掉。
        title: params.toolCall.title ?? undefined,
        // 同上 —— `content: [{ type: "diff", path, oldText, newText }]`
        // 里也有结构化的路径，比 title 可靠。
        content: params.toolCall.content ?? undefined,
      };
      const options: AcpPermissionOption[] = params.options.map((o) => ({
        optionId: o.optionId,
        name: o.name,
        kind: o.kind,
      }));

      // ── 登记挂起（ADR-141）────────────────────────────────────────
      //
      // **在判定之前**登记 —— 因为判定里可能要**问人**
      // （「以后都允许吗」，`handleAlwaysGrant` 会等 readline）。
      // 那段时间里进程可能被杀 → 这条请求就悬着了。
      //
      // 登记在判定之前，才覆盖得到「判定进行中被终止」那条路径。
      const requestId = String(ctx.requestId);
      state.pendingPermissions.add({
        requestId,
        options,
        tool: toolCall.name ?? toolCall.kind ?? 'unknown',
        path: null, // 判定出来之前不猜写目标
      });

      let verdict = judgeAcpPermission(toolCall, state.ctx);
      let basis = verdict.basis;
      let reason = verdict.reason;

      // ── 「以后都允许」的授权流程 ──────────────────────────────────
      //
      // 只在「本次判定要放行」时才问 —— 都要拒了还问「以后都允许吗」
      // 是荒谬的。
      if (verdict.decision === 'allow') {
        const outcome = await this.handleAlwaysGrant(toolCall, state, options, verdict);
        verdict = outcome.verdict;
        basis = outcome.basis;
        reason = outcome.reason;
      }

      // ── 判定进行中被终止（ADR-141 验收 6）────────────────────────
      //
      // 上面那段「问人」可能等了很久 —— 期间进程被超时杀掉 / 被人 stop /
      // agent 自己退了。
      //
      // **抢归属权**（见 `permission.ts` 的「谁写事件」）：
      // - 抢到了 → 终止路径**没有**结算过这条请求 → 由我写事件；
      // - 抢不到 → 终止路径**已经**结算并写过事件 → 这里不重复写。
      //
      // **已终止 → 不写答复**（连接已断，写了也没用），但**仍然写事件** ——
      // 「这次写入没被处理」这个**事实**必须留痕（C4）。
      //
      // 为什么事件照写：事后审计看到「没有 decision、也没有文件变化」
      // 会推断「没发生过」—— 而它**发生过**（agent 确实要写）。
      //
      // **注意顺序**：先 `judgeAcpPermission` 判定，再抢归属权 ——
      // 判定期间请求**仍留在登记册里**，终止路径才结算得到它。
      const ownsEvent = state.pendingPermissions.resolve(requestId, 'judge');
      if (!ownsEvent) {
        // 终止路径已经结算过这条请求了 —— 事件它写过了，这里不重复写。
        // 回**它**结算时选的答复（保持一致：结算选了 reject_once，
        // 这里就不能回 cancelled —— 同一个请求两种答复会让 agent 困惑）。
        const settled = state.pendingPermissions.getSettled(requestId);
        return settled ?? { outcome: { outcome: 'cancelled' } };
      }

      if (state.terminated !== null) {
        this.appendTerminatedDecision(state, {
          tool: toolCall.name ?? toolCall.kind ?? 'unknown',
          path: verdict.path,
          reason: state.terminated === 'timeout' ? 'timeout' : 'killed',
        });
        // 判定完成 → 这条请求不再挂起（归属权留着，重复来的请求不会写第二条）。
        state.pendingPermissions.take(requestId);
        return { outcome: { outcome: 'cancelled' } };
      }

      const rendered = renderAcpPermission(verdict, options);

      // C4：每次判定都留证据。`harness` 记真实来源（`acp:<command>`），
      // 不硬编码成某一家（ADR-083 §6 的「写假账」同形状）。
      const eventSlice = state.ctx.sliceId ?? '_acp';
      appendDecisionEvent(
        this.projectRoot,
        eventSlice,
        {
          decision: verdict.decision,
          ruleId: verdict.ruleId,
          basis,
          reason,
          path: verdict.path,
          targets: verdict.targets,
          tool: toolCall.name ?? toolCall.kind ?? 'unknown',
          policyVersion: state.ctx.policyVersion,
          harness: `acp:${this.agentCommand}`,
          sliceId: state.ctx.sliceId,
        },
        state.runId,
      );

      // 判定完成 → 这条请求不再挂起。
      state.pendingPermissions.take(requestId);

      return { outcome: rendered.outcome };
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

      // ADR-143 决策三：**收到第一条 `session/update` → 启动阶段结束**。
      //
      // T3 的规则：「Clear it the moment the provider can be doing something else.」
      //
      // 为什么不是「第一个 tool_call」：太晚了。
      // `session/update` 里先来的是 `agent_message_chunk`（agent 开始说话了）
      // —— 那已经说明 agent **活着且在动**。
      //
      // 为什么不是「prompt 返回」：更晚。agent 可能先说一段话、
      // 再调工具、最后才结束这一轮。
      if (!state.sawFirstUpdate) {
        state.sawFirstUpdate = true;
        this.setStartupPhase(state, clearPhaseOnFirstOutput(state.startupPhase, true));
        // ADR-143 决策五：**交接点** —— 阶段结束，「启动上界」就**让位**
        // 给空转超时（那个按 `tool_call` 记进展，语义更准）。
        //
        // 不让位的话两个计时器会**同时**活着 → 同一时刻可能两个都触发
        // → 「谁先写状态」变成竞态（状态可能是 timeout 也可能是 failed）。
        state.startupDeadlineClear?.();
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

    // 声明在 try 之外 —— catch 里要用它把「要登录」翻译成人话。
    let authMethods: AcpAuthMethod[] = [];

    try {
      // ADR-143：发出 `initialize` 之前推进到 'initialize' ——
      // 这是一个**语义唯一的被等待的请求**（T3 的规则）。
      this.setStartupPhase(state, 'initialize');

      const init = await this.requestWithTimeout(
        () =>
          connection.agent.request('initialize', {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
            clientInfo: { name: 'zelto', version: ADAPTER_META.version },
          }),
        'initialize',
      );

      // ── 版本校验（ADR-133 已决：拒绝，不降级）──────────────────
      //
      // 必须在建会话**之前**做 —— 一个说不同版本方言的 agent，它的
      // `session/request_permission` 语义未必与我们的理解一致，
      // 而我们要靠这个语义拦越界写入。
      if (!isSupportedProtocolVersion(init?.protocolVersion)) {
        const message = protocolVersionError(init?.protocolVersion);
        this.failSession(sessionId, message);
        state.resolveSessionMode(state.sessionMode);
        return;
      }

      // ── 鉴权方式（ADR-133 落地补充）───────────────────────────
      //
      // 记下来，不是为了自动登录 —— 是为了**建会话失败时**能给出人话。
      //
      // 实测（2026-11-27，`cursor-agent acp`）：agent 的 `initialize`
      // 回包里带 `authMethods`，没登录时 `session/new` 会返回
      // 「Authentication required」。不记它，错误就只剩半句。
      authMethods = extractAuthMethods(init);

      // ── 建会话（ADR-140）─────────────────────────────────────────
      //
      // 三条路，按 agent 声明的能力选（`resume` 优先于 `load`）：
      //
      //   session/resume —— 真续，**不回放历史**（省 token，且不会让
      //                     提问检测把历史里的旧标记再解析一次）
      //   session/load   —— 真续，但**回放整个历史**（次选）
      //   session/new    —— 退回路径：**上下文丢了**，明确告知人
      //
      // 规范硬约束（`SessionStatus`）：换了一条连接之后，
      // **MUST still call `session/load` or `session/resume`** before
      // sending `session/prompt` —— 不发那两个就发 prompt = 违反规范。
      const capability = parseAcpSessionContinuation(init);
      const mode = decideSessionMode(capability, resumeAcpSessionId);
      state.sessionMode = mode;

      // ADR-143：准备建会话 → 推进到 'session'（`session/new`|`load`|`resume`
      // 是**语义唯一的被等待的请求**）。
      this.setStartupPhase(state, 'session');

      if (mode === 'resume') {
        await this.requestWithTimeout(
          () =>
            connection.agent.request('session/resume', {
              sessionId: resumeAcpSessionId as string,
              cwd: this.cwd,
              // `mcpServers` 是**可选**的 —— 不传 = 「沿用会话原有的」。
              // zelto 从不给 agent 配 MCP server（ADR-133 决策四），不传更一致。
            }),
          'session/resume',
        );
        state.acpSessionId = resumeAcpSessionId;
        sessionData.agentSessionId = resumeAcpSessionId;
      } else if (mode === 'load') {
        await this.requestWithTimeout(
          () =>
            connection.agent.request('session/load', {
              sessionId: resumeAcpSessionId as string,
              cwd: this.cwd,
              // `mcpServers` 是**必填**字段 —— 不传 = 违反 schema = agent 可能拒绝。
              // zelto 不配 MCP server，所以传空数组。
              mcpServers: [],
            }),
          'session/load',
        );
        state.acpSessionId = resumeAcpSessionId;
        sessionData.agentSessionId = resumeAcpSessionId;
      } else {
        // 退回路径：开新会话。
        //
        // **明确告知人**（ADR-140 决策二）—— 静默退回 = 人以为 agent
        // 记得刚才讨论过什么，实际它什么都不记得。
        if (resumeAcpSessionId) {
          const notice = describeSessionMode('new');
          state.output.push(`[zelto: ${notice}]`);
          sessionData.output.push(`[zelto: ${notice}]`);
          if (this.onOutput) this.onOutput(sessionId, `\n[zelto: ${notice}]\n`);
        }
        const session = await this.requestWithTimeout(
          () => connection.agent.buildSession(this.cwd).start(),
          'session/new',
        );
        state.acpSessionId = session.sessionId;
        sessionData.agentSessionId = session.sessionId;
      }

      // 通道已知 —— 兑现信号（续跑方在等它，ADR-140）。
      state.resolveSessionMode(mode);

      try {
        saveSession(sessionData);
      } catch {
        /* 写盘失败不阻断运行 */
      }

      // `session/prompt` 直接走原始 JSON-RPC（不走 SDK 的 `ActiveSession`）——
      // 因为真续路径下**没有** `session/new` 的回包，
      // SDK 的 `ActiveSession` 是围着 `session/new` 回包建的。
      //
      // 提示词的形状与 SDK 的 `ActiveSession.prompt()` 一致：
      // 字符串 → 一个 text content block。
      //
      // ADR-143：阶段**不在这里**清空 —— 清空的时机是「拿到第一个
      // `session/update` 通知」（决策三）。prompt 返回只说明 agent 收到了
      // 指令，不代表它已经**开始干活**（它可能还要加载 MCP server、
      // 读项目上下文 —— 这段时间它一条 tool_call 都不发）。
      //
      // **为什么不用请求级超时套住它**：ACP 里 `session/prompt` 是
      // **整轮**的时长（agent 干完活才回 `stopReason`）——
      // 套请求级超时会杀掉长轮次（有进展但做得久）。
      // 启动阶段的兜底是**启动上界**（`armStartupDeadline`），
      // 工作阶段的兜底是**空转超时**。
      await connection.agent.request('session/prompt', {
        sessionId: state.acpSessionId as string,
        prompt: [{ type: 'text', text: instructions }],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 鉴权失败**换成人话**（有登录方式就给出来）。
      //
      // 认不出是鉴权问题 → 照原样报错（不猜）。
      const authHint = detectAuthRequired(message, authMethods);
      // ADR-143：鉴权是**独立于版本协商的第二道关卡**（ADR-133 修正二）——
      // 识别出来就把阶段标成 'authenticating'，让人知道「卡在登录」，
      // 而不是「卡在别的地方」。
      //
      // **阶段是协议事实** —— 这里不是「猜它在鉴权」，
      // 是「agent 明确说它要鉴权」。
      if (authHint) {
        this.setStartupPhase(state, 'authenticating');
      }
      this.failSession(sessionId, authHint ?? `ACP 会话失败：${message}`);
    } finally {
      // 建会话失败时也要兑现信号 —— 否则续跑方会永远挂着。
      // （失败时按当前的 `sessionMode` 兑现：要么 `'new'`，要么真续的模式。）
      state.resolveSessionMode(state.sessionMode);
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

  // ─── 启动阶段（ADR-143）────────────────────────────────────────────────────

  /**
   * 设置启动阶段（ADR-143 决策二）。
   *
   * **阶段只能在这里被推进** —— 而且每个调用点都是「刚发出一个
   * 语义唯一的协议请求」或「刚拿到它的回包」。
   *
   * **绝不用计时器**（T3 明文：「never a timer」）：
   * 一旦允许计时器，「启动阶段」就退化成「启动后 X 毫秒内都算启动阶段」
   * —— 那等于给超时加了一个宽限期，而宽限期是**拍脑袋的魔法数字**。
   *
   * @param phase 新阶段；null = 阶段结束（provider 能干别的了）
   */
  private setStartupPhase(state: AcpSessionState, phase: AcpStartupPhase | null): void {
    if (state.startupPhase === phase) return;
    state.startupPhase = phase;
    // 落盘 —— 阶段要**跨进程**可见（`zelto status` / 驾驶舱 / 事后审计）。
    //
    // 写盘失败不阻断运行（状态是「给人看的」，不是判定的依据）。
    this.persistStartupPhase(state, phase);
    // 阶段变了 → 空转计时器要重算（豁免状态可能变了）。
    //
    // **为什么**：豁免是「当前这刻」的事实 —— 阶段结束后豁免就没了，
    // 那时若无进展就应当按空转超时杀。计时器不重算的话，
    // 「启动阶段」期间设的计时器会**带着旧的豁免语义**跑完。
    this.rearmIdleTimer(state);
  }

  /** 把阶段写进会话文件（失败不阻断）。 */
  private persistStartupPhase(state: AcpSessionState, phase: AcpStartupPhase | null): void {
    try {
      const data = this.sessionData.get(state.sessionId);
      if (!data) return;
      data.startupPhase = phase;
      saveSession(data);
    } catch {
      /* 写盘失败不阻断运行 */
    }
  }

  /**
   * 当前处于哪个启动阶段（ADR-143 决策六）。
   *
   * 不在启动阶段 → `null`。
   */
  getStartupPhase(sessionId: string): string | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    return state.startupPhase;
  }

  // ─── 超时 ────────────────────────────────────────────────────────────────

  private resetIdleTimer(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) {
      const existing = this.timeouts.get(sessionId);
      if (existing) clearTimeout(existing);
      this.timeouts.delete(sessionId);
      return;
    }
    this.rearmIdleTimer(state);
  }

  /**
   * 重算空转计时器（ADR-143 决策四）。
   *
   * **空转超时在启动阶段被完全豁免** —— 不是「延长」，是「不计入」。
   *
   * 语义：「**不在启动阶段**且**没有进展**这么久 → 杀掉」。
   *
   * **为什么豁免不会导致永不超时**：启动阶段**一定会结束** ——
   * 阶段是由协议请求推进的，而那些请求都有回包，且每个请求自带超时
   * （决策五）。agent 卡在 `initialize` 不回包 → 那是「协议卡住」，
   * 由请求级超时兜。
   *
   * **为什么在启动阶段里不设计时器**（而不是设一个更长的）：
   * 设更长的需要一个「启动阶段该给多久」的魔法数字 ——
   * 那在不同 agent / 网络 / 模型上根本没有共同答案。
   */
  private rearmIdleTimer(state: AcpSessionState): void {
    const sessionId = state.sessionId;
    const existing = this.timeouts.get(sessionId);
    if (existing) clearTimeout(existing);
    this.timeouts.delete(sessionId);
    if (!this.sessions.has(sessionId)) return;

    // 启动阶段 → **不设**空转计时器（豁免）。
    if (shouldExemptIdleTimeout(state.startupPhase)) return;

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

    // ADR-141：**先结算挂起的 permission 请求**，再杀进程。
    //
    // 为什么先结算：杀进程之后连接就断了 —— 那时再「结算」就没有连接可写了。
    // 结算本身就是**主动回一个明确的拒绝**（让 agent 知道被拒了，可以改道），
    // 而不是「等连接断了自己猜」。
    this.settlePendingPermissions(sessionId, 'timeout');

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

  // ─── 终止时的挂起请求结算（ADR-141）─────────────────────────────────────

  /**
   * 结算这个会话里**所有**挂起的 `session/request_permission` 请求。
   *
   * **三条终止路径的共同出口** —— 进程退出 / 空转超时 / 人工停止。
   * 结算必须是**所有**路径的出口 —— 三条路径各漏一条，
   * 就会出现「换个终止方式就绕过结算」的形状。
   *
   * **绝不抛异常** —— 结算是在「进程要死了」时跑的，
   * 它抛异常会**掩盖真正的终止原因**。
   *
   * **幂等** —— 结算可能被调用多次（超时 → 杀进程 → exit 事件 → 又走一遍退出路径）。
   * 重复结算会写出**重复的事件**，而 C4 说事件流是 append-only，
   * 重复事件无法撤销。所以每条挂起请求只结算一次。
   *
   * @param reason 终止原因 —— 写进事件负载，让人能回答
   *   「这次写入为什么没被处理」。
   */
  private settlePendingPermissions(sessionId: string, reason: TerminationReason): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // `drain()` 一次取走全部 —— 取走就移走 → 天然幂等。
    const pending = session.pendingPermissions.drain();
    if (pending.length === 0) return;

    for (const item of pending) {
      try {
        // **抢归属权** —— 判定方可能**已经判完了**（正在写事件）。
        // 抢不到 → 判定方已经写了事件 → 这里**不重复写**。
        //
        // 抢到了 → 这次写入**确实没被处理** → 由我写「因终止未处理」事件。
        if (!session.pendingPermissions.resolve(item.requestId, 'termination')) {
          continue;
        }

        // 回给 agent 的答复 —— **只可能是拒绝**（`renderSettlementOutcome`
        // 绝不回 `allow_always`，见 `permission.ts` 的说明）。
        //
        // 答复**写不出去也没关系** —— 连接可能已经断了（这正是终止路径的常态）。
        // 真正要紧的是**事件**（下面的 `appendTerminatedDecision`）——
        // 那才是追溯链需要的证据。
        const outcome = renderSettlementOutcome(item.options);
        session.pendingPermissions.markSettled(item.requestId, outcome);

        this.appendTerminatedDecision(session, {
          tool: item.tool,
          path: item.path,
          reason,
        });
      } catch {
        // **绝不抛** —— 结算失败不能掩盖终止原因。
        // 事件写不出来是可惜，但终止流程必须正常走完。
      }
    }
  }

  /**
   * 写一条「因终止而未处理」的判定事件（ADR-141）。
   *
   * `basis` 是独立值 `acp:terminated` —— 与 `acp:unknown-tool` 形状不同：
   * - `acp:unknown-tool` —— 我们**看了**这次调用，判不出写目标（agent 的问题）；
   * - `acp:terminated` —— 我们**根本没判**（进程没了，zelto 的问题）。
   *
   * 混成一个 → 事后审计分不清是 agent 的问题还是 zelto 的问题。
   *
   * **decision 恒为 `deny`** —— 这次写入**没有被允许**。
   * 记成 `allow` 是说谎：它没被允许，它只是没被处理。
   */
  private appendTerminatedDecision(
    session: AcpSessionState,
    info: { tool: string; path: string | null; reason: TerminationReason },
  ): void {
    try {
      const eventSlice = session.ctx.sliceId ?? '_acp';
      appendDecisionEvent(
        this.projectRoot,
        eventSlice,
        {
          decision: 'deny',
          ruleId: 'acp:terminated',
          basis: TERMINATED_BASIS,
          reason: `agent terminated before the write was judged (${info.reason})`,
          path: info.path,
          targets: info.path ? [info.path] : [],
          tool: info.tool,
          policyVersion: session.ctx.policyVersion,
          harness: `acp:${this.agentCommand}`,
          sliceId: session.ctx.sliceId,
        },
        session.runId,
      );
    } catch {
      // **绝不抛** —— 写事件失败不能掩盖终止原因。
    }
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
      // ADR-143 落地补充：**记下失败原因**。
      //
      // 为什么：失败是 zelto 判定的，而子进程可能**自己正常退出**（退出码 0）。
      // 只看退出码 → 「失败了」被读成「成功了」（CLI 走成功分支、门禁照跑）。
      session.failure = reason;
    }
    const data = this.sessionData.get(sessionId) ?? loadSession(sessionId);
    if (data && data.status === 'running') {
      data.status = 'failed';
      data.output.push(`[zelto: ${reason}]`);
      saveSession(data);
    }
  }

  private handleExit(sessionId: string, exitCode: number | null): void {
    // ADR-141：**先结算挂起的 permission 请求**（进程退出也是终止路径）。
    //
    // 为什么在清 timer 之前：结算要写的答复需要连接还活着 ——
    // 连接一断就写不出去了。虽然「答复写不出去」不影响「事件已留痕」，
    // 但能写出去就写（agent 那边能立刻知道「被拒了」而不是干等）。
    this.settlePendingPermissions(sessionId, 'exit');

    const timeout = this.timeouts.get(sessionId);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(sessionId);
    }
    // ADR-143：启动上界也要撤 —— 会话结束了，那个计时器没有意义。
    const startupTimer = this.startupTimeouts.get(sessionId);
    if (startupTimer) {
      clearTimeout(startupTimer);
      this.startupTimeouts.delete(sessionId);
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
        // ADR-143 落地补充：**zelto 判定的失败优先于退出码**。
        //
        // 子进程可能自己正常退出（退出码 0），而这一轮其实是失败的
        // （握手超时 / 鉴权失败 / 版本不符）—— 那时若按退出码写成
        // 'completed'，「失败了」就被读成「成功了」。
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
      // ADR-143 落地补充：**这一轮失败了 → 对外的退出码不能是 0**。
      //
      // 为什么必须在这里改（而不是在 `failSession` 里）：
      // `failSession` 发生时进程还活着，退出码**还没定**；
      // 而 `waitForExit` 的返回值是 CLI 判断「这一轮成功没有」的唯一依据
      // —— 返回 0 就意味着「成功」，门禁照跑、签字照走，
      // 而实际上 agent 一行代码都没写。
      //
      // 「失败」的退出码取 1 —— 与 `waitForExit` 里 `child.on('error')`
      // 的口径一致（那也是「起不来」，也是 1）。
      if (state.failure !== null && exitCode === 0) {
        state.exitCode = 1;
      }
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
   *
   * **ADR-140**：拿到那个 id 之后**真的用它** ——
   * 起新连接后发 `session/resume`（首选）或 `session/load`（次选），
   * 而不是发 `session/new` 把上下文清零。
   * agent 都不支持时才退回 `session/new`，并**明确告知人**。
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
    const instructions = buildFallbackResumeInstructions(patch);

    const spawned = this.spawn({
      sessionId: newSessionId,
      sliceId: data.sliceId,
      instructions,
      bundlePath: data.prompt,
      runId: opts?.runId ?? data.runId ?? null,
      // ADR-140：把上一轮的 ACP 会话 id 带下去 —— `connect()` 会按 agent
      // 声明的能力发 `session/resume` / `session/load`（真续）。
      resumeAcpSessionId: acpSessionId,
    });

    // ADR-140 决策二：**等通道确定**再返回 —— 调用方要在**人看到之前**
    // 知道「这次是真续还是新会话」（新会话要明确告知「上下文丢了」）。
    //
    // 这个等待是**有界的**：信号在握手完成、建好会话时就兑现
    // （`session/prompt` **之前**）—— 不等整轮跑完。
    await this.sessions.get(newSessionId)?.sessionModeReady;

    return spawned;
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
    const spawned = this.spawn({
      sessionId: newSessionId,
      sliceId: data.sliceId,
      instructions: buildFallbackContinueInstructions(instructions),
      bundlePath: data.prompt,
      runId: opts?.runId ?? data.runId ?? null,
      // ADR-140：真续同一个 ACP 会话（见上）。
      resumeAcpSessionId: acpSessionId,
    });

    // 与 `resume()` 同一理由：等通道确定（有界 —— 握手完成就兑现）。
    await this.sessions.get(newSessionId)?.sessionModeReady;

    return spawned;
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
   * 这一轮续跑**实际用哪条**通道（ADR-140 决策五）。
   *
   * - `'resume'` —— 发了 `session/resume`（真续，上下文在）
   * - `'load'`   —— 发了 `session/load`（真续，历史回放）
   * - `'new'`    —— 退回 `session/new`（**上下文丢了**）
   *
   * **为什么调用方需要知道**：续跑的**语义**不同（上下文在不在），
   * 人看到「agent 又问了同一个问题」时的判断完全不同。
   * 而且这件事必须在追溯链上看得见（C4）—— 它进 `run.resumed` 的负载。
   */
  getSessionMode(sessionId: string): AcpSessionMode | null {
    return this.sessions.get(sessionId)?.sessionMode ?? null;
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

    // ADR-141：人工停止也是终止路径 —— **必须结算**挂起的请求。
    //
    // **在杀进程之前**结算 —— 连接还活着，答复能写出去。
    session.terminated = 'killed';
    this.settlePendingPermissions(sessionId, 'killed');

    const timeout = this.timeouts.get(sessionId);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(sessionId);
    }
    const interval = this.progressIntervals.get(sessionId);
    if (interval) {
      clearInterval(interval);
          // ADR-143：启动上界也要撤 —— 会话结束了，那个计时器没有意义。
    const startupTimer = this.startupTimeouts.get(sessionId);
    if (startupTimer) {
      clearTimeout(startupTimer);
      this.startupTimeouts.delete(sessionId);
    }
this.progressIntervals.delete(sessionId);
    }

    const data = this.sessionData.get(sessionId) ?? loadSession(sessionId);
    if (data && data.status === 'running') {
      data.status = 'killed';
      data.output.push('[zelto: session stopped by user]');
      saveSession(data);
    }

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
      session.child.on('close', (code) => {
        // ADR-143 落地补充：zelto 判定的失败优先于退出码。
        //
        // `handleExit` 已经把 `state.exitCode` 纠正过了 —— 但 `close` 与
        // `exit` 的触发顺序不保证谁先，所以这里**再取一次**内存里的值
        // （`handleExit` 一定会先跑，因为它绑在 `exit` 上）。
        resolve(session.exitCode ?? code);
      });
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
