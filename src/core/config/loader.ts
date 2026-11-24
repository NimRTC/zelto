// zelto 配置的读取与解析（ADR-086）
//
// **为什么它在 core 而不是 cli**（ADR-086）：
// 驾驶舱也要读配置（门禁命令、验收配置、超时、重试上限）。
// 配置解析器住在 cli/commands/shared.ts 时，Web 端只能：
//   - 自己再写一份解析器（配置语义漂移 —— 一边认 `acceptance:`，一边不认）；
//   - 或者 import `cli/`（adapters 依赖 cli，分层反过来）。
// 两条都不行。配置解析是**纯解析**（无 IO、无依赖、无副作用），
// 天然属于 core。
//
// **本文件是配置语义的唯一实源** —— CLI 与 Web 都读它。
// 一旦有人另写一份解析器，配置语义就会漂移（一边认 `acceptance:`、一边不认），
// 而那种漂移是**静默**的：门禁默默少跑一条命令，没人知道。
//
// C2: 零第三方运行时依赖（只用 Node 内置）。
// C3: 判定确定性 —— 解析只读文本，不调模型、不触网。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GateAcceptanceConfig, GatePhase } from '../gate/types.js';
import { parseScopeConfig, type ScopeConfig } from '../gate/scope.js';
import { stripSurroundingQuotes } from '../policy/yaml.js';
import { parseBlockScalarHeader, readBlockScalar } from './blocks.js';

/** `.zelto` 目录名 —— 与 CLI 的 ZELTO_DIR 同值。 */
export const ZELTO_DIR_NAME = '.zelto';

/**
 * 门禁命令的合法阶段（ZD-009）。
 *
 * 白名单 —— 不认识的阶段名**报错**，不静默当默认值。
 * 写错了阶段名而没人发现，比直接报错难查得多。
 *
 * 不含 `'default'`：那是**没写 phase 时的内部落点**，不是人能写的值 ——
 * 人写 `phase: default` 会被当成「没写」，那不如直接报错让人知道
 * 这个词没有意义。
 */
const GATE_PHASES: readonly string[] = ['configure', 'build', 'test'];

/** 一条门禁命令的形状（config.yaml 里的写法）。 */
export interface GateCommandConfig {
  name: string;
  run: string;
  timeoutSec?: number;
  /** 阶段（ZD-009）。没写 = 老行为（按配置顺序）。 */
  phase?: GatePhase;
}


