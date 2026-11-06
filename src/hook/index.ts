#!/usr/bin/env node
// zelto-hook — standalone policy decision process
// Reads hookInput from stdin, writes hookOutput to stdout
// Protocol: zelto-hook/1 (see contracts/schemas/hook-io.json)
//
// Can be compiled independently: no dependency on the rest of zelto.
// Deterministic, zero network, zero model calls.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isProtectedPath, matchPath } from './protected.js';

// ── Inline policy engine (self-contained, no import from core/) ──────────

type Decision = 'allow' | 'deny' | 'ask';

interface PolicyRule {
  id: string;
  match: { path?: string; operation?: string };
  action: Decision;
  basis: string;
  guidance?: string;
  priority?: number;
}

interface PolicyConfig {
  rules: PolicyRule[];
}

interface PolicyDecision {
  decision: Decision;
  ruleId: string | null;
  basis: string;
  guidance: string | null;
  policyVersion: string;
}

function evaluatePolicy(
  config: PolicyConfig,
  path: string,
  operation: string,
  policyVersion: string,
): PolicyDecision {
  // 1. Protected domain
  if (isProtectedPath(path) && operation === 'write') {
    return {
      decision: 'deny',
      ruleId: 'protected:0b',
      basis: 'AGENTS.md#禁区',
      guidance: `Path "${path}" is in the protected domain and cannot be modified.`,
      policyVersion,
    };
  }

  // 2. Path escape
  if (path.startsWith('..') || path.startsWith('/') || path.includes(':\\')) {
    return {
      decision: 'deny',
      ruleId: 'protected:0a',
      basis: 'AGENTS.md#禁区',
      guidance: `Path "${path}" escapes the project root.`,
      policyVersion,
    };
  }

  // 3. Sort rules by priority
  const sorted = [...config.rules].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  let finalDecision: Decision | null = null;
  let matchedRule: PolicyRule | null = null;

  for (const rule of sorted) {
    if (rule.match.path && !matchPath(rule.match.path, path)) continue;
    if (rule.match.operation && rule.match.operation !== operation) continue;

    if (rule.action === 'deny') {
      return {
        decision: 'deny',
        ruleId: rule.id,
        basis: rule.basis,
        guidance: rule.guidance ?? null,
        policyVersion,
      };
    }

    if (finalDecision === null) {
      finalDecision = rule.action;
      matchedRule = rule;
    }
  }

  if (finalDecision && matchedRule) {
    return {
      decision: finalDecision,
      ruleId: matchedRule.id,
      basis: matchedRule.basis,
      guidance: matchedRule.guidance ?? null,
      policyVersion,
    };
  }

  return {
    decision: 'deny',
    ruleId: 'default',
    basis: 'policy.yaml#default',
    guidance: `No matching rule for "${operation}" on "${path}".`,
    policyVersion,
  };
}

// ── Hook IO types ────────────────────────────────────────────────────────

interface HookInput {
  path: string;
  operation: 'read' | 'write' | 'execute';
  harness: string;
  proposed_content?: string;
  slice_id?: string;
}

interface HookOutput {
  decision: Decision;
  decision_id: string;
  basis: string;
  guidance: string | null;
  policy_version: string;
  matched_rule: string | null;
}

// ── Main ─────────────────────────────────────────────────────────────────

