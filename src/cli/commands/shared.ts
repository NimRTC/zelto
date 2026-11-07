// Shared utilities, types, and store instances for CLI commands

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { LlmAdapter } from '../../core/ports/llm.js';
import type { ExecutorAdapter } from '../../core/ports/executor.js';
import { DeepSeekAdapter } from '../../adapters/llm/index.js';
import { EventEmittingLlmAdapter, type PricingTable } from '../../adapters/llm/event-emitting-adapter.js';
import { ClaudeAgentAdapter } from '../../adapters/claude-agent/index.js';
import { ClaudeAgentSdkAdapter } from '../../adapters/claude-agent-sdk/index.js';
import { EventStream } from '../../core/events/stream.js';
import type { PolicyConfig, PolicyRule } from '../../core/policy/types.js';
import { parsePolicyYaml, stripSurroundingQuotes } from '../../core/policy/yaml.js';
import type { GateAcceptanceConfig } from '../../core/gate/types.js';
import { SliceStore } from '../../core/slice/store.js';
import { WorktreeManager, type WorktreeInfo } from '../../core/worktree/index.js';
import { buildDeterministicSliceSpec } from '../../llm/generators/slice-spec.js';

// 策略解析的唯一实现在 core/policy/yaml.ts（ADR-014 §4）。
// 这里转出去是为了不破坏既有调用方。
export { parsePolicyYaml } from '../../core/policy/yaml.js';

// ─── Constants ───────────────────────────────────────────────────────────────

export const ZELTO_DIR = '.zelto';
export const SLICES_DIR = join(ZELTO_DIR, 'slices');
export const EVENTS_DIR = join(ZELTO_DIR, 'events');

// ─── Shared Instances ────────────────────────────────────────────────────────

export const store = new SliceStore(SLICES_DIR);
export const events = new EventStream(EVENTS_DIR);

// ─── Types ───────────────────────────────────────────────────────────────────

export type Command = (args: string[]) => Promise<number>;

// ─── Command Registry ────────────────────────────────────────────────────────

export const commands: Record<string, Command> = {};

export function register(name: string, fn: Command) {
  commands[name] = fn;
}

// ─── Policy Config ───────────────────────────────────────────────────────────

export function loadPolicyConfig(root?: string): PolicyConfig {
  const policyPath = join(root ?? process.cwd(), 'policy', 'policy.yaml');
  if (existsSync(policyPath)) {
    try {
      const content = readFileSync(policyPath, 'utf-8');
      const parsed = parsePolicyYaml(content);
      if (parsed.rules.length > 0) {
        return {
          rules: parsed.rules,
          protected: ['policy/**', '.zelto/**', 'AGENTS.md', '.cursor/rules/**'],
          ...(parsed.arch ? { arch: parsed.arch } : {}),
        };
      }
    } catch {
      // Fall through to defaults
    }
  }

  return {
    rules: [
      {
        id: 'allow-src-ts',
        match: { path: 'src/**/*.ts', operation: 'write' },
        action: 'allow',
        basis: 'policy.yaml#allow-src-ts',
      },
      {
        id: 'allow-tests',
        match: { path: 'tests/**/*.ts', operation: 'write' },
        action: 'allow',
        basis: 'policy.yaml#allow-tests',
      },
      {
        id: 'allow-read-all',
        match: { path: '**', operation: 'read' },
        action: 'allow',
        basis: 'policy.yaml#allow-read-all',
        priority: 0,
      },
      {
        id: 'allow-docs',
        match: { path: 'docs/**', operation: 'write' },
        action: 'allow',
        basis: 'policy.yaml#allow-docs',
      },
      {
        id: 'allow-config',
        match: { path: '.zelto/config.yaml', operation: 'write' },
        action: 'ask',
        basis: 'policy.yaml#allow-config',
      },
      {
        id: 'deny-acceptance-direct',
        match: { path: 'tests/acceptance/**', operation: 'write' },
        action: 'deny',
        basis: 'AGENTS.md#禁区-5',
        guidance: 'Acceptance tests are frozen with the spec.',
      },
    ],
    protected: ['policy/**', '.zelto/**', 'AGENTS.md', '.cursor/rules/**'],
  };
}

// ─── Spec Hash ───────────────────────────────────────────────────────────────