export interface ZeltoConfig {
  gate: {
    commands: Array<GateCommandConfig>;
    profiles?: Record<string, Array<GateCommandConfig>>;
    /** 切片级验收配置（ADR-033）。没配就退回到「跑该片的验收目录」。 */
    acceptance?: GateAcceptanceConfig;
    /**
     * 门禁作用域（ADR-097）—— 按切片的**写集**收窄「跑哪些用例」。
     *
     * 没配 = 门禁跑全量（老行为，零变化）。
     *
     * 配了之后，写集命中规则的切片会**只跑**带对应 CTest 标签的用例。
     * 规则由**项目侧显式声明** —— 工具不推导目标名（ADR-051 已否决）。
     */
    scope?: ScopeConfig;
    timeoutSec: number;
    /** 子模块预检开关（默认 true）；`false` = 不跑 `submodule-check` 这道预检 */
    submoduleCheck?: boolean;
    retry: { max: number };
  };
  agent: {
    command: string;
    adapter?: string;
    timeout?: number;
    maxRetries?: number;
    /**
     * **agent 用的模型**（不是规格起草用的那个）。
     *
     * 为什么必须有这一节（实测 nimrtc-v14 v1-ice-recovery，2026-11-23）：
     *   `claude-agent-sdk` 适配器原先拿 `llm.model` 当 agent 的模型 ——
     *   而 `llm.model` 是**规格起草**用的模型（nimrtc 那边配的是
     *   `deepseek-ai/DeepSeek-V3`，走自建网关）。
     *
     *   Claude Code 不认识那个模型名 → agent **秒退**（exit 0、无输出、
     *   零改动）。症状极像「agent 干了活但没改文件」，而真正原因是
     *   「模型名不认，agent 根本没跑起来」。
     *
     *   代价是**整轮**（agent 跑 10 秒 → 门禁报「vendor 缺失」→
     *   人以为是自己代码的问题）。这种错误必须当场显形。
     *
     * 所以：agent 的模型**单独配**，不与 `llm.model` 混用。
     * 不配 = 用 Claude Code 自己的默认（不传 model）。
     */
    model?: string;
    /**
     * Claude Code 用 `--output-format stream-json` 跑（ZD-007 阶段2，默认 false）。
     *
     * 为什么默认关：`json` 模式是一次性输出（既有行为），切成 `stream-json`
     * 会改变 stdout 的形态（NDJSON 逐行），影响 `getOutput` 的读取方式。
     * 开了之后 agent **运行中**就能报出累计用量，运行中预算拦截才对
     * shell 适配器生效 —— 但前提是配了 `llm.pricing`（否则报不出金额，仍然拦不了）。
     */
    streamJson?: boolean;
    /**
     * 透传给 agent 子进程的额外环境变量（ADR-090）。
     *
     * 为什么是环境变量而不是命令行旗标：官方 `cursor-agent` 的两个凭证入口
     * 都有环境变量形态（`CURSOR_API_KEY` / `CURSOR_API_ENDPOINT`），
     * 且环境变量不会出现在进程表里 —— 旗标形态会把密钥暴露给 `ps`。
     */
    env?: Record<string, string>;
    /**
     * Cursor 专属可选参数（ADR-090）。只在 `adapter: cursor-agent` 时有意义。
     *
     * 存在的理由：让「我想用哪个端点」比「我需要记住 Cursor 的环境变量叫什么」
     * 更可读。与 `env` 等价，只是更直接。
     */
    cursor?: {
      /** 自定义 API 端点 → `--endpoint <url>` */
      endpoint?: string;
      /**
       * 从**哪个环境变量**读 API key → `--api-key <value>`。
       *
       * 存的是**变量名**不是密钥本身 —— 配置文件要进版本库，
       * 密钥不进（与 ADR-022 的 `ZELTO_LLM_API_KEY` 同口径）。
       */
      apiKeyEnv?: string;
    };
  };
  /**
   * Web 驾驶舱的配置（ADR-086 §7）。
   *
   * **为什么要有这一节**：驾驶舱里点错一下就可能同时拉起多个 agent，
   * 而每个 agent 都在烧 token。这不是安全漏洞，是**成本失控**的闸门。
   */
  web?: {
    /** 同时在跑的 detached 任务数上限（默认 1） */
    maxConcurrentRuns?: number;
    /**
     * 拉起 `zelto run --detach` 的等待上限（毫秒，默认 120000）。
     *
     * 这一段等的是 **CLI 的「准入与准备」** —— 解析写集、建 worktree、
     * 同步 submodule、拉起监督进程。**agent 本身不在里面**
     * （agent 跑在独立进程里，见 ADR-086 §3）。
     *
     * 原来的 30 秒是个**没有依据的魔法数字**：worktree 准备在
     * 含 submodule 的工程上实测要 127 秒（nimrtc v1.4，2026-11-20），
     * 于是「正常开跑」被误判成「超时失败」，而实际上一个 agent 都没起。
     *
     * 2 分钟给准备阶段留足余量；agent 的运行是异步的，不占这个预算。
     */
    launchTimeoutMs?: number;
  };
  llm?: { provider: string; apiKey?: string; baseUrl?: string; model?: string; pricing?: Record<string, { inputPer1k: number; outputPer1k: number }> };
  /**
   * worktree 的**准备阶段**（ADR-095 §3.2）。
   *
   * 用途：生成「不进版本库」的构建产物（证书、protobuf、代码生成…）。
   *
   * **为什么要有**：新建的 worktree 只含**被 git 跟踪**的内容。
   * 而有些项目的构建**依赖**生成的产物 —— 那文件在 `.gitignore` 里
   * （实测 nimrtc-v14 v3-n4-d6-connectivity，2026-11-22：
   * wolfssl 的 `certs/ecc-key.pem`），git 不会带过去，
   * 于是门禁②的 build 阶段必然失败，且报错指向「找不到头文件」
   * —— 跟真正的原因毫无关系。
   *
   * **为什么是「生成」而不是「拷贝」**：拷贝旧的产物可能带来**过期**的
   * 内容（过期的证书），而重新生成保证产物与当前代码一致。
   *
   * 没配这一节 = 不做任何准备 = 不产生行为变化。
   */
  worktree?: {
    prepare?: {
      commands: Array<{ run: string; timeoutSec?: number }>;
    };
  };
  /**
   * 「拉闸」请求的**默认有效期**（秒）。
   *
   * 为什么要有（ZD-023 剩余问题）：TTL 原本硬编码 30 分钟，
   * 有人想「我这一轮暂停要留 2 小时」时没有出口 ——
   * `HaltStore.request()` 支持传 TTL，但 CLI 没暴露。
   *
   * 语义：
   * - 未配置 / 配不出数 → 用 `DEFAULT_HALT_TTL_MS`（30 分钟）；
   * - `0` → **永不过期**（人显式要的）；
   * - 其它正数 → 这个秒数就是默认 TTL。
   *
   * 注意：过期只影响「拦不拦新工作」，**不影响「停不停在跑的活」**
   * （见 `core/halt/store.ts` 的 `HaltRequest.expiresAt`）。
   */
  haltTtlSec?: number;
  /**
   * 预算上限（美元）—— **运行中预算闸门**的上限（ZD-007）。
   *
   * 语义（与 `core/budget/collector.ts` 的 `getLimit` 完全一致）：
   * - 未配置 / 配不出数 → 默认 `1.0`；
   * - `0` → **不限**（`Infinity`）—— 没有上限就没有闸门；
   * - 其它正数 → 这个数就是上限。
   *
   * 为什么要有这个字段：原先上限只有 `BudgetCollector` 从 config.yaml
   * **直接读文件**得到，CLI 侧（`createExecutorAdapter`）拿不到 ——
   * 于是「事前约束」（SDK 的 `maxBudgetUsd`）接不上，
   * 运行中拦截（ZD-007）也没有上限可用。
   *
   * **同一口径两处读**（这里 + collector）是硬要求：
   * 两份实现漂移的后果是「起跑前那道闸门按 $1 判、运行中那道按 $100 判」，
   * 人会看到一个自相矛盾的账。
   */
  budgetLimitUsd?: number;
  /** External project configuration for cross-repo workflows.
   *  When set, `zelto gate` and `zelto slice create` operate in the
   *  target project directory instead of the current working directory. */
  targetProject?: {
    /** Absolute or relative path to the target project root. */
    path: string;
    /** Optional gate overrides for the target project. Falls back to
     *  the root gate.commands when not specified. */
    gate?: {
      commands: Array<GateCommandConfig>;
      profiles?: Record<string, Array<GateCommandConfig>>;
    };
    /** Spec directory relative to target project root. Default = "specs/slices". */
    specDir?: string;
  };
}

/**
 * Resolve the LLM API key (ADR-022).
 *
 * Priority, highest first:
 *   1. `ZELTO_LLM_API_KEY`  — zelto-specific, never collides with other tools
 *   2. `DEEPSEEK_API_KEY`   — the ecosystem convention
 *   3. `llm.apiKey` in `.zelto/config.yaml` — the existing fallback
 *
 * The key never has to live in a file: set it in the environment and the
 * config file only carries the non-secret parts (baseUrl, model, pricing).
 *
 * `llm.baseUrl` / `llm.model` are NOT read from the environment — they are
 * not secrets, and keeping them in the config file is what makes a project
 * reproducible.
 */
export function resolveApiKey(
  configApiKey: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const fromEnv = env.ZELTO_LLM_API_KEY?.trim() || env.DEEPSEEK_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const fromConfig = configApiKey?.trim();
  return fromConfig ? fromConfig : undefined;
}

/**
 * Parse an environment-variable reference of the form `${NAME}` (ADR-026).
 *
 * Only whole-value references count: `"${FOO}"` parses, `"prefix-${FOO}"`
 * does not. Partial expansion would silently produce half a credential when
 * the variable is unset — harder to diagnose than not expanding at all.
 *
 * Returns the variable name, or null when the value is not a reference.
 */
export function parseEnvRef(value: string): string | null {
  const m = value.trim().match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  return m ? m[1] : null;
}

/**
 * Expand `${VAR}` references in `llm.apiKey` (ADR-026).
 *
 * Only the API key is expanded. `llm.baseUrl` / `llm.model` / `llm.pricing`
 * are configuration, not secrets — they stay in the file so the project
 * remains reproducible (ADR-022). `gate.commands[].run` is handed to the
 * shell, which does its own variable substitution; expanding here would
 * change the command's meaning.
 *
 * A reference to an unset variable resolves to "no key" rather than to the
 * literal text — sending `${NIMRTC_LLM_API_KEY}` as a bearer token would
 * fail with an opaque 401 that points at the wrong thing.
 */