function main() {
  // Sub-command: `zelto-hook pretool` —— Claude Code PreToolUse 运行时判定（ADR-014）
  if (process.argv[2] === 'pretool') {
    void import('./pretool.js')
      .then((mod) => mod.main(process.argv.slice(3)))
      .then((code: number) => {
        process.exitCode = code;
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`zelto pretool hook error: ${message}\n`);
        process.exitCode = 2;
      });
    return;
  }

  // Determine project root: prefer env var, then cwd, then script-relative
  const projectRoot = process.env.ZELTO_PROJECT_ROOT
    ?? process.cwd()
    ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

  // Read input from stdin
  const chunks: Buffer[] = [];
  let processed = false;

  function processStdinData(): void {
    if (processed) return;
    processed = true;
    try {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw.trim()) {
        writeError('Empty input');
        return;
      }
      const input: HookInput = JSON.parse(raw);

      // Validate required fields
      if (!input.path || !input.operation || !input.harness) {
        writeError('Missing required fields: path, operation, harness');
        return;
      }

      // Read policy
      const policyPath = resolve(projectRoot, 'policy', 'policy.yaml');
      const policyContent = readFileSync(policyPath, 'utf-8');
      const policyVersion = `sha256:${createHash('sha256').update(policyContent).digest('hex')}`;

      // Parse policy (simplified YAML — just the rules array)
      const config = parsePolicyYaml(policyContent);

      // Evaluate
      const result = evaluatePolicy(config, input.path, input.operation, policyVersion);

      const output: HookOutput = {
        decision: result.decision,
        decision_id: `hook-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        basis: result.basis,
        guidance: result.guidance,
        policy_version: policyVersion,
        matched_rule: result.ruleId,
      };

      process.stdout.write(JSON.stringify(output) + '\n');
    } catch (err) {
      writeError(`Hook error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Safety timeout: if stdin doesn't close, process what we have and exit
  const safetyTimer = setTimeout(() => {
    if (chunks.length > 0) {
      processStdinData();
    } else {
      writeError('Hook timeout waiting for stdin');
    }
    process.exit(0);
  }, 5000);
  safetyTimer.unref();

  process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
  process.stdin.on('end', () => {
    clearTimeout(safetyTimer);
    processStdinData();
  });
  process.stdin.on('close', () => {
    // On some platforms (Windows), both 'end' and 'close' fire with piped input.
    // processStdinData guards against double-processing via `processed` flag.
    if (chunks.length > 0) {
      clearTimeout(safetyTimer);
      processStdinData();
    }
  });
}

function stripSurroundingQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

/**
 * 解析行内 `match: { ... }` —— 按键值对解析，键序无关、引号风格无关（ADR-028）。
 */
function parseInlineMatch(body: string): { path?: string; operation?: string } | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;

  const inner = trimmed.slice(1, -1).trim();
  if (inner === '') return {};

  const result: { path?: string; operation?: string } = {};
  for (const part of inner.split(',')) {
    const segment = part.trim();
    if (segment === '') continue;

    const sep = segment.indexOf(':');
    if (sep < 0) continue;

    const key = stripSurroundingQuotes(segment.slice(0, sep).trim());
    const value = stripSurroundingQuotes(segment.slice(sep + 1).trim());
    if (key === 'path') result.path = value;
    else if (key === 'operation') result.operation = value;
  }
  return result;
}

function parsePolicyYaml(content: string): PolicyConfig {
  const rules: PolicyRule[] = [];
  let currentRule: Partial<PolicyRule> | null = null;
  let inArch = false;

  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('#') || trimmed === '') continue;

    // 顶层段切换 —— `arch:` 段是护栏规则，逐写判定不消费它，
    // 但必须跳过，否则它的 `action:` / `basis:` 会贴到最后一条 rules 规则上，
    // 把一条 allow 规则改成 deny（ADR-027 §2.3、ADR-028）。
    if (trimmed === 'arch:') {
      if (currentRule?.id) {
        rules.push(currentRule as PolicyRule);
      }
      currentRule = null;
      inArch = true;
      continue;
    }
    if (trimmed === 'rules:') {
      inArch = false;
      continue;
    }
    if (inArch) continue;

    // Start of a rule: "- id: <name>"
    if (trimmed.startsWith('- id:')) {
      if (currentRule?.id) {
        rules.push(currentRule as PolicyRule);
      }
      currentRule = { id: stripSurroundingQuotes(trimmed.slice(5).trim()) };
      continue;
    }

    if (!currentRule) continue;

    // Handle inline match: `match: { path: "...", operation: "..." }`
    if (trimmed.startsWith('match:')) {
      const inline = parseInlineMatch(trimmed.slice(6));
      if (inline) {
        currentRule.match = { ...currentRule.match, ...inline };
      }
      continue;
    }

    // Handle indented match subfields: `  path: "..."`
    if (trimmed.startsWith('path:')) {
      currentRule.match = { ...currentRule.match, path: stripSurroundingQuotes(trimmed.slice(5).trim()) };
      continue;
    }

    if (trimmed.startsWith('operation:')) {
      currentRule.match = { ...currentRule.match, operation: stripSurroundingQuotes(trimmed.slice(10).trim()) };
      continue;
    }

    // Handle simple fields
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
      continue;
    }

    // Skip unknown match subfields (like `priority:` inside match block — just ignore)
    if (trimmed.startsWith('match:')) continue;
  }

  if (currentRule?.id) {
    rules.push(currentRule as PolicyRule);
  }

  return { rules };
}

function writeError(msg: string): void {
  const output: HookOutput = {
    decision: 'deny',
    decision_id: `hook-err-${Date.now()}`,
    basis: 'hook:internal-error',
    guidance: msg,
    policy_version: 'unknown',
    matched_rule: null,
  };
  process.stdout.write(JSON.stringify(output) + '\n');
}

main();
