/**
 * yaml-writer.ts — Serialize policy rules to YAML format and write to disk
 *
 * Handles the YAML serialization side of policy data access.
 * Produces output compatible with parsePolicyYaml() in core/policy/yaml.ts.
 *
 * C2: core/ does not depend on any SDK or adapters/
 * C3: deterministic — no model calls, no network
 */

import { writeFileSync } from 'node:fs';
import type { ArchGuardRule } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single policy rule in serializable form.
 * Structurally identical to PolicyRuleEntry in data-access.ts.
 */
export interface RuleData {
  id: string;
  match: { path?: string; operation?: string; harness?: string };
  action: string;
  basis: string;
  guidance?: string;
  priority?: number;
  description?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Serialize an array of rules to YAML string format.
 *
 * Produces output like:
 *   # header comment
 *
 *   rules:
 *     - id: my-rule
 *       match: { path: "src/**\/*.ts", operation: "write" }
 *       action: allow
 *       basis: "policy.yaml#my-rule"
 *       guidance: "..."
 *
 * @param rules - Rules to serialize
 * @param headerComment - Optional header comment block (lines starting with #)
 * @param arch - Optional arch guard rules (ADR-027); appended as top-level `arch:` so round-trips preserve it
 * @returns YAML string with trailing newline
 */
export function serializeRulesToYaml(rules: RuleData[], headerComment?: string, arch?: ArchGuardRule[]): string {
  const lines: string[] = [];

  if (headerComment) {
    lines.push(headerComment);
    lines.push('');
  }

  lines.push('rules:');

  for (const rule of rules) {
    lines.push(`  - id: ${rule.id}`);

    // Serialize match as inline object
    if (rule.match) {
      const parts: string[] = [];
      if (rule.match.path !== undefined) {
        parts.push(`path: "${rule.match.path}"`);
      }
      if (rule.match.operation !== undefined) {
        parts.push(`operation: "${rule.match.operation}"`);
      }
      if (rule.match.harness !== undefined) {
        parts.push(`harness: "${rule.match.harness}"`);
      }
      if (parts.length > 0) {
        lines.push(`    match: { ${parts.join(', ')} }`);
      }
    }

    lines.push(`    action: ${rule.action}`);
    lines.push(`    basis: "${rule.basis}"`);

    if (rule.guidance !== undefined && rule.guidance !== null) {
      lines.push(`    guidance: "${rule.guidance}"`);
    }
    if (rule.priority !== undefined && rule.priority !== null) {
      lines.push(`    priority: ${rule.priority}`);
    }
    if (rule.description !== undefined && rule.description !== null) {
      lines.push(`    description: "${rule.description}"`);
    }
  }

  // ADR-027: preserve arch guard rules on round-trip (addRule/removeRule must not drop them)
  if (arch && arch.length > 0) {
    lines.push('');
    lines.push('arch:');
    for (const g of arch) {
      lines.push(`  - kind: ${g.kind}`);
      lines.push(`    action: ${g.action}`);
      lines.push(`    basis: "${g.basis}"`);
      if (g.guidance !== undefined && g.guidance !== null) {
        lines.push(`    guidance: "${g.guidance}"`);
      }
    }
  }

  lines.push(''); // trailing newline
  return lines.join('\n');
}

/**
 * Write rules to a YAML policy file on disk.
 *
 * @param filePath - Absolute path to the output file
 * @param rules - Rules to write
 * @param headerComment - Optional header comment block
 */
export function writePolicyYaml(
  filePath: string,
  rules: RuleData[],
  headerComment?: string,
): void {
  const content = serializeRulesToYaml(rules, headerComment);
  writeFileSync(filePath, content, 'utf-8');
}