export function expandConfigEnvRefs(
  config: ZeltoConfig,
  env: NodeJS.ProcessEnv = process.env,
): ZeltoConfig {
  const llm = config.llm;
  if (!llm?.apiKey) return config;

  const name = parseEnvRef(llm.apiKey);
  if (!name) return config;

  const resolved = env[name]?.trim();
  if (!resolved) {
    console.warn(
      `  ⚠️  Config: llm.apiKey references environment variable ${name}, but it is not set.`,
    );
    console.warn('      The LLM path (clarify / spec / stall) will be unavailable.');
    return { ...config, llm: { ...llm, apiKey: '' } };
  }

  return { ...config, llm: { ...llm, apiKey: resolved } };
}

/**
 * 读当前工作目录下的 `.zelto/config.yaml`。
 *
 * **CLI 用这个**（CLI 的 cwd 就是项目根）。
 * Web 端要用 `loadConfigAt(repoRoot)` —— 驾驶舱的 repoRoot 是参数，
 * 未必等于进程 cwd。
 */
export function loadConfig(): ZeltoConfig {
  return loadConfigAt(process.cwd());
}

export function loadConfigAt(repoRoot: string): ZeltoConfig {
  const configPath = join(repoRoot, ZELTO_DIR_NAME, 'config.yaml');
  const defaultConfig: ZeltoConfig = {
    gate: {
      commands: [
        { name: 'test', run: 'pnpm test' },
        { name: 'lint', run: 'pnpm lint' },
      ],
      timeoutSec: 120,
      retry: { max: 2 },
    },
    agent: {
      command: 'npx claude-code',
      maxRetries: 2,
    },
  };

  if (!existsSync(configPath)) return withEnvApiKey(defaultConfig);

  try {
    const content = readFileSync(configPath, 'utf-8');
    const parsed = parseConfigYaml(content);
    if (parsed) {
      const assembled: ZeltoConfig = {
        gate: parsed.gate,
        agent: parsed.agent ?? defaultConfig.agent,
        ...(parsed.web ? { web: parsed.web } : {}),
        // 生成物清单（ADR-095 §3.2）—— 不配就没有这一节（= 不做准备）。
        ...(parsed.worktree ? { worktree: parsed.worktree } : {}),
        // 拉闸默认 TTL（秒）—— 不配就没有这个字段（= 用默认 30 分钟）。
        ...(parsed.haltTtlSec !== undefined ? { haltTtlSec: parsed.haltTtlSec } : {}),
        // 预算上限（美元）—— 不配就没有这个字段（= 用默认 1.0）。
        ...(parsed.budgetLimitUsd !== undefined ? { budgetLimitUsd: parsed.budgetLimitUsd } : {}),
        llm: parsed.llm,
        targetProject: parsed.targetProject,
      };
      // Expand `${VAR}` references before validating — the placeholder check
      // has to see the real value (ADR-026).
      const expanded = expandConfigEnvRefs(assembled);
      // Validate config and warn about common issues
      validateConfig(expanded);
      return withEnvApiKey(expanded);
    }
    return withEnvApiKey(defaultConfig);
  } catch {
    return withEnvApiKey(defaultConfig);
  }
}

/**
 * Apply the environment-variable API key to a config (ADR-022).
 *
 * The environment wins over the config file. If the file has no `llm` section
 * at all but the environment provides a key, an `llm` section is synthesised
 * so the LLM path (clarify / spec / stall) stays usable with a key that never
 * touched the disk.
 */
function withEnvApiKey(config: ZeltoConfig): ZeltoConfig {
  const envKey = resolveApiKey(undefined);
  if (!envKey) {
    // No environment key — keep whatever the config file had.
    if (!config.llm?.apiKey) return config;
    return config;
  }

  const llm = config.llm
    ? { ...config.llm, provider: config.llm.provider || 'deepseek', apiKey: envKey }
    : { provider: 'deepseek', apiKey: envKey };

  return { ...config, llm };
}

/**
 * Validate config for common issues and log warnings.
 * Does not throw — warnings are non-fatal.
 */
function validateConfig(config: ZeltoConfig): void {
  if (!config.gate?.commands?.length) {
    console.warn('  ⚠️  Config: no gate commands defined. Gate② will be a no-op.');
  }
  if (config.gate?.timeoutSec !== undefined && (config.gate.timeoutSec < 10 || config.gate.timeoutSec > 3600)) {
    console.warn(`  ⚠️  Config: gate.timeoutSec (${config.gate.timeoutSec}) seems unusual. Expected 10-3600.`);
  }
  if (config.gate?.retry?.max !== undefined && config.gate.retry.max < 0) {
    console.warn(`  ⚠️  Config: gate.retry.max (${config.gate.retry.max}) is negative. Using 0.`);
    config.gate.retry.max = 0;
  }
  if (!config.agent?.command) {
    console.warn('  ⚠️  Config: no agent command defined. "zelto run" will fail.');
  }
  if (config.llm?.apiKey && config.llm.apiKey === 'sk-your-key-here' && !resolveApiKey(undefined)) {
    console.warn('  ⚠️  Config: LLM API key appears to be a placeholder. Set ZELTO_LLM_API_KEY or update .zelto/config.yaml with a real key.');
  }
}

/**
 * Parse .zelto/config.yaml into a ZeltoConfig.
 *
 * Quote stripping is delegated to core/policy/yaml.ts so that config and
 * policy parsing share one definition of "surrounding quotes".
 */
