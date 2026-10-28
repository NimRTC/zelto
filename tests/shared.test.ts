// Tests for shared CLI utilities — config parsing, adapter factories, policy parsing
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Import pure functions that don't depend on cwd
import {
  parseConfigYaml,
  parsePolicyYaml,
  generateSliceSpecContent,
  hashSpecFile,
} from '../src/cli/commands/shared.js';

// ─── parseConfigYaml ──────────────────────────────────────────────────────

describe('parseConfigYaml', () => {
  it('parses gate commands in inline format', () => {
    const yaml = `
gate:
  - { name: test, run: "pnpm test" }
  - { name: lint, run: "pnpm lint" }
  timeoutSec: 60
  retry:
    max: 1
`;
    const result = parseConfigYaml(yaml);
    assert.ok(result !== null);
    assert.equal(result.gate.commands.length, 2);
    assert.equal(result.gate.commands[0].name, 'test');
    assert.equal(result.gate.commands[0].run, 'pnpm test');
    assert.equal(result.gate.commands[1].name, 'lint');
    assert.equal(result.gate.timeoutSec, 60);
    assert.equal(result.gate.retry.max, 1);
  });

  it('parses gate commands in expanded format', () => {
    const yaml = `
gate:
  - name: test
    run: "pnpm test:quick"
  timeoutSec: 120
  retry:
    max: 2
`;
    const result = parseConfigYaml(yaml);
    assert.ok(result !== null);
    assert.equal(result.gate.commands.length, 1);
    assert.equal(result.gate.commands[0].name, 'test');
    assert.equal(result.gate.commands[0].run, 'pnpm test:quick');
  });

  it('parses agent section with command and adapter', () => {
    const yaml = `
gate:
  - { name: test, run: "pnpm test" }
agent:
  command: "npx claude-code"
  adapter: "claude-agent-sdk"
`;
    const result = parseConfigYaml(yaml);
    assert.ok(result !== null);
    assert.equal(result.agent.command, 'npx claude-code');
    assert.equal(result.agent.adapter, 'claude-agent-sdk');
  });

  it('parses llm section', () => {
    const yaml = `
gate:
  - { name: test, run: "pnpm test" }
llm:
  provider: "deepseek"
  apiKey: "sk-test-key"
  model: "deepseek-chat"
  baseUrl: "https://api.deepseek.com/v1"
`;
    const result = parseConfigYaml(yaml);
    assert.ok(result !== null);
    assert.ok(result.llm !== undefined);
    assert.equal(result.llm!.provider, 'deepseek');
    assert.equal(result.llm!.apiKey, 'sk-test-key');
    assert.equal(result.llm!.model, 'deepseek-chat');
    assert.equal(result.llm!.baseUrl, 'https://api.deepseek.com/v1');
  });

  it('returns null for empty config', () => {
    const result = parseConfigYaml('# just a comment\n');
    assert.equal(result, null);
  });

  it('returns null for config with only comments', () => {
    const result = parseConfigYaml('');
    assert.equal(result, null);
  });

  it('handles yaml with only llm section (no gate commands)', () => {
    const yaml = `
llm:
  provider: "deepseek"
  apiKey: "sk-key"
`;
    const result = parseConfigYaml(yaml);
    assert.ok(result !== null);
    assert.equal(result.gate.commands.length, 0);
    assert.ok(result.llm !== undefined);
  });

  it('handles quoted and unquoted values', () => {
    const yaml = `
gate:
  - { name: test, run: "pnpm test" }
agent:
  command: npx claude-code
`;
    const result = parseConfigYaml(yaml);
    assert.ok(result !== null);
    assert.equal(result.agent.command, 'npx claude-code');
  });

  it('defaults timeoutSec when parsing fails', () => {
    const yaml = `
gate:
  - { name: test, run: "pnpm test" }
  timeoutSec: invalid
`;
    const result = parseConfigYaml(yaml);
    assert.ok(result !== null);
    assert.equal(result.gate.timeoutSec, 120);
  });

  it('defaults retry max when parsing fails', () => {
    const yaml = `
gate:
  - { name: test, run: "pnpm test" }
  retry:
    max: invalid
`;
    const result = parseConfigYaml(yaml);
    assert.ok(result !== null);
    assert.equal(result.gate.retry.max, 2);
  });
});

// ─── parsePolicyYaml ──────────────────────────────────────────────────────