export function hashSpecFile(specPath: string): string | null {
  try {
    const content = readFileSync(specPath, 'utf-8');
    return `sha256:${createHash('sha256').update(content).digest('hex')}`;
  } catch {
    return null;
  }
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface ZeltoConfig {
  gate: {
    commands: Array<{ name: string; run: string; timeoutSec?: number }>;
    profiles?: Record<string, Array<{ name: string; run: string; timeoutSec?: number }>>;
    /** 切片级验收配置（ADR-033）。没配就退回到「跑该片的验收目录」。 */
    acceptance?: GateAcceptanceConfig;
    timeoutSec: number;
    retry: { max: number };
  };
  agent: { command: string; adapter?: string; timeout?: number; maxRetries?: number };
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

export function loadConfig(): ZeltoConfig {
  const configPath = join(ZELTO_DIR, 'config.yaml');
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
  let llmProvider = '';
  let llmApiKey = '';
  let llmModel = '';
  let llmBaseUrl = '';
  let inLlmPricingSection = false;
  let currentPricingModel = '';
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
  for (const line of lines) {
    const trimmed = line.trim();
    const indent = line.length - trimmed.length;
    if (trimmed.startsWith('#') || trimmed === '') continue;

    if (trimmed === 'gate:' && !inTargetProjectSection) {
      inGateSection = true;
      inAgentSection = false;
      inLlmSection = false;
      inProfileSection = false;
      currentProfile = null;
      continue;
    }
    if (trimmed === 'agent:' && !inTargetProjectSection) {
      inAgentSection = true;
      inGateSection = false;
      inLlmSection = false;
      inProfileSection = false;
      currentProfile = null;
      continue;
    }
    if (trimmed === 'llm:' && !inTargetProjectSection) {
      inLlmSection = true;
      inGateSection = false;
      inAgentSection = false;
      inTargetProjectSection = false;
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
          acceptanceCommand = stripSurroundingQuotes(trimmed.slice(8).trim());
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
        if (currentCommand) {
          currentCommand.run = stripSurroundingQuotes(trimmed.slice(4).trim());
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

      if (trimmed.startsWith('max:')) {
        retryMax = Number.parseInt(trimmed.slice(4).trim(), 10) || 2;
        continue;
      }
    }

    if (inAgentSection && trimmed.startsWith('command:')) {
      agentCommand = stripSurroundingQuotes(trimmed.slice(8).trim());
    }

    if (inAgentSection && trimmed.startsWith('adapter:')) {
      agentAdapter = stripSurroundingQuotes(trimmed.slice(8).trim());
    }

    if (inAgentSection && trimmed.startsWith('timeout:')) {
      agentTimeout = Number.parseInt(trimmed.slice(8).trim(), 10) || undefined;
    }

    if (inAgentSection && trimmed.startsWith('maxRetries:')) {
      agentMaxRetries = Number.parseInt(trimmed.slice(11).trim(), 10) || undefined;
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
          if (currentTpCommand) {
            currentTpCommand.run = stripSurroundingQuotes(trimmed.slice(4).trim());
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

  return commands.length > 0 || Object.keys(profiles).length > 0 || acceptance || llm || targetProject
    ? {
        gate,
        agent: { command: agentCommand, ...(agentAdapter ? { adapter: agentAdapter } : {}), ...(agentTimeout ? { timeout: agentTimeout } : {}), ...(agentMaxRetries !== undefined ? { maxRetries: agentMaxRetries } : {}) },
        llm,
        ...(targetProject ? { targetProject } : {}),
      }
    : null;
}

/**
 * Resolve the target project directory if configured.
 * Returns the absolute path to the target project root, or null if not configured.
 * When a target project is configured, this is the directory where gate commands
 * and spec operations should execute.
 */
export function resolveTargetDir(): string | null {
  const cfg = loadConfig();
  if (!cfg.targetProject?.path) return null;
  const resolved = resolve(process.cwd(), cfg.targetProject.path);
  return existsSync(resolved) ? resolved : null;
}

/**
 * Get the spec directory for the target project, or the default.
 * Returns the absolute path.
 */
export function resolveSpecDir(): string {
  const cfg = loadConfig();
  if (cfg.targetProject?.path) {
    const projectDir = resolve(process.cwd(), cfg.targetProject.path);
    const specDir = cfg.targetProject.specDir ?? 'specs/slices';
    return resolve(projectDir, specDir);
  }
  return resolve(process.cwd(), 'specs', 'slices');
}

// ─── Worktree Helpers ─────────────────────────────────────────────────────────

/**
 * Shared worktree manager rooted at the current working directory.
 * Path convention: `.zelto/worktrees/<sliceId>`, branch `slice/<sliceId>`.
 */
export function worktreeManager(): WorktreeManager {
  return new WorktreeManager(process.cwd());
}

/**
 * Return the absolute path of a slice's worktree if it exists, else null.
 * Used by gate / diff / merge paths that must operate inside the isolated directory.
 */
export function existingWorktreePath(sliceId: string): string | null {
  const manager = worktreeManager();
  return manager.exists(sliceId) ? manager.pathFor(sliceId) : null;
}

/**
 * Remove a slice's worktree and write a `worktree.removed` event (C4).
 * Never swallows errors — the caller decides how to report them.
 */
export async function removeWorktree(sliceId: string, options: { force?: boolean } = {}): Promise<void> {
  const manager = worktreeManager();
  await manager.remove(sliceId, options);
  await events.append(sliceId, 'worktree.removed', 'zelto', {
    sliceId,
    path: manager.relativePathFor(sliceId),
    branch: manager.branchFor(sliceId),
  });
}

/**
 * Create (or reuse) the isolated worktree for a slice.
 *
 * Returns null when the current directory is not inside a git repository —
 * worktree isolation is then impossible, and the caller degrades to running
 * in the current directory (same behaviour as before isolation existed).
 *
 * Emits a `worktree.created` event (C4) when a new worktree is created.
 */
export async function ensureWorktree(id: string): Promise<WorktreeInfo | null> {
  const manager = worktreeManager();
  if (!manager.isGitRepo()) return null;

  const slice = await store.read(id);

  const existed = manager.exists(id);
  const info = await manager.create(id, {
    baseCommit: slice.baseCommit ?? null,
    specPath: slice.spec.path,
    acceptanceDir: slice.acceptance.dir,
  });

  if (!existed) {
    await events.append(id, 'worktree.created', 'zelto', {
      sliceId: id,
      path: info.relativePath,
      branch: info.branch,
      baseCommit: info.baseCommit,
    });
  }

  return info;
}

// ─── Policy YAML Parser ─────────────────────────────────────────────────────
// 实现已收敛到 core/policy/yaml.ts；此处保留转出以兼容既有调用方。

// ─── LLM Helper ──────────────────────────────────────────────────────────────

export function createLlmFromConfig(
  sliceId?: string,
  actor?: string,
): LlmAdapter | null {
  const cfg = loadConfig();
  if (!cfg.llm?.apiKey) return null;
  const adapter: LlmAdapter = new DeepSeekAdapter({
    apiKey: cfg.llm.apiKey,
    baseUrl: cfg.llm.baseUrl,
    model: cfg.llm.model ?? 'deepseek-chat',
  });

  // Wrap with event-emitting adapter if tracking context is provided
  if (sliceId && actor) {
    const pricing = cfg.llm.pricing as PricingTable | undefined;
    return new EventEmittingLlmAdapter(adapter, events, sliceId, actor, pricing);
  }

  return adapter;
}

// ─── Executor Adapter Factory ──────────────────────────────────────────────

export type AdapterType = 'claude-agent' | 'claude-agent-sdk';

/**
 * Create an executor adapter based on config and optional override.
 * @param overrideType — Optional override from CLI --adapter flag
 * @param agentCommand — Agent command string (for claude-agent adapter)
 * @param timeoutSec — Optional agent timeout in seconds (from slice or config)
 * @param cwd — Optional working directory (e.g. an isolated worktree). Defaults to process.cwd().
 */
export function createExecutorAdapter(
  overrideType?: string,
  agentCommand?: string,
  timeoutSec?: number,
  cwd?: string,
): ExecutorAdapter {
  const cfg = loadConfig();
  const type = (overrideType ?? cfg.agent.adapter ?? 'claude-agent') as AdapterType;
  const timeoutMs = (timeoutSec ?? cfg.agent.timeout ?? 900) * 1000;
  const workDir = cwd ?? process.cwd();

  if (type === 'claude-agent-sdk') {
    return new ClaudeAgentSdkAdapter({
      cwd: workDir,
      model: cfg.llm?.model,
      env: process.env as Record<string, string>,
    });
  }

  // Default: claude-agent (shell spawn)
  return new ClaudeAgentAdapter({
    cwd: workDir,
    agentCommand: agentCommand ?? cfg.agent.command,
    timeoutMs,
  });
}

// ─── Slice Spec Generator ────────────────────────────────────────────────────

/**
 * 生成一份切片规格正文（**确定性降级路径**）。
 *
 * 内容的唯一实现在 `src/llm/generators/slice-spec.ts`（ADR-034）。
 * 这里的薄壳保留是为了兼容既有调用方与测试。
 *
 * 注意：这条路径产出的规格**不含任何自造的验收标准** —— 没有已批准的
 * 需求条目时，验收标准章节只留占位说明（不写编号条目）。
 * 写了编号条目就会被物化成本片的需求追溯，于是「追溯合格」变成
 * zelto 替人批准的需求（ADR-032 §4 方案四）。
 */
export function generateSliceSpecContent(
  sliceId: string,
  title: string,
  module: string,
  writes: string[],
  version: string,
): string {
  return buildDeterministicSliceSpec({
    sliceId,
    title,
    module,
    writes,
    version,
    requirements: [],
    prerequisites: [],
  });
}