export function parseConfigYaml(content: string): ZeltoConfig | null {
  const commands: Array<GateCommandConfig> = [];
  const profiles: Record<string, Array<GateCommandConfig>> = {};
  let timeoutSec = 120;
  let retryMax = 2;
  let agentCommand = 'npx claude-code';
  let agentAdapter = '';
  let agentTimeout: number | undefined;
  let agentMaxRetries: number | undefined;
  let agentStreamJson = false;
  let agentModel: string | undefined;
  // agent 段的嵌套节（ADR-090）—— 需要跟缩进，否则会把 agent 顶层的
  // timeout: / maxRetries: 误吞成 env 的键
  let inAgentEnvSection = false;
  let agentEnvIndent = 0;
  const agentEnv: Record<string, string> = {};
  let inAgentCursorSection = false;
  let agentCursorIndent = 0;
  let agentCursorEndpoint: string | undefined;
  let agentCursorApiKeyEnv: string | undefined;
  let currentCommand: GateCommandConfig | null = null;
  /** 缩进层级：用来区分「命令自身的 timeoutSec」与「gate 全局 timeoutSec」 */
  let currentCommandIndent = 0;
  let inGateSection = false;
  let inAgentSection = false;
  let inLlmSection = false;
  let inTargetProjectSection = false;
  let inTargetProjectGateSection = false;
  let inProfileSection = false;
  let currentProfile: string | null = null;
  // 切片级验收段（ADR-033）
  let inAcceptanceSection = false;
  let acceptanceIndent = 0;
  let acceptanceCommand = '';
  let acceptanceRequired = true;
  let acceptanceTimeoutSec: number | undefined;
  let acceptanceBuildDir: string | undefined;
  // scope: 段（ADR-097）—— 门禁作用域规则
  let inScopeSection = false;
  let scopeIndent = 0;
  let scopeBlockLines: string[] = [];
  let gateScope: ScopeConfig | undefined;
  /** 子模块预检开关（缺省 = 不写字段 = 预检开启） */
  let submoduleCheck: boolean | undefined;
  let llmProvider = '';
  let llmApiKey = '';
  let llmModel = '';
  let llmBaseUrl = '';
  let inLlmPricingSection = false;
  let currentPricingModel = '';
  // web: 段（ADR-086 §7）—— 驾驶舱的同时在跑任务数上限
  let inWebSection = false;
  let webMaxConcurrentRuns: number | undefined;
  let webLaunchTimeoutMs: number | undefined;
  /** 拉闸默认 TTL（秒）。`0` = 永不过期；undefined = 用默认 30 分钟。 */
  let haltTtlSec: number | undefined;
  /** 预算上限（美元）。`0` = 不限；undefined = 用默认 1.0。 */
  let budgetLimitUsd: number | undefined;
  // worktree: 段（ADR-095 §3.2）—— 生成物清单
  let inWorktreeSection = false;
  let inWorktreePrepareSection = false;
  let worktreePrepareIndent = 0;
  /** 当前正在攒的 prepare 命令（`run:` + 可选 `timeoutSec:`） */
  let currentPrepareCommand: { run: string; timeoutSec?: number } | null = null;
  let currentPrepareCommandIndent = 0;
  const worktreePrepareCommands: Array<{ run: string; timeoutSec?: number }> = [];
  const llmPricing: Record<string, { inputPer1k: number; outputPer1k: number }> = {};
  let targetProjectPath = '';
  let targetProjectSpecDir = '';
  let targetProjectDepth = 0;
  const targetProjectCommands: Array<GateCommandConfig> = [];
  const targetProjectProfiles: Record<string, Array<GateCommandConfig>> = {};
  let currentTpCommand: GateCommandConfig | null = null;
  /** 缩进层级：区分命令自身的 timeoutSec 与上层配置 */
  let currentTpCommandIndent = 0;
  let inTpProfileSection = false;
  let currentTpProfile: string | null = null;

  const lines = content.split('\n');

  /**
   * 把正在攒的 command 落袋（进 profile 或进 commands）。
   *
   * 抽成函数是因为「收尾」这件事在解析器里有**五处**要做
   * （遇到新段头时、遇到新命令项时、循环结束时…）—— 抄五遍迟早漏一处，
   * 而漏掉的后果是**一条门禁命令静默消失**（门禁少跑一条，却报「通过」）。
   */
  const flushPendingCommand = (): void => {
    if (!currentCommand) return;
    if (currentProfile) {
      (profiles[currentProfile] ??= []).push(currentCommand);
    } else {
      commands.push(currentCommand);
    }
    currentCommand = null;
  };

  // 索引式循环：块标量（run: > / command: |）要一次吃掉若干行，
  // 需要能把游标推进到块之后的下一行（见 config-blocks.ts）。
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const indent = line.length - trimmed.length;
    if (trimmed.startsWith('#') || trimmed === '') continue;

    if (trimmed === 'gate:' && !inTargetProjectSection) {
      inGateSection = true;
      inAgentSection = false;
      inLlmSection = false;
      inWebSection = false;
      inProfileSection = false;
      currentProfile = null;
      continue;
    }
    if (trimmed === 'agent:' && !inTargetProjectSection) {
      inAgentSection = true;
      inGateSection = false;
      inLlmSection = false;
      inWebSection = false;
      inProfileSection = false;
      currentProfile = null;
      continue;
    }
    if (trimmed === 'llm:' && !inTargetProjectSection) {
      inLlmSection = true;
      inGateSection = false;
      inAgentSection = false;
      inWebSection = false;
      inTargetProjectSection = false;
      inProfileSection = false;
      inLlmPricingSection = false;
      currentProfile = null;
      continue;
    }
    if (trimmed === 'web:' && !inTargetProjectSection) {
      inWebSection = true;
      inGateSection = false;
      inAgentSection = false;
      inLlmSection = false;
      inProfileSection = false;
      inLlmPricingSection = false;
      currentProfile = null;
      continue;
    }
    // worktree: 段（ADR-095 §3.2）—— 生成物清单。
    //
    // 与其它段一样是**平级**的顶层节，且会**关掉**其它段的标志位 ——
    // 否则 `worktree.prepare` 下面的 `run:` 会被当成 gate 命令读走。
    if (trimmed === 'worktree:' && !inTargetProjectSection) {
      inWorktreeSection = true;
      inGateSection = false;
      inAgentSection = false;
      inLlmSection = false;
      inWebSection = false;
      inProfileSection = false;
      inLlmPricingSection = false;
      currentProfile = null;
      continue;
    }
    if (trimmed === 'targetProject:') {
      inTargetProjectSection = true;
      inGateSection = false;
      inAgentSection = false;
      inLlmSection = false;
      inWebSection = false;
      inProfileSection = false;
      currentProfile = null;
      targetProjectDepth = 0;
      continue;
    }

    if (inGateSection) {
      // Handle profiles: section header — flush pending command to commands first
      if (trimmed === 'profiles:') {
        if (currentCommand) {
          commands.push(currentCommand);
          currentCommand = null;
        }
        inProfileSection = true;
        currentProfile = null;
        continue;
      }

      // acceptance: 切片级验收段（ADR-033）。
      // 它是 gate 的兄弟节点，不是 command —— 所以要在这里另开一个状态机，
      // 不能借用 currentCommand 那套（那是给 `- name:` 列表用的）。
      //
      // 位置要紧：必须在「profile 名匹配」之前判。否则 `profiles:` 之后的
      // `acceptance:` 会被当成一个叫 acceptance 的 profile 名吃掉，
      // 验收配置就静默丢了 —— 门禁于是「配了却没跑」。
      if (trimmed === 'acceptance:') {
        inAcceptanceSection = true;
        acceptanceIndent = indent;
        acceptanceCommand = '';
        acceptanceRequired = true;
        acceptanceTimeoutSec = undefined;
        acceptanceBuildDir = undefined;
        continue;
      }

      // scope: 门禁作用域段（ADR-097）。
      //
      // 它是 gate 的兄弟节点，不是 command —— 与 acceptance 一样要另开
      // 一个状态机（不能借用 currentCommand 那套）。
      //
      // 位置要紧：必须在「profile 名匹配」之前判。否则 `scope:` 之后的
      // 规则项会被当成 profile 名 / command 吃掉，作用域规则静默丢失
      // —— 门禁于是「配了却按全量跑」（而且没人知道）。
      if (trimmed === 'scope:') {
        flushPendingCommand();
        inScopeSection = true;
        scopeIndent = indent;
        scopeBlockLines = [];
        continue;
      }

      if (inScopeSection) {
        // 只认比 `scope:` 更深缩进的行 —— 缩进回到 `scope:` 那一层
        // 或更浅，就是 scope 段结束（回到 gate 的其它键）。
        if (indent > scopeIndent) {
          // 用外层的 `line`（原始行，保留缩进）——
          // 里面的 `raw` 是 acceptance 段自己的局部变量。
          scopeBlockLines.push(line);
          continue;
        }
        // scope 段结束 —— 结算并回到 gate 段。
        inScopeSection = false;
        const scopeCfg = parseScopeConfig(scopeBlockLines.join('\n'));
        if (scopeCfg) gateScope = scopeCfg;
        scopeBlockLines = [];
        // 落到这里说明这一行是 gate 的其它键 —— 继续往下走（不 continue）。
      }

      // Detect profile name (indented under profiles:, e.g. "  docs:")
      const profileMatch = trimmed.match(/^(\w+):$/);
      if (profileMatch && inProfileSection) {
        // Push pending command to the previous profile before switching
        if (currentCommand && currentProfile) {
          (profiles[currentProfile] ??= []).push(currentCommand);
          currentCommand = null;
        }
        currentProfile = profileMatch[1];
        continue;
      }

      if (trimmed.startsWith('commands:') || trimmed === 'commands:') {
        inProfileSection = false;
        currentProfile = null;
        continue;
      }

      if (inAcceptanceSection) {
        // 只认比 acceptance: 更深缩进的键 —— 否则 gate 顶层的 timeoutSec: 会被误吞。
        if (indent <= acceptanceIndent) {
          inAcceptanceSection = false;
        } else if (trimmed.startsWith('command:')) {
          const raw = trimmed.slice(8).trim();
          const header = parseBlockScalarHeader(raw);
          if (header) {
            const block = readBlockScalar(lines, i, indent, header);
            if (block) {
              acceptanceCommand = block.value;
              i = block.nextIndex - 1;
              continue;
            }
          }
          acceptanceCommand = stripSurroundingQuotes(raw);
          continue;
        } else if (trimmed.startsWith('required:')) {
          const raw = trimmed.slice(9).trim().toLowerCase();
          acceptanceRequired = raw !== 'false';
          continue;
        } else if (trimmed.startsWith('timeoutSec:')) {
          acceptanceTimeoutSec = Number.parseInt(trimmed.slice(11).trim(), 10) || undefined;
          continue;
        } else if (trimmed.startsWith('buildDir:')) {
          acceptanceBuildDir = stripSurroundingQuotes(trimmed.slice(9).trim()) || undefined;
          continue;
        } else {
          // 未知子键：结束这段，别把它当 gate 的键处理
          inAcceptanceSection = false;
        }
      }

      const inlineMatch = trimmed.match(/^- \{\s*name:\s*(\S+?)\s*,\s*run:\s*"([^"]*)"\s*\}$/);
      if (inlineMatch) {
        if (currentCommand) {
          if (currentProfile) {
            (profiles[currentProfile] ??= []).push(currentCommand);
          } else {
            commands.push(currentCommand);
          }
        }
        currentCommand = { name: inlineMatch[1], run: inlineMatch[2] };
        currentCommandIndent = indent;
        continue;
      }

      if (trimmed === '- name: test' || trimmed.startsWith('- name:')) {
        if (currentCommand) {
          if (currentProfile) {
            (profiles[currentProfile] ??= []).push(currentCommand);
          } else {
            commands.push(currentCommand);
          }
        }
        currentCommand = { name: trimmed.slice(7).trim(), run: '', timeoutSec: undefined };
        currentCommandIndent = indent;
        continue;
      }

      if (trimmed.startsWith('run:')) {
        const raw = trimmed.slice(4).trim();
        const header = parseBlockScalarHeader(raw);
        if (header) {
          const block = readBlockScalar(lines, i, indent, header);
          if (block) {
            if (currentCommand) currentCommand.run = block.value;
            i = block.nextIndex - 1;
            continue;
          }
        }
        if (currentCommand) {
          currentCommand.run = stripSurroundingQuotes(raw);
        }
        continue;
      }

      // timeoutSec：缩进比命令项更深 → 该命令专属；否则 → gate 全局
      if (trimmed.startsWith('timeoutSec:')) {
        const isPerCommand = currentCommand !== null && currentCommand.run !== '' && indent > currentCommandIndent;
        if (isPerCommand && currentCommand) {
          currentCommand.timeoutSec = Number.parseInt(trimmed.slice(11).trim(), 10) || undefined;
        } else {
          timeoutSec = Number.parseInt(trimmed.slice(11).trim(), 10) || 120;
        }
        continue;
      }

      // phase：门禁命令的阶段（ZD-009）—— configure / build / test。
      //
      // 缩进比命令项更深 → 该命令专属。没写 = `default`（老行为）。
      //
      // 认不出的值**不猜**（不静默当 default）—— 写错了阶段名会让人以为
      // 「配了但没生效」，那比直接报错更难查。判据是白名单。
      if (trimmed.startsWith('phase:')) {
        const raw = trimmed.slice(6).trim().toLowerCase();
        const isPerCommand = currentCommand !== null && indent > currentCommandIndent;
        if (isPerCommand && currentCommand) {
          if (!GATE_PHASES.includes(raw)) {
            throw new Error(
              `gate 命令 "${currentCommand.name}" 的 phase: "${raw}" 不认识。` +
              `可用值：${GATE_PHASES.join(' / ')}`,
            );
          }
          currentCommand.phase = raw as GatePhase;
        }
        continue;
      }

      // submoduleCheck：子模块预检开关（默认 true）。`false` 显式关掉。
      if (trimmed.startsWith('submoduleCheck:')) {
        submoduleCheck = trimmed.slice(15).trim().toLowerCase() !== 'false';
        continue;
      }

      if (trimmed.startsWith('max:')) {
        retryMax = Number.parseInt(trimmed.slice(4).trim(), 10) || 2;
        continue;
      }
    }

    if (inAgentSection) {
      // ── 嵌套节（ADR-090）：env: / cursor: ──
      // 位置要紧：必须在 command:/adapter:/timeout: 之前判，
      // 否则 env 下面的键会被当成 agent 顶层键。
      if (trimmed === 'env:') {
        inAgentEnvSection = true;
        agentEnvIndent = indent;
        inAgentCursorSection = false;
        continue;
      }
      if (trimmed === 'cursor:') {
        inAgentCursorSection = true;
        agentCursorIndent = indent;
        inAgentEnvSection = false;
        continue;
      }

      if (inAgentEnvSection) {
        // 只认比 env: 更深缩进的键
        if (indent <= agentEnvIndent) {
          inAgentEnvSection = false;
        } else {
          const kv = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
          if (kv) {
            const value = stripSurroundingQuotes(kv[2].trim());
            // 空值 = 这个变量不注入（而不是注入空串 —— 那会让 CLI
            // 以为「配了但设成了空」，行为与「没配」不同）。
            if (value) agentEnv[kv[1]] = value;
            continue;
          }
        }
      }

      if (inAgentCursorSection) {
        if (indent <= agentCursorIndent) {
          inAgentCursorSection = false;
        } else {
          if (trimmed.startsWith('endpoint:')) {
            agentCursorEndpoint =
              stripSurroundingQuotes(trimmed.slice(9).trim()) || undefined;
            continue;
          }
          if (trimmed.startsWith('apiKeyEnv:')) {
            agentCursorApiKeyEnv =
              stripSurroundingQuotes(trimmed.slice(10).trim()) || undefined;
            continue;
          }
        }
      }

      if (trimmed.startsWith('command:')) {
        const raw = trimmed.slice(8).trim();
        const header = parseBlockScalarHeader(raw);
        if (header) {
          const block = readBlockScalar(lines, i, indent, header);
          if (block) {
            agentCommand = block.value;
            i = block.nextIndex - 1;
          }
        } else {
          agentCommand = stripSurroundingQuotes(raw);
        }
        continue;
      }

      if (trimmed.startsWith('adapter:')) {
        agentAdapter = stripSurroundingQuotes(trimmed.slice(8).trim());
        continue;
      }

      if (trimmed.startsWith('timeout:')) {
        agentTimeout = Number.parseInt(trimmed.slice(8).trim(), 10) || undefined;
        continue;
      }

      if (trimmed.startsWith('maxRetries:')) {
        agentMaxRetries = Number.parseInt(trimmed.slice(11).trim(), 10) || undefined;
        continue;
      }

      // agent 段的 `model:` —— agent 执行用的模型，**与 `llm.model`（规格起草）
      // 是两回事**。混用会让 Claude Code 认不出模型名而秒退（ADR-101 附注）。
      if (trimmed.startsWith('model:')) {
        agentModel = stripSurroundingQuotes(trimmed.slice(6).trim());
        continue;
      }

      // ZD-007 阶段2：Claude Code 用 `--output-format stream-json` 跑。
      // 默认关（保持 `json` 一次性输出的既有行为）；开了之后 agent 运行中
      // 就能报出累计用量，运行中预算拦截才对 shell 适配器生效。
      if (trimmed.startsWith('streamJson:')) {
        const raw = stripSurroundingQuotes(trimmed.slice(11).trim()).toLowerCase();
        agentStreamJson = raw === 'true' || raw === 'yes' || raw === '1';
        continue;
      }

      // 认不出的 agent 子键：结束嵌套节，交回其它段处理。
      inAgentEnvSection = false;
      inAgentCursorSection = false;
    }

    if (inWebSection && trimmed.startsWith('maxConcurrentRuns:')) {
      const raw = Number.parseInt(trimmed.slice(18).trim(), 10);
      // 小于 1 视为无效 —— 上限为 0 等于「什么都不许跑」，
      // 那不是配置意图，是笔误。回退到默认 1。
      webMaxConcurrentRuns = Number.isFinite(raw) && raw >= 1 ? raw : undefined;
      continue;
    }

    if (inWebSection && trimmed.startsWith('launchTimeoutMs:')) {
      const raw = Number.parseInt(trimmed.slice(16).trim(), 10);
      // 小于 1000 视为无效 —— 太短的开跑预算必然误报超时。
      webLaunchTimeoutMs = Number.isFinite(raw) && raw >= 1000 ? raw : undefined;
      continue;
    }

    // ── haltTtlSec：拉闸请求的默认有效期（秒）────────────────────────
    //
    // ZD-023 剩余问题：TTL 硬编码 30 分钟，没有配置项。
    // 有人想「这一轮暂停留 2 小时」时没有出口。
    //
    // 顶层标量键 —— 不在任何段里，所以要放在段的判断**之前**判，
    // 否则它会被某个段的兜底分支吃掉。
    if (trimmed.startsWith('haltTtlSec:')) {
      const raw = Number.parseInt(trimmed.slice(11).trim(), 10);
      // 负数无效（那不是「更短的 TTL」，是笔误）；0 = 永不过期（合法）。
      haltTtlSec = Number.isFinite(raw) && raw >= 0 ? raw : undefined;
      continue;
    }

    // ── budgetLimitUsd：预算上限（美元）──────────────────────────────
    //
    // ZD-007：运行中预算闸门需要上限。
    //
    // 顶层标量键 —— 与 haltTtlSec 同理，要放在段的判断之前。
    //
    // 语义与 `core/budget/collector.ts` 的 `getLimit` **必须一致**：
    // - `0` → 不限（Infinity）
    // - 正数 → 这个数就是上限
    // - 负数 / 解析不出数 → 无效（当作没配）
    if (trimmed.startsWith('budgetLimitUsd:')) {
      const raw = Number.parseFloat(trimmed.slice(15).trim());
      budgetLimitUsd = Number.isFinite(raw) && raw >= 0 ? raw : undefined;
      continue;
    }

    // ── worktree.prepare 段（ADR-095 §3.2）──────────────────────────
    if (inWorktreeSection) {
      // 嵌套节 `prepare:` —— 缩进比 `worktree:` 深。
      if (trimmed === 'prepare:') {
        inWorktreePrepareSection = true;
        worktreePrepareIndent = indent;
        currentPrepareCommand = null;
        continue;
      }
      // `prepare:` 里又出现更深的 `prepare:` → 已退出该节（防御纵深）。
      if (inWorktreePrepareSection && indent <= worktreePrepareIndent && trimmed.endsWith(':')) {
        inWorktreePrepareSection = false;
        currentPrepareCommand = null;
      }
      if (inWorktreePrepareSection) {
        // `- run: <命令>` —— YAML 的列表项前缀 `- ` 也在 `trimmed` 里。
        //
        // 判据要**同时**认「带 `- ` 前缀」和「不带」两种形态：
        //   - `- run: xxx`（列表项，这是本文档的写法）
        //   - `run: xxx`（裸键）
        //
        // gate 段用的是另一种办法（先剥 `- ` 再比），
        // 这里是**独立**状态机，所以自己处理。
        const withoutDash = trimmed.startsWith('- ') ? trimmed.slice(2).trim() : trimmed;

        // `run:` —— 一条准备命令。
        if (withoutDash.startsWith('run:')) {
          const run = stripSurroundingQuotes(withoutDash.slice(4).trim());
          // 空命令等于「没配」—— 宁可跳过，也不要拿空命令去跑（必然失败，
          // 且失败原因会误导人）。见 acceptance 段的同类处理。
          if (run) {
            currentPrepareCommand = { run };
            currentPrepareCommandIndent = indent;
            worktreePrepareCommands.push(currentPrepareCommand);
          }
          continue;
        }
        // `timeoutSec:` —— 缩进比 `run:` 更深 → 该命令专属。
        if (withoutDash.startsWith('timeoutSec:')) {
          const isPerCommand =
            currentPrepareCommand !== null && indent > currentPrepareCommandIndent;
          if (isPerCommand && currentPrepareCommand) {
            const sec = Number.parseInt(withoutDash.slice(11).trim(), 10);
            currentPrepareCommand.timeoutSec =
              Number.isFinite(sec) && sec > 0 ? sec : undefined;
          }
          continue;
        }
        continue;
      }
      // 认不出的 worktree 子键 → 结束该节。
      inWorktreeSection = false;
    }

    if (inLlmSection) {
      if (trimmed.startsWith('provider:')) {
        llmProvider = stripSurroundingQuotes(trimmed.slice(9).trim());
        inLlmPricingSection = false;
      } else if (trimmed.startsWith('apiKey:')) {
        llmApiKey = stripSurroundingQuotes(trimmed.slice(7).trim());
        inLlmPricingSection = false;
      } else if (trimmed.startsWith('model:')) {
        llmModel = stripSurroundingQuotes(trimmed.slice(6).trim());
        inLlmPricingSection = false;
      } else if (trimmed.startsWith('baseUrl:')) {
        llmBaseUrl = stripSurroundingQuotes(trimmed.slice(8).trim());
        inLlmPricingSection = false;
      } else if (trimmed === 'pricing:') {
        inLlmPricingSection = true;
      } else if (inLlmPricingSection) {
        // Parse model-level pricing entries
        const modelMatch = trimmed.match(/^([\w.-]+):\s*$/);
        if (modelMatch) {
          currentPricingModel = modelMatch[1];
          llmPricing[currentPricingModel] = { inputPer1k: 0, outputPer1k: 0 };
        } else if (currentPricingModel && trimmed.startsWith('inputPer1k:')) {
          const val = Number.parseFloat(trimmed.slice(11).trim());
          if (!Number.isNaN(val)) llmPricing[currentPricingModel].inputPer1k = val;
        } else if (currentPricingModel && trimmed.startsWith('outputPer1k:')) {
          const val = Number.parseFloat(trimmed.slice(12).trim());
          if (!Number.isNaN(val)) llmPricing[currentPricingModel].outputPer1k = val;
        }
      }
    }

    if (inTargetProjectSection) {
      // Track indentation depth to detect when targetProject ends
      if (indent <= targetProjectDepth && indent > 0 && trimmed.includes(':')) {
        // Sub-section header within targetProject
      }

      if (trimmed.startsWith('path:')) {
        targetProjectPath = stripSurroundingQuotes(trimmed.slice(5).trim());
        continue;
      }
      if (trimmed.startsWith('specDir:')) {
        targetProjectSpecDir = stripSurroundingQuotes(trimmed.slice(8).trim());
        continue;
      }

      // Nested gate: section under targetProject
      if (trimmed === 'gate:') {
        inTargetProjectGateSection = true;
        inTpProfileSection = false;
        currentTpProfile = null;
        continue;
      }

      if (inTargetProjectGateSection) {
        if (trimmed === 'profiles:') {
          if (currentTpCommand) {
            targetProjectCommands.push(currentTpCommand);
            currentTpCommand = null;
          }
          inTpProfileSection = true;
          currentTpProfile = null;
          continue;
        }

        // Detect profile name (indented under profiles:)
        const profileMatch = trimmed.match(/^(\w+):$/);
        if (profileMatch && inTpProfileSection) {
          if (currentTpCommand && currentTpProfile) {
            (targetProjectProfiles[currentTpProfile] ??= []).push(currentTpCommand);
            currentTpCommand = null;
          }
          currentTpProfile = profileMatch[1];
          continue;
        }

        if (trimmed.startsWith('commands:') || trimmed === 'commands:') {
          inTpProfileSection = false;
          currentTpProfile = null;
          continue;
        }

        const inlineMatch = trimmed.match(/^- \{\s*name:\s*(\S+?)\s*,\s*run:\s*"([^"]*)"\s*\}$/);
        if (inlineMatch) {
          if (currentTpCommand) {
            if (currentTpProfile) {
              (targetProjectProfiles[currentTpProfile] ??= []).push(currentTpCommand);
            } else {
              targetProjectCommands.push(currentTpCommand);
            }
          }
          currentTpCommand = { name: inlineMatch[1], run: inlineMatch[2] };
          currentTpCommandIndent = indent;
          continue;
        }

        if (trimmed.startsWith('- name:')) {
          if (currentTpCommand) {
            if (currentTpProfile) {
              (targetProjectProfiles[currentTpProfile] ??= []).push(currentTpCommand);
            } else {
              targetProjectCommands.push(currentTpCommand);
            }
          }
          currentTpCommand = { name: trimmed.slice(7).trim(), run: '', timeoutSec: undefined };
          currentTpCommandIndent = indent;
          continue;
        }

        if (trimmed.startsWith('run:')) {
          const raw = trimmed.slice(4).trim();
          const header = parseBlockScalarHeader(raw);
          if (header) {
            const block = readBlockScalar(lines, i, indent, header);
            if (block) {
              if (currentTpCommand) currentTpCommand.run = block.value;
              i = block.nextIndex - 1;
              continue;
            }
          }
          if (currentTpCommand) {
            currentTpCommand.run = stripSurroundingQuotes(raw);
          }
          continue;
        }

        if (trimmed.startsWith('timeoutSec:')) {
          // 缩进比命令项更深 → 该命令专属；否则忽略（targetProject.gate 没有全局超时）
          if (currentTpCommand && currentTpCommand.run && indent > currentTpCommandIndent) {
            currentTpCommand.timeoutSec = Number.parseInt(trimmed.slice(11).trim(), 10) || undefined;
          }
          continue;
        }

        // phase：门禁命令的阶段（ZD-009）—— 与主 gate 段同一口径。
        if (trimmed.startsWith('phase:')) {
          const raw = trimmed.slice(6).trim().toLowerCase();
          if (currentTpCommand && indent > currentTpCommandIndent) {
            if (!GATE_PHASES.includes(raw)) {
              throw new Error(
                `targetProject.gate 的命令 "${currentTpCommand.name}" 的 phase: "${raw}" 不认识。` +
                `可用值：${GATE_PHASES.join(' / ')}`,
              );
            }
            currentTpCommand.phase = raw as GatePhase;
          }
          continue;
        }
      }
    }
  }

  if (currentCommand) {
    if (currentProfile) {
      (profiles[currentProfile] ??= []).push(currentCommand);
    } else {
      commands.push(currentCommand);
    }
  }

  // scope: 段如果到文件末尾还没结算，在这里补一次 ——
  // 漏结算的后果是「配了作用域却按全量跑」（配置静默失效）。
  if (inScopeSection) {
    inScopeSection = false;
    const scopeCfg = parseScopeConfig(scopeBlockLines.join('\n'));
    if (scopeCfg) gateScope = scopeCfg;
    scopeBlockLines = [];
  }

  // Flush pending targetProject command
  if (currentTpCommand) {
    if (currentTpProfile) {
      (targetProjectProfiles[currentTpProfile] ??= []).push(currentTpCommand);
    } else {
      targetProjectCommands.push(currentTpCommand);
    }
  }

  const pricingKeys = Object.keys(llmPricing);
  // The llm section is kept as long as it carries any of its own fields.
  // The apiKey may come from the environment (ADR-022), so requiring
  // `provider && apiKey` here would drop baseUrl/model/pricing along with it.
  const hasLlm = Boolean(llmProvider || llmApiKey || llmModel || llmBaseUrl || pricingKeys.length > 0);
  const llm = hasLlm
    ? {
        provider: llmProvider,
        apiKey: llmApiKey,
        ...(llmModel ? { model: llmModel } : {}),
        ...(llmBaseUrl ? { baseUrl: llmBaseUrl } : {}),
        ...(pricingKeys.length > 0 ? { pricing: llmPricing } : {}),
      }
    : undefined;

  // 切片级验收配置（ADR-033）：只有在 command 非空时才生效。
  // 「配了 acceptance 段但没写 command」等于没配 —— 宁可退回默认行为，
  // 也不要拿一个空命令去跑门禁（那必然失败，失败原因还会误导人）。
  const acceptance: GateAcceptanceConfig | undefined = acceptanceCommand
    ? {
        command: acceptanceCommand,
        required: acceptanceRequired,
        ...(acceptanceTimeoutSec !== undefined ? { timeoutSec: acceptanceTimeoutSec } : {}),
        ...(acceptanceBuildDir !== undefined ? { buildDir: acceptanceBuildDir } : {}),
      }
    : undefined;

  const gate = commands.length > 0
    ? {
        commands,
        ...(Object.keys(profiles).length > 0 ? { profiles } : {}),
        ...(acceptance ? { acceptance } : {}),
        ...(gateScope ? { scope: gateScope } : {}),
        timeoutSec,
        ...(submoduleCheck !== undefined ? { submoduleCheck } : {}),
        retry: { max: retryMax },
      }
    : {
        commands: [],
        ...(acceptance ? { acceptance } : {}),
        ...(gateScope ? { scope: gateScope } : {}),
        timeoutSec: 120,
        retry: { max: 2 },
      };

  const targetProject = targetProjectPath
    ? {
        path: targetProjectPath,
        ...(targetProjectSpecDir ? { specDir: targetProjectSpecDir } : {}),
        ...(targetProjectCommands.length > 0 || Object.keys(targetProjectProfiles).length > 0
          ? {
              gate: {
                commands: targetProjectCommands,
                ...(Object.keys(targetProjectProfiles).length > 0 ? { profiles: targetProjectProfiles } : {}),
              },
            }
          : {}),
      }
    : undefined;

  const web =
    webMaxConcurrentRuns !== undefined || webLaunchTimeoutMs !== undefined
      ? {
          ...(webMaxConcurrentRuns !== undefined ? { maxConcurrentRuns: webMaxConcurrentRuns } : {}),
          ...(webLaunchTimeoutMs !== undefined ? { launchTimeoutMs: webLaunchTimeoutMs } : {}),
        }
      : undefined;

  // worktree 准备段（ADR-095 §3.2）。
  //
  // 「配了 prepare 段但一条命令都没有」= 没配 —— 不产生 `worktree` 字段，
  // 免得下游以为「配了但清单是空的」是个错误配置。
  const worktree =
    worktreePrepareCommands.length > 0
      ? { prepare: { commands: worktreePrepareCommands } }
      : undefined;

  return commands.length > 0 || Object.keys(profiles).length > 0 || acceptance || llm || targetProject || web || worktree || haltTtlSec !== undefined || budgetLimitUsd !== undefined
    ? {
        gate,
        agent: {
          command: agentCommand,
          ...(agentAdapter ? { adapter: agentAdapter } : {}),
          ...(agentTimeout ? { timeout: agentTimeout } : {}),
          ...(agentMaxRetries !== undefined ? { maxRetries: agentMaxRetries } : {}),
          ...(agentStreamJson ? { streamJson: true } : {}),
          ...(agentModel ? { model: agentModel } : {}),
          ...(Object.keys(agentEnv).length > 0 ? { env: { ...agentEnv } } : {}),
          ...(agentCursorEndpoint || agentCursorApiKeyEnv
            ? {
                cursor: {
                  ...(agentCursorEndpoint ? { endpoint: agentCursorEndpoint } : {}),
                  ...(agentCursorApiKeyEnv ? { apiKeyEnv: agentCursorApiKeyEnv } : {}),
                },
              }
            : {}),
        },
        ...(web ? { web } : {}),
        ...(worktree ? { worktree } : {}),
        // 拉闸默认 TTL（秒）。`0` = 永不过期。
        ...(haltTtlSec !== undefined ? { haltTtlSec } : {}),
        // 预算上限（美元）。`0` = 不限。
        ...(budgetLimitUsd !== undefined ? { budgetLimitUsd } : {}),
        llm,
        ...(targetProject ? { targetProject } : {}),
      }
    : null;
}