describe('parsePolicyYaml', () => {
  it('parses inline match format', () => {
    const yaml = `
rules:
  - id: allow-src-ts
    match: { path: "src/**/*.ts", operation: "write" }
    action: allow
    basis: "policy.yaml#allow-src-ts"
`;
    const result = parsePolicyYaml(yaml);
    assert.equal(result.rules.length, 1);
    assert.equal(result.rules[0].id, 'allow-src-ts');
    assert.equal(result.rules[0].match?.path, 'src/**/*.ts');
    assert.equal(result.rules[0].match?.operation, 'write');
    assert.equal(result.rules[0].action, 'allow');
  });

  it('parses expanded match format', () => {
    const yaml = `
rules:
  - id: allow-read-all
    match:
      path: "**"
      operation: read
    action: allow
    basis: "policy.yaml#allow-read-all"
    priority: 0
`;
    const result = parsePolicyYaml(yaml);
    assert.equal(result.rules.length, 1);
    assert.equal(result.rules[0].id, 'allow-read-all');
    assert.equal(result.rules[0].match?.path, '**');
    assert.equal(result.rules[0].match?.operation, 'read');
    assert.equal(result.rules[0].priority, 0);
  });

  it('parses multiple rules', () => {
    const yaml = `
rules:
  - id: rule-one
    match: { path: "src/**", operation: "write" }
    action: allow
    basis: "doc#rule-one"
  - id: rule-two
    match: { path: "tests/**", operation: "write" }
    action: deny
    basis: "doc#rule-two"
    guidance: "Do not modify tests without approval"
`;
    const result = parsePolicyYaml(yaml);
    assert.equal(result.rules.length, 2);
    assert.equal(result.rules[0].id, 'rule-one');
    assert.equal(result.rules[1].id, 'rule-two');
    assert.equal(result.rules[1].guidance, 'Do not modify tests without approval');
  });

  it('skips comments and blank lines', () => {
    const yaml = `
# This is a comment
rules:
  - id: test-rule
    match: { path: "src/**", operation: "read" }
    action: allow
    basis: "test"

`;
    const result = parsePolicyYaml(yaml);
    assert.equal(result.rules.length, 1);
  });

  it('returns empty rules for empty yaml', () => {
    const result = parsePolicyYaml('');
    assert.equal(result.rules.length, 0);
  });

  it('returns empty rules for yaml with no rules section', () => {
    const result = parsePolicyYaml('# just comments');
    assert.equal(result.rules.length, 0);
  });
});

// ─── hashSpecFile ─────────────────────────────────────────────────────────

describe('hashSpecFile', () => {
  it('returns sha256 hash for existing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zelto-shared-test-'));
    const filePath = join(dir, 'test-spec.md');
    writeFileSync(filePath, '# Test spec\n\nSome content');
    const hash = hashSpecFile(filePath);
    assert.ok(hash !== null);
    assert.ok(hash!.startsWith('sha256:'));
    assert.equal(hash!.length, 64 + 7); // "sha256:" + 64 hex chars
  });

  it('returns null for missing file', () => {
    const hash = hashSpecFile(join(tmpdir(), 'nonexistent-spec.md'));
    assert.equal(hash, null);
  });

  it('produces deterministic hash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zelto-shared-test-'));
    const filePath = join(dir, 'deterministic.md');
    writeFileSync(filePath, 'Same content');
    const hash1 = hashSpecFile(filePath);
    const hash2 = hashSpecFile(filePath);
    assert.equal(hash1, hash2);
  });

  it('different content produces different hash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zelto-shared-test-'));
    const fileA = join(dir, 'a.md');
    const fileB = join(dir, 'b.md');
    writeFileSync(fileA, 'Content A');
    writeFileSync(fileB, 'Content B');
    const hashA = hashSpecFile(fileA);
    const hashB = hashSpecFile(fileB);
    assert.notEqual(hashA, hashB);
  });
});

// ─── generateSliceSpecContent ─────────────────────────────────────────────

describe('generateSliceSpecContent', () => {
  it('generates spec with all fields', () => {
    const spec = generateSliceSpecContent(
      'test-slice',
      'Test slice title',
      'Core',
      ['src/**/*.ts', 'tests/**/*.ts'],
      'v1',
    );
    assert.ok(spec.includes('# Slice: test-slice'));
    assert.ok(spec.includes('版本 v1 — Test slice title'));
    assert.ok(spec.includes('- `src/**/*.ts`'));
    assert.ok(spec.includes('- `tests/**/*.ts`'));
    assert.ok(spec.includes('## 验收标准'));
    assert.ok(spec.includes('## 风险'));
  });

  it('handles empty writes array', () => {
    const spec = generateSliceSpecContent('empty-slice', 'Empty', 'Core', [], 'v1');
    assert.ok(spec.includes('# Slice: empty-slice'));
    assert.ok(spec.includes('## 范围'));
    // No file entries after "## 范围" header
    const lines = spec.split('\n');
    const rangeIdx = lines.findIndex((l) => l.includes('## 范围'));
    const acceptanceIdx = lines.findIndex((l) => l.includes('## 验收标准'));
    const rangeLines = lines.slice(rangeIdx + 1, acceptanceIdx).filter((l) => l.trim() !== '');
    assert.equal(rangeLines.length, 0);
  });

  it('handles single write path', () => {
    const spec = generateSliceSpecContent('single', 'Single', 'Core', ['src/only.ts'], 'v1');
    assert.ok(spec.includes('- `src/only.ts`'));
  });
});
