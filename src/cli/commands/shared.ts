// Shared utilities, types, and store instances for CLI commands

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LlmAdapter } from '../../core/ports/llm.js';
import type { ExecutorAdapter } from '../../core/ports/executor.js';
import { DeepSeekAdapter } from '../../adapters/llm/index.js';
import { ClaudeAgentAdapter } from '../../adapters/claude-agent/index.js';
import { ClaudeAgentSdkAdapter } from '../../adapters/claude-agent-sdk/index.js';
import { EventStream } from '../../core/events/stream.js';
import type { Decision, PolicyConfig, PolicyRule } from '../../core/policy/types.js';
import { SliceStore } from '../../core/slice/store.js';

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
  agent: { command: string; adapter?: string; timeout?: number };
  llm?: { provider: string; apiKey: string; baseUrl?: string; model?: string };
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

export function parseConfigYaml(content: string): ZeltoConfig | null {
  const commands: Array<{ name: string; run: string; timeoutSec?: number }> = [];
  const profiles: Record<string, Array<{ name: string; run: string; timeoutSec?: number }>> = {};
  let timeoutSec = 120;
  let retryMax = 2;
  let agentCommand = 'npx claude-code';
  let agentAdapter = '';
  let agentTimeout: number | undefined;
  let currentCommand: { name: string; run: string; timeoutSec?: number } | null = null;
  let inGateSection = false;
  let inAgentSection = false;
  let inLlmSection = false;
  let inProfileSection = false;
  let currentProfile: string | null = null;
  let llmProvider = '';
  let llmApiKey = '';
  let llmModel = '';
  let llmBaseUrl = '';

  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '') continue;

    if (trimmed === 'gate:') {
      inGateSection = true;
      inAgentSection = false;
      inLlmSection = false;
      inProfileSection = false;
      currentProfile = null;
      continue;
    }
    if (trimmed === 'agent:') {
      inAgentSection = true;
      inGateSection = false;
      inLlmSection = false;
      inProfileSection = false;
      currentProfile = null;
      continue;
    }
    if (trimmed === 'llm:') {
      inLlmSection = true;
      inGateSection = false;
      inAgentSection = false;
      inProfileSection = false;
      currentProfile = null;
      continue;
    }

    if (inGateSection) {
      // Detect profile section (indented key with list value)
      const profileMatch = trimmed.match(/^(\w+):$/);
      if (profileMatch && profileMatch[1] !== 'commands' && profileMatch[1] !== 'timeoutSec' && profileMatch[1] !== 'retry') {
        inProfileSection = true;
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
        continue;
      }

      if (trimmed.startsWith('run:')) {
        if (currentCommand) {
          currentCommand.run = trimmed.slice(4).trim().replace(/^"|"$/g, '');
        }
        continue;
      }

      // Per-command timeout (indented under a command item)
      if (trimmed.startsWith('timeoutSec:')) {
        if (currentCommand && currentCommand.run) {
          // Per-command timeout
          currentCommand.timeoutSec = Number.parseInt(trimmed.slice(11).trim(), 10) || undefined;
        } else {
          // Global timeout
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
      agentCommand = trimmed.slice(8).trim().replace(/^"|"$/g, '');
    }

    if (inAgentSection && trimmed.startsWith('adapter:')) {
      agentAdapter = trimmed.slice(8).trim().replace(/^"|"$/g, '');
    }

    if (inAgentSection && trimmed.startsWith('timeout:')) {
      agentTimeout = Number.parseInt(trimmed.slice(8).trim(), 10) || undefined;
    }

    if (inLlmSection) {
      if (trimmed.startsWith('provider:')) {
        llmProvider = trimmed.slice(9).trim().replace(/^"|"$/g, '');
      } else if (trimmed.startsWith('apiKey:')) {
        llmApiKey = trimmed.slice(7).trim().replace(/^"|"$/g, '');
      } else if (trimmed.startsWith('model:')) {
        llmModel = trimmed.slice(6).trim().replace(/^"|"$/g, '');
      } else if (trimmed.startsWith('baseUrl:')) {
        llmBaseUrl = trimmed.slice(8).trim().replace(/^"|"$/g, '');
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

  // Push the last profile's last command if we ended in a profile
  // (already handled above since we push on next command or end)

  const llm = llmProvider && llmApiKey
    ? { provider: llmProvider, apiKey: llmApiKey, ...(llmModel ? { model: llmModel } : {}), ...(llmBaseUrl ? { baseUrl: llmBaseUrl } : {}) }
    : undefined;

  const gate = commands.length > 0
    ? {
        commands,
        ...(Object.keys(profiles).length > 0 ? { profiles } : {}),
        timeoutSec,
        retry: { max: retryMax },
      }
    : { commands: [], timeoutSec: 120, retry: { max: 2 } };

  return commands.length > 0 || Object.keys(profiles).length > 0 || llm
    ? {
        gate,
        agent: { command: agentCommand, ...(agentAdapter ? { adapter: agentAdapter } : {}), ...(agentTimeout ? { timeout: agentTimeout } : {}) },
        llm,
      }
    : null;
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
        path: trimmed.slice(5).trim().replace(/^"|"$/g, ''),
      };
      continue;
    }

    if (trimmed.startsWith('operation:')) {
      currentRule.match = {
        ...(currentRule.match as Record<string, unknown>),
        operation: trimmed.slice(10).trim().replace(/^"|"$/g, ''),
      };
      continue;
    }

    if (trimmed.startsWith('action:')) {
      currentRule.action = trimmed.slice(7).trim() as Decision;
      continue;
    }

    if (trimmed.startsWith('basis:')) {
      currentRule.basis = trimmed.slice(6).trim().replace(/^"|"$/g, '');
      continue;
    }

    if (trimmed.startsWith('guidance:')) {
      currentRule.guidance = trimmed.slice(9).trim().replace(/^"|"$/g, '');
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

export function createLlmFromConfig(): LlmAdapter | null {
  const cfg = loadConfig();
  if (!cfg.llm?.apiKey) return null;
  return new DeepSeekAdapter({
    apiKey: cfg.llm.apiKey,
    baseUrl: cfg.llm.baseUrl,
    model: cfg.llm.model ?? 'deepseek-chat',
  });
}

// ─── Executor Adapter Factory ──────────────────────────────────────────────

export type AdapterType = 'claude-agent' | 'claude-agent-sdk';

/**
 * Create an executor adapter based on config and optional override.
 * @param overrideType — Optional override from CLI --adapter flag
 * @param agentCommand — Agent command string (for claude-agent adapter)
 * @param timeoutSec — Optional agent timeout in seconds (from slice or config)
 */
export function createExecutorAdapter(
  overrideType?: string,
  agentCommand?: string,
  timeoutSec?: number,
): ExecutorAdapter {
  const cfg = loadConfig();
  const type = (overrideType ?? cfg.agent.adapter ?? 'claude-agent') as AdapterType;
  const timeoutMs = (timeoutSec ?? cfg.agent.timeout ?? 900) * 1000;

  if (type === 'claude-agent-sdk') {
    return new ClaudeAgentSdkAdapter({
      cwd: process.cwd(),
      model: cfg.llm?.model,
      env: process.env as Record<string, string>,
    });
  }

  // Default: claude-agent (shell spawn)
  return new ClaudeAgentAdapter({
    cwd: process.cwd(),
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
