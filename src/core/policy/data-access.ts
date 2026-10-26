/**
 * data-access.ts — Policy data access layer (read-only for v1)
 *
 * Reads policy.yaml and returns parsed rule data for CLI display.
 * Uses the existing parsePolicyYaml from hook/ for consistency.
 *
 * C2: core/ does not depend on any SDK or adapters/
 * C3: deterministic — no model calls, no network
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { serializeRulesToYaml } from './yaml-writer.js';
import type { RuleData } from './yaml-writer.js';

export interface PolicyRuleEntry {
  id: string;
  match: { path?: string; operation?: string; harness?: string };
  action: string;
  basis: string;
  guidance?: string;
  priority?: number;
  description?: string;
}

export interface PolicyData {
  rules: PolicyRuleEntry[];
  path: string;
  version: string;
}

/**
 * Load policy rules from policy.yaml.
 * Returns null if the file doesn't exist or can't be parsed.
 */
export function loadPolicy(projectRoot?: string): PolicyData | null {
  const root = projectRoot ?? process.cwd();
  const policyPath = resolve(root, 'policy', 'policy.yaml');

  if (!existsSync(policyPath)) {
    return null;
  }

  try {
    const content = readFileSync(policyPath, 'utf-8');
    const rules = parsePolicyYamlSimple(content);
    return {
      rules,
      path: policyPath,
      version: `sha256:${hashContent(content)}`,
    };
  } catch {
    return null;
  }
}

/**
 * Add a rule to the policy file.
 *
 * Reads the current policy, appends the rule, writes back, and returns
 * the updated PolicyData. Returns null if the policy file doesn't exist
 * or can't be parsed.
 *
 * If a rule with the same ID already exists, returns the current data
 * without modifying the file (no-op).
 */
export function addRule(
  rule: PolicyRuleEntry,
  projectRoot?: string,
): PolicyData | null {
  const root = projectRoot ?? process.cwd();
  const policyPath = resolve(root, 'policy', 'policy.yaml');

  if (!existsSync(policyPath)) {
    return null;
  }

  const current = loadPolicy(projectRoot);
  if (!current) return null;

  // No-op if rule ID already exists
  if (current.rules.some((r) => r.id === rule.id)) {
    return current;
  }

  current.rules.push(rule);

  const headerComment = extractHeader(policyPath);
  const yamlContent = serializeRulesToYaml(
    current.rules as RuleData[],
    headerComment,
  );
  writeFileSync(policyPath, yamlContent, 'utf-8');

  return {
    rules: current.rules,
    path: policyPath,
    version: `sha256:${hashContent(yamlContent)}`,
  };
}

/**
 * Remove a rule from the policy file by ID.
 *
 * Reads the current policy, removes the matching rule, writes back, and
 * returns the updated PolicyData. Returns null if the policy file doesn't
 * exist or can't be parsed.
 *
 * If no rule with the given ID is found, returns the current data without
 * modifying the file (no-op).
 */
export function removeRule(
  ruleId: string,
  projectRoot?: string,
): PolicyData | null {
  const root = projectRoot ?? process.cwd();
  const policyPath = resolve(root, 'policy', 'policy.yaml');

  if (!existsSync(policyPath)) {
    return null;
  }

  const current = loadPolicy(projectRoot);
  if (!current) return null;

  const filtered = current.rules.filter((r) => r.id !== ruleId);
  if (filtered.length === current.rules.length) {
    // No rule matched — no-op
    return current;
  }

  const headerComment = extractHeader(policyPath);
  const yamlContent = serializeRulesToYaml(
    filtered as RuleData[],
    headerComment,
  );
  writeFileSync(policyPath, yamlContent, 'utf-8');

  return {
    rules: filtered,
    path: policyPath,
    version: `sha256:${hashContent(yamlContent)}`,
  };
}

/**
 * Simple policy YAML parser — extracts rule entries.
 * Compatible with the format produced by `zelto init` and consumed by hook/.
 */
function parsePolicyYamlSimple(content: string): PolicyRuleEntry[] {
  const rules: PolicyRuleEntry[] = [];
  let current: Partial<PolicyRuleEntry> | null = null;

  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '') continue;

    // Start of a rule
    if (trimmed.startsWith('- id:')) {
      if (current?.id) {
        rules.push(current as PolicyRuleEntry);
      }
      current = { id: trimmed.slice(5).trim() };
      continue;
    }

    if (!current) continue;

    // match: { path: "...", operation: "..." }
    const matchInline = trimmed.match(
      /^match:\s*\{\s*path:\s*"([^"]*)"\s*(?:,\s*operation:\s*"([^"]*)")?\s*\}/,
    );
    if (matchInline) {
      current.match = {
        path: matchInline[1],
        ...(matchInline[2] ? { operation: matchInline[2] } : {}),
      };
      continue;
    }

    if (trimmed.startsWith('path:')) {
      current.match = {
        ...current.match,
        path: trimmed.slice(5).trim().replace(/^"|"$/g, ''),
      };
      continue;
    }

    if (trimmed.startsWith('operation:')) {
      current.match = {
        ...current.match,
        operation: trimmed.slice(10).trim().replace(/^"|"$/g, ''),
      };
      continue;
    }

    if (trimmed.startsWith('action:')) {
      current.action = trimmed.slice(7).trim();
      continue;
    }

    if (trimmed.startsWith('basis:')) {
      current.basis = trimmed.slice(6).trim().replace(/^"|"$/g, '');
      continue;
    }

    if (trimmed.startsWith('guidance:')) {
      current.guidance = trimmed.slice(9).trim().replace(/^"|"$/g, '');
      continue;
    }

    if (trimmed.startsWith('description:')) {
      current.description = trimmed.slice(12).trim().replace(/^"|"$/g, '');
      continue;
    }

    if (trimmed.startsWith('priority:')) {
      current.priority = Number.parseInt(trimmed.slice(9).trim(), 10);
      continue;
    }
  }

  if (current?.id) {
    rules.push(current as PolicyRuleEntry);
  }

  return rules;
}

function hashContent(content: string): string {
  // Simple hash for versioning — not cryptographic, just for change detection
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

/**
 * Extract the header comment block from a policy YAML file.
 * Returns all leading comment (#) and blank lines before the first content line.
 */
function extractHeader(filePath: string): string | undefined {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const headerLines: string[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed === '') {
        headerLines.push(line);
      } else {
        break;
      }
    }
    if (headerLines.length > 0) {
      return headerLines.join('\n');
    }
  } catch {
    // Ignore read errors
  }
  return undefined;
}
