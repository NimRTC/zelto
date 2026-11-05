// Config command — view and modify zelto configuration
// Usage: zelto config [get|set] [key] [value]

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { register, ZELTO_DIR, loadConfig } from './shared.js';

register('config', async (args) => {
  const subcmd = args[0];

  // `zelto config --help` — usage only. `zelto config` with no subcommand
  // falls through to the "show configuration" branch at the bottom.
  if (subcmd === '--help' || subcmd === '-h') {
    console.log(`
Usage:
  zelto config              Show current configuration
  zelto config get <key>    Get a specific config value (dot-separated, e.g. "gate.timeoutSec")
  zelto config set <key> <value>  Set a config value

Examples:
  zelto config
  zelto config get gate.timeoutSec
  zelto config get llm.apiKey --raw
  zelto config set gate.timeoutSec 300
  zelto config set agent.command "npx claude-code"

Secrets are masked by default. "zelto config get llm.apiKey --raw" prints the
real value — use it only when a script needs the actual credential.
    `);
    return 0;
  }

  const configPath = join(ZELTO_DIR, 'config.yaml');

  if (subcmd === 'get') {
    const key = args[1];
    if (!key) {
      console.error('Usage: zelto config get <key>');
      return 1;
    }
    // Secrets are masked unless --raw is passed. Printing a live credential to
    // the terminal is a leak vector; scripts that genuinely need the value can
    // opt in explicitly.
    const raw = args.includes('--raw');
    const cfg = loadConfig();
    const parts = key.split('.');
    let val: unknown = cfg as unknown as Record<string, unknown>;
    for (const part of parts) {
      if (val && typeof val === 'object') {
        val = (val as Record<string, unknown>)[part];
      } else {
        val = undefined;
        break;
      }
    }
    if (val === undefined) {
      console.error(`Config key "${key}" not found.`);
      return 1;
    }
    if (!raw && isSecretKey(key) && typeof val === 'string' && val.length > 0) {
      console.log(maskSecret(val));
      return 0;
    }
    console.log(typeof val === 'string' ? val : JSON.stringify(val, null, 2));
    return 0;
  }

  if (subcmd === 'set') {
    const key = args[1];
    const value = args.slice(2).join(' ');
    if (!key || !value) {
      console.error('Usage: zelto config set <key> <value>');
      return 1;
    }

    if (!existsSync(configPath)) {
      console.error('Config file not found. Run "zelto init" first.');
      return 1;
    }

    const content = readFileSync(configPath, 'utf-8');
    const lines = content.split('\n');

    // Map dot-separated key to YAML path
    // e.g. "gate.timeoutSec" → find line with "timeoutSec:" under "gate:"
    const parts = key.split('.');
    const yamlKey = parts[parts.length - 1];

    // Format the value
    let formattedValue = value;
    // If value looks like a number, don't quote it
    if (!/^\d+(\.\d+)?$/.test(value) && value !== 'true' && value !== 'false' && value !== 'null') {
      // Check if it needs quoting
      if (value.includes('#') || value.includes(':') || value.includes('"')) {
        formattedValue = `"${value.replace(/"/g, '\\"')}"`;
      } else {
        formattedValue = `"${value}"`;
      }
    }

    let found = false;
    let inSection = parts.length > 1 ? parts[0] : null;
    let inSubSection = parts.length > 2 ? parts[1] : null;

    const newLines = lines.map((line) => {
      const trimmed = line.trim();

      // Track which YAML section we're in
      if (inSection && trimmed === `${inSection}:`) {
        return line;
      }

      // If we're looking for a key in a specific section
      if (inSection) {
        // Check if this line has the key we want
        if (trimmed.startsWith(`${yamlKey}:`)) {
          // Only replace if we're in the right section
          const indent = line.match(/^\s*/)?.[0] ?? '';
          // For nested keys like gate.retry.max, track sub-section
          if (inSubSection && trimmed.startsWith(`${inSubSection}:`)) {
            return line;
          }
          if (!inSubSection || trimmed.startsWith('  ') && !trimmed.startsWith('-')) {
            found = true;
            return `${indent}${yamlKey}: ${formattedValue}`;
          }
        }
        // Check if we've moved to a different top-level key
        if (trimmed.endsWith(':') && !trimmed.startsWith(' ') && !trimmed.startsWith('-')) {
          if (trimmed !== `${inSection}:`) {
            inSection = null;
          }
        }
      } else {
        // Not in a specific section, just find the key anywhere
        if (trimmed.startsWith(`${yamlKey}:`)) {
          const indent = line.match(/^\s*/)?.[0] ?? '';
          found = true;
          return `${indent}${yamlKey}: ${formattedValue}`;
        }
        // Track section entry
        if (trimmed.endsWith(':') && !trimmed.startsWith(' ') && !trimmed.startsWith('-')) {
          if (parts.length > 1 && trimmed === `${parts[0]}:`) {
            inSection = parts[0];
          }
        }
      }
      return line;
    });

    if (!found) {
      // Key not found, append to appropriate section
      if (parts.length > 1) {
        const sectionLine = `${parts[0]}:`;
        const sectionIdx = newLines.findIndex((l) => l.trim() === sectionLine);
        if (sectionIdx >= 0) {
          newLines.splice(sectionIdx + 1, 0, `  ${yamlKey}: ${formattedValue}`);
          found = true;
        }
      }
      if (!found) {
        newLines.push(`${yamlKey}: ${formattedValue}`);
      }
    }

    writeFileSync(configPath, newLines.join('\n'), 'utf-8');
    console.log(isSecretKey(key) ? `✅ ${key} = ${maskSecret(value)}` : `✅ ${key} = ${value}`);
    return 0;
  }

  // Show config (default)
  const cfg = loadConfig();
  console.log('Configuration:');
  console.log(`  Gate commands: ${cfg.gate?.commands?.map((c) => c.name).join(', ') || '(none)'}`);
  console.log(`  Gate timeout:  ${cfg.gate?.timeoutSec ?? 120}s`);
  console.log(`  Gate retries:  ${cfg.gate?.retry?.max ?? 2}`);
  console.log(`  Agent command: ${cfg.agent?.command || '(not set)'}`);
  if (cfg.llm) {
    console.log(`  LLM provider:  ${cfg.llm.provider || '(not set)'}`);
    console.log(`  LLM API key:   ${cfg.llm.apiKey ? maskSecret(cfg.llm.apiKey) : '(not set)'}`);
    if (cfg.llm.model) console.log(`  LLM model:     ${cfg.llm.model}`);
    if (cfg.llm.baseUrl) console.log(`  LLM base URL:  ${cfg.llm.baseUrl}`);
  }
  console.log(`\nConfig file: ${configPath}`);
  return 0;
});

/**
 * Config keys whose values are credentials. Only the API key exists today;
 * the list exists so new secret fields are masked by default too.
 */
const SECRET_KEYS = new Set(['llm.apiKey']);

export function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key);
}

/**
 * Mask a secret for display: keep a short prefix so the user can tell
 * *which* credential is configured, never enough to use it.
 */
export function maskSecret(value: string): string {
  if (value.length <= 4) return '***';
  return `${value.slice(0, 4)}***(${value.length} chars)`;
}
