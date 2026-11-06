// 策略 YAML 解析语义（ADR-028）
//
// 三个守点：
//   1. 引号风格无关 —— 单引号 / 双引号 / 无引号等价；
//   2. 行内 match 键序无关 —— path 与 operation 谁在前都一样；
//   3. core 解析器与 hook 解析器对同一输入产出同一结果 —— hook 不能 import
//      core（可独立编译的判定进程），所以一致性只能靠测试锁死。
//
// 背景：修复前单引号的 deny 规则会被解析成带引号的字面量，glob 永不匹配，
// 于是被更宽的 allow 规则捕获 —— 策略写得越严反而越容易被绕过。

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parsePolicyYaml, stripSurroundingQuotes } from '../src/core/policy/yaml.js';
import { parsePolicyRules } from '../src/hook/pretool.js';
import { evaluatePolicy } from '../src/core/policy/engine.js';
import type { PolicyConfig } from '../src/core/policy/types.js';

const HOOK_BIN = join(process.cwd(), 'dist', 'hook', 'index.js');

/** 跑一次真实 hook 进程，拿到它的判定。 */
function runHook(policyYaml: string, path: string, operation = 'write') {
  const root = mkdtempSync(join(tmpdir(), 'zelto-policy-parse-'));
  mkdirSync(join(root, 'policy'), { recursive: true });
  writeFileSync(join(root, 'policy', 'policy.yaml'), policyYaml);

  const stdout = execFileSync(process.execPath, [HOOK_BIN], {
    input: JSON.stringify({ path, operation, harness: 'test' }),
    encoding: 'utf8',
    cwd: root,
  });
  return JSON.parse(stdout.trim()) as {
    decision: string;
    basis: string;
    matched_rule: string | null;
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 引号剥离
// ─────────────────────────────────────────────────────────────────────────

describe('stripSurroundingQuotes', () => {
  it('strips double quotes', () => {
    assert.equal(stripSurroundingQuotes('"src/**"'), 'src/**');
  });

  it('strips single quotes (ADR-028)', () => {
    assert.equal(stripSurroundingQuotes("'src/**'"), 'src/**');
  });

  it('leaves unquoted strings alone', () => {
    assert.equal(stripSurroundingQuotes('src/**'), 'src/**');
  });

  it('keeps inner quotes', () => {
    assert.equal(stripSurroundingQuotes('"npx claude-code"'), 'npx claude-code');
    assert.equal(stripSurroundingQuotes('"it\'s"'), "it's");
  });

  it('leaves unmatched quotes alone', () => {
    assert.equal(stripSurroundingQuotes("'src/**"), "'src/**");
    assert.equal(stripSurroundingQuotes('src/**"'), 'src/**"');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 引号风格无关
// ─────────────────────────────────────────────────────────────────────────

describe('parsePolicyYaml — 引号风格无关', () => {
  it('parses single-quoted path the same as double-quoted', () => {
    const dq = `rules:
  - id: r1
    match:
      path: "secrets/**"
      operation: write
    action: deny
    basis: "b"
`;
    const sq = dq.replace('path: "secrets/**"', "path: 'secrets/**'");

    const fromDq = parsePolicyYaml(dq).rules[0];
    const fromSq = parsePolicyYaml(sq).rules[0];

    assert.equal(fromSq.match.path, 'secrets/**');
    assert.deepEqual(fromSq, fromDq);
  });

  it('parses unquoted path the same as quoted', () => {
    const yaml = `rules:
  - id: r1
    match:
      path: secrets/**
      operation: write
    action: deny
`;
    assert.equal(parsePolicyYaml(yaml).rules[0].match.path, 'secrets/**');
  });

  it('parses single-quoted inline match', () => {
    const yaml = `rules:
  - id: r1
    match: { path: 'secrets/**', operation: 'write' }
    action: deny
`;
    const rule = parsePolicyYaml(yaml).rules[0];
    assert.equal(rule.match.path, 'secrets/**');
    assert.equal(rule.match.operation, 'write');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 行内 match 键序无关
// ─────────────────────────────────────────────────────────────────────────

describe('parsePolicyYaml — 行内 match 键序无关', () => {
  it('parses operation before path', () => {
    const yaml = `rules:
  - id: r1
    match: { operation: "write", path: "src/**" }
    action: allow
`;
    const rule = parsePolicyYaml(yaml).rules[0];
    assert.equal(rule.match.path, 'src/**');
    assert.equal(rule.match.operation, 'write');
  });

  it('parses path before operation identically', () => {
    const a = parsePolicyYaml(`rules:
  - id: r1
    match: { path: "src/**", operation: "write" }
    action: allow
`).rules[0];
    const b = parsePolicyYaml(`rules:
  - id: r1
    match: { operation: "write", path: "src/**" }
    action: allow
`).rules[0];
    assert.deepEqual(a, b);
  });

  it('parses inline match with only a path', () => {
    const yaml = `rules:
  - id: r1
    match: { path: "src/**" }
    action: allow
`;
    assert.equal(parsePolicyYaml(yaml).rules[0].match.path, 'src/**');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// deny 规则不得被静默跳过（fail-open 的核心防线）
// ─────────────────────────────────────────────────────────────────────────

describe('策略规则不得被静默跳过', () => {
  const allowAllThenDeny = (denyPathLine: string) => `version: '1'
rules:
  - id: allow-all-write
    match: { path: "**", operation: "write" }
    action: allow
    basis: "test"
  - id: deny-secret
    match:
      ${denyPathLine}
      operation: write
    action: deny
    basis: "AGENTS.md#禁区"
`;

  it('deny rule with double quotes is enforced', () => {
    const config: PolicyConfig = {
      rules: parsePolicyYaml(allowAllThenDeny('path: "secrets/**"')).rules,
      protected: [],
    };
    const d = evaluatePolicy(config, 'secrets/key.pem', 'write', 'v1');
    assert.equal(d.decision, 'deny');
    assert.equal(d.ruleId, 'deny-secret');
  });

  it('deny rule with single quotes is enforced too (ADR-028)', () => {
    const config: PolicyConfig = {
      rules: parsePolicyYaml(allowAllThenDeny("path: 'secrets/**'")).rules,
      protected: [],
    };
    const d = evaluatePolicy(config, 'secrets/key.pem', 'write', 'v1');
    assert.equal(d.decision, 'deny');
    assert.equal(d.ruleId, 'deny-secret');
  });

  it('the hook process also denies a single-quoted deny rule', () => {
    const out = runHook(allowAllThenDeny("path: 'secrets/**'"), 'secrets/key.pem');
    assert.equal(out.decision, 'deny');
    assert.equal(out.matched_rule, 'deny-secret');
  });

  it('the hook process denies a double-quoted deny rule (no regression)', () => {
    const out = runHook(allowAllThenDeny('path: "secrets/**"'), 'secrets/key.pem');
    assert.equal(out.decision, 'deny');
    assert.equal(out.matched_rule, 'deny-secret');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// arch: 段不得污染 rules 规则
// ─────────────────────────────────────────────────────────────────────────

describe('arch: 段不污染 rules 规则', () => {
  const withArch = `version: '1'
rules:
  - id: allow-src
    match: { path: "src/**", operation: "write" }
    action: allow
    basis: "policy.yaml#allow-src"

arch:
  - kind: unmapped_file
    action: deny
    basis: "policy.yaml#arch-unmapped"
    guidance: "有文件无归属，交付前必须收敛。"
`;

  it('the hook still allows the write rule', () => {
    const out = runHook(withArch, 'src/a.ts');
    assert.equal(out.decision, 'allow');
    assert.equal(out.matched_rule, 'allow-src');
  });

  it('pretool parser ignores the arch section', () => {
    const rules = parsePolicyRules(withArch);
    const allowSrc = rules.find((r) => r.id === 'allow-src');
    assert.ok(allowSrc, 'allow-src 规则应在');
    assert.equal(allowSrc.action, 'allow');
    assert.equal(allowSrc.basis, 'policy.yaml#allow-src');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// core 解析器与 hook 解析器一致性
// ─────────────────────────────────────────────────────────────────────────

describe('core 解析器与 hook 解析器一致', () => {
  const samples: Array<[string, string]> = [
    [
      '双引号行内',
      `rules:
  - id: r1
    match: { path: "src/**", operation: "write" }
    action: allow
    basis: "b1"
`,
    ],
    [
      '单引号行内',
      `rules:
  - id: r1
    match: { path: 'src/**', operation: 'write' }
    action: allow
    basis: 'b1'
`,
    ],
    [
      '键序颠倒行内',
      `rules:
  - id: r1
    match: { operation: "write", path: "src/**" }
    action: allow
    basis: "b1"
`,
    ],
    [
      '分行写法',
      `rules:
  - id: r1
    match:
      path: "src/**"
      operation: write
    action: deny
    basis: "b1"
    guidance: "g"
    priority: 5
`,
    ],
    [
      '多条规则混合',
      `version: '1'
rules:
  - id: allow-src
    match: { path: "src/**", operation: "write" }
    action: allow
    basis: "b1"
  - id: deny-tests
    match:
      path: 'tests/acceptance/**'
      operation: write
    action: deny
    basis: "b2"
    guidance: "验收测试随规格冻结"
`,
    ],
    [
      '带 arch 段',
      `rules:
  - id: r1
    match: { path: "src/**", operation: "write" }
    action: allow
    basis: "b1"

arch:
  - kind: unmapped_file
    action: deny
    basis: "b-arch"
`,
    ],
  ];

  for (const [label, yaml] of samples) {
    it(`produces identical rules: ${label}`, () => {
      const fromCore = parsePolicyYaml(yaml).rules.map((r) => ({
        id: r.id,
        match: r.match,
        action: r.action,
        basis: r.basis,
        guidance: r.guidance,
        priority: r.priority,
      }));

      const fromHook = parsePolicyRules(yaml).map((r) => ({
        id: r.id,
        match: r.match,
        action: r.action,
        basis: r.basis,
        guidance: r.guidance,
        priority: r.priority,
      }));

      assert.deepEqual(fromHook, fromCore);
    });
  }
});
