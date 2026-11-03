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
import type { Decision, PolicyConfig, PolicyRule } from '../../core/policy/types.js';
import { SliceStore } from '../../core/slice/store.js';
import { WorktreeManager, type WorktreeInfo } from '../../core/worktree/index.js';

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

export function loadPolicyConfig(): PolicyConfig {
  const policyPath = join('policy', 'policy.yaml');
  if (existsSync(policyPath)) {
    try {
      const content = readFileSync(policyPath, 'utf-8');
      const parsed = parsePolicyYaml(content);
      if (parsed.rules.length > 0) {
        return {
          rules: parsed.rules,
          protected: ['policy/**', '.zelto/**', 'AGENTS.md', '.cursor/rules/**'],
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
    timeoutSec: number;
    retry: { max: number };
  };
  agent: { command: string; adapter?: string; timeout?: number; maxRetries?: number };
  llm?: { provider: string; apiKey: string; baseUrl?: string; model?: string; pricing?: Record<string, { inputPer1k: number; outputPer1k: number }> };
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

  if (!existsSync(configPath)) return defaultConfig;

  try {
    const content = readFileSync(configPath, 'utf-8');
    const parsed = parseConfigYaml(content);
    if (parsed) {
      // Validate config and warn about common issues
      validateConfig(parsed);
      return {
        gate: parsed.gate,
        agent: parsed.agent ?? defaultConfig.agent,
        llm: parsed.llm,
        targetProject: parsed.targetProject,
      };
    }
    return defaultConfig;
  } catch {
    return defaultConfig;
  }
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
  if (config.llm?.apiKey && config.llm.apiKey === 'sk-your-key-here') {
    console.warn('  ⚠️  Config: LLM API key appears to be a placeholder. Update .zelto/config.yaml with a real key.');
  }
}

/**
 * Strip surrounding double quotes from a string, but only if they wrap the entire value.
 * Preserves embedded quotes inside the string.
 * E.g. '"npx claude-code"' → 'npx claude-code'
 *      'echo "hello"' → 'echo "hello"' (no change)
 */
function stripSurroundingQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1);
  }
  return s;
}

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
  const llm = llmProvider && llmApiKey
    ? {
        provider: llmProvider,
        apiKey: llmApiKey,
        ...(llmModel ? { model: llmModel } : {}),
        ...(llmBaseUrl ? { baseUrl: llmBaseUrl } : {}),
        ...(pricingKeys.length > 0 ? { pricing: llmPricing } : {}),
      }
    : undefined;

  const gate = commands.length > 0
    ? {
        commands,
        ...(Object.keys(profiles).length > 0 ? { profiles } : {}),
        timeoutSec,
        retry: { max: retryMax },
      }
    : { commands: [], timeoutSec: 120, retry: { max: 2 } };

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

  return commands.length > 0 || Object.keys(profiles).length > 0 || llm || targetProject
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

export function parsePolicyYaml(content: string): { rules: PolicyRule[] } {
  const rules: PolicyRule[] = [];
  let currentRule: Record<string, unknown> | null = null;

  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '') continue;

    if (trimmed.startsWith('- id:')) {
      if (currentRule?.id) rules.push(currentRule as unknown as PolicyRule);
      currentRule = { id: trimmed.slice(5).trim(), match: {} };
      continue;
    }

    if (!currentRule) continue;

    const matchInline = trimmed.match(
      /^match:\s*\{\s*path:\s*"([^"]*)"\s*(?:,\s*operation:\s*"([^"]*)")?\s*\}/,
    );
    if (matchInline) {
      currentRule.match = {
        path: matchInline[1],
        ...(matchInline[2] ? { operation: matchInline[2] } : {}),
      };
      continue;
    }

    if (trimmed.startsWith('path:')) {
      currentRule.match = {
        ...(currentRule.match as Record<string, unknown>),
        path: stripSurroundingQuotes(trimmed.slice(5).trim()),
      };
      continue;
    }

    if (trimmed.startsWith('operation:')) {
      currentRule.match = {
        ...(currentRule.match as Record<string, unknown>),
        operation: stripSurroundingQuotes(trimmed.slice(10).trim()),
      };
      continue;
    }

    if (trimmed.startsWith('action:')) {
      currentRule.action = trimmed.slice(7).trim() as Decision;
      continue;
    }

    if (trimmed.startsWith('basis:')) {
      currentRule.basis = stripSurroundingQuotes(trimmed.slice(6).trim());
      continue;
    }

    if (trimmed.startsWith('guidance:')) {
      currentRule.guidance = stripSurroundingQuotes(trimmed.slice(9).trim());
      continue;
    }

    if (trimmed.startsWith('priority:')) {
      currentRule.priority = Number.parseInt(trimmed.slice(9).trim(), 10);
    }
  }

  if (currentRule?.id) rules.push(currentRule as unknown as PolicyRule);
  return { rules };
}

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

export function generateSliceSpecContent(
  sliceId: string,
  title: string,
  module: string,
  writes: string[],
  version: string,
): string {
  return [
    `# Slice: ${sliceId}`,
    '',
    '## 目的',
    `版本 ${version} — ${title}`,
    '',
    '## 范围',
    ...writes.map((w) => `- \`${w}\``),
    '',
    '## 验收标准',
    `1. 完成 ${title}`,
    '2. 全部测试通过',
    '',
    '## 风险',
    '- 无',
    '',
  ].join('\n');
}
