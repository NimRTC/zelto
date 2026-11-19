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
import type { GateAcceptanceConfig } from '../gate/types.js';
import { stripSurroundingQuotes } from '../policy/yaml.js';
import { parseBlockScalarHeader, readBlockScalar } from './blocks.js';

/** `.zelto` 目录名 —— 与 CLI 的 ZELTO_DIR 同值。 */
export const ZELTO_DIR_NAME = '.zelto';


export interface ZeltoConfig {
  gate: {
    commands: Array<{ name: string; run: string; timeoutSec?: number }>;
    profiles?: Record<string, Array<{ name: string; run: string; timeoutSec?: number }>>;
    /** 切片级验收配置（ADR-033）。没配就退回到「跑该片的验收目录」。 */
    acceptance?: GateAcceptanceConfig;
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
  };
  llm?: { provider: string; apiKey?: string; baseUrl?: string; model?: string; pricing?: Record<string, { inputPer1k: number; outputPer1k: number }> };
  /** External project configuration for cross-repo workflows.
   *  When set, `zelto gate` and `zelto slice create` operate in the
   *  target project directory instead of the current working directory. */
  targetProject?: {
    /** Absolute or relative path to the target project root. */
    path: string;
    /** Optional gate overrides for the target project. Falls back to
     *  the root gate.commands when not specified. */
    gate?: {
      commands: Array<{ name: string; run: string; timeoutSec?: number }>;
      profiles?: Record<string, Array<{ name: string; run: string; timeoutSec?: number }>>;
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
  const commands: Array<{ name: string; run: string; timeoutSec?: number }> = [];
  const profiles: Record<string, Array<{ name: string; run: string; timeoutSec?: number }>> = {};
  let timeoutSec = 120;
  let retryMax = 2;
  let agentCommand = 'npx claude-code';
  let agentAdapter = '';
  let agentTimeout: number | undefined;
  let agentMaxRetries: number | undefined;
  // agent 段的嵌套节（ADR-090）—— 需要跟缩进，否则会把 agent 顶层的
  // timeout: / maxRetries: 误吞成 env 的键
  let inAgentEnvSection = false;
  let agentEnvIndent = 0;
  const agentEnv: Record<string, string> = {};
  let inAgentCursorSection = false;
  let agentCursorIndent = 0;
  let agentCursorEndpoint: string | undefined;
  let agentCursorApiKeyEnv: string | undefined;
  let currentCommand: { name: string; run: string; timeoutSec?: number } | null = null;
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
  const llmPricing: Record<string, { inputPer1k: number; outputPer1k: number }> = {};
  let targetProjectPath = '';
  let targetProjectSpecDir = '';
  let targetProjectDepth = 0;
  const targetProjectCommands: Array<{ name: string; run: string; timeoutSec?: number }> = [];
  const targetProjectProfiles: Record<string, Array<{ name: string; run: string; timeoutSec?: number }>> = {};
  let currentTpCommand: { name: string; run: string; timeoutSec?: number } | null = null;
  /** 缩进层级：区分命令自身的 timeoutSec 与上层配置 */
  let currentTpCommandIndent = 0;
  let inTpProfileSection = false;
  let currentTpProfile: string | null = null;

  const lines = content.split('\n');
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
        timeoutSec,
        ...(submoduleCheck !== undefined ? { submoduleCheck } : {}),
        retry: { max: retryMax },
      }
    : { commands: [], ...(acceptance ? { acceptance } : {}), timeoutSec: 120, retry: { max: 2 } };

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

  const web = webMaxConcurrentRuns !== undefined ? { maxConcurrentRuns: webMaxConcurrentRuns } : undefined;

  return commands.length > 0 || Object.keys(profiles).length > 0 || acceptance || llm || targetProject || web
    ? {
        gate,
        agent: {
          command: agentCommand,
          ...(agentAdapter ? { adapter: agentAdapter } : {}),
          ...(agentTimeout ? { timeout: agentTimeout } : {}),
          ...(agentMaxRetries !== undefined ? { maxRetries: agentMaxRetries } : {}),
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
        llm,
        ...(targetProject ? { targetProject } : {}),
      }
    : null;
}
