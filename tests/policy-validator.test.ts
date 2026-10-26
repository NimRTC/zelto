import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePolicyConfig,
  validateRule,
  validateMatch,
  validatePolicyYaml,
  validateRuleResult,
  isValidGlobPattern,
  isValidAction,
  isValidOperation,
} from '../src/core/policy/validator.js';
import type { PolicyConfig, PolicyRule } from '../src/core/policy/types.js';

// ---------------------------------------------------------------------------
// validatePolicyConfig
// ---------------------------------------------------------------------------

describe('validatePolicyConfig', () => {
  it('accepts a valid PolicyConfig', () => {
    const config: PolicyConfig = {
      rules: [
        {
          id: 'allow-src',
          match: { path: 'src/**/*.ts', operation: 'write' },
          action: 'allow',
          basis: 'policy.yaml#allow-src',
        },
      ],
      protected: ['policy/**'],
    };
    const result = validatePolicyConfig(config);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  it('accepts valid config with empty protected', () => {
    const config = { rules: [{ id: 'r1', match: { path: '**', operation: 'read' }, action: 'allow', basis: 'test' }], protected: [] };
    const result = validatePolicyConfig(config);
    assert.equal(result.valid, true);
  });

  it('rejects null', () => {
    const result = validatePolicyConfig(null);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  it('rejects non-object', () => {
    const result = validatePolicyConfig('not-an-object');
    assert.equal(result.valid, false);
    assert.equal(result.errors[0].code, 'E_TYPE');
  });

  it('rejects missing rules', () => {
    const result = validatePolicyConfig({ protected: [] } as unknown as PolicyConfig);
    assert.equal(result.valid, false);
    assert.equal(result.errors[0].path, 'rules');
    assert.equal(result.errors[0].code, 'E_REQUIRED');
  });

  it('rejects empty rules', () => {
    const result = validatePolicyConfig({ rules: [], protected: [] });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.code === 'E_EMPTY'));
  });

  it('rejects invalid protected type', () => {
    const result = validatePolicyConfig({
      rules: [{ id: 'r1', match: { path: '**' }, action: 'allow', basis: 'test' }],
      protected: 'not-an-array',
    } as unknown as PolicyConfig);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.path === 'protected'));
  });

  it('rejects empty protected path strings', () => {
    const result = validatePolicyConfig({
      rules: [{ id: 'r1', match: { path: '**' }, action: 'allow', basis: 'test' }],
      protected: ['valid/path', ''],
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.path === 'protected[1]'));
  });

  it('reports errors with correct JSON path prefixes', () => {
    const result = validatePolicyConfig({
      rules: [{ id: '', match: null, action: 'invalid', basis: '' }],
      protected: [],
    } as unknown as PolicyConfig);
    assert.ok(result.errors.some((e) => e.path.startsWith('rules[0]')));
  });
});

// ---------------------------------------------------------------------------
// validateRule
// ---------------------------------------------------------------------------

describe('validateRule', () => {
  it('accepts a valid rule', () => {
    const rule: PolicyRule = {
      id: 'test-rule',
      match: { path: 'src/**/*.ts', operation: 'write' },
      action: 'allow',
      basis: 'policy.yaml#test',
    };
    const errors = validateRule(rule);
    assert.equal(errors.length, 0);
  });

  it('accepts a rule with optional fields', () => {
    const rule: PolicyRule = {
      id: 'test-rule',
      match: { path: 'docs/**' },
      action: 'deny',
      basis: 'policy.yaml#test',
      guidance: 'This is guidance',
      priority: 10,
      description: 'A test rule',
    };
    const errors = validateRule(rule);
    assert.equal(errors.length, 0);
  });

  it('rejects null rule', () => {
    const errors = validateRule(null);
    assert.ok(errors.length > 0);
    assert.equal(errors[0].code, 'E_TYPE');
  });

  it('rejects missing id', () => {
    const errors = validateRule({ match: { path: '**' }, action: 'allow', basis: 'x' });
    assert.ok(errors.some((e) => e.path === 'id' && e.code === 'E_REQUIRED'));
  });

  it('rejects empty id', () => {
    const errors = validateRule({ id: '', match: { path: '**' }, action: 'allow', basis: 'x' });
    assert.ok(errors.some((e) => e.path === 'id' && e.code === 'E_TYPE'));
  });

  it('rejects missing match', () => {
    const errors = validateRule({ id: 'r1', action: 'allow', basis: 'x' });
    assert.ok(errors.some((e) => e.path === 'match' && e.code === 'E_REQUIRED'));
  });

  it('rejects missing action', () => {
    const errors = validateRule({ id: 'r1', match: { path: '**' }, basis: 'x' });
    assert.ok(errors.some((e) => e.path === 'action' && e.code === 'E_REQUIRED'));
  });

  it('rejects invalid action', () => {
    const errors = validateRule({ id: 'r1', match: { path: '**' }, action: 'invalid', basis: 'x' });
    assert.ok(errors.some((e) => e.path === 'action' && e.code === 'E_ENUM'));
  });

  it('rejects missing basis', () => {
    const errors = validateRule({ id: 'r1', match: { path: '**' }, action: 'allow' });
    assert.ok(errors.some((e) => e.path === 'basis' && e.code === 'E_REQUIRED'));
  });

  it('rejects empty basis', () => {
    const errors = validateRule({ id: 'r1', match: { path: '**' }, action: 'allow', basis: '' });
    assert.ok(errors.some((e) => e.path === 'basis' && e.code === 'E_TYPE'));
  });

  it('rejects non-string guidance', () => {
    const errors = validateRule({ id: 'r1', match: { path: '**' }, action: 'allow', basis: 'x', guidance: 123 });
    assert.ok(errors.some((e) => e.path === 'guidance'));
  });

  it('rejects negative priority', () => {
    const errors = validateRule({ id: 'r1', match: { path: '**' }, action: 'allow', basis: 'x', priority: -1 });
    assert.ok(errors.some((e) => e.path === 'priority'));
  });

  it('rejects non-integer priority', () => {
    const errors = validateRule({ id: 'r1', match: { path: '**' }, action: 'allow', basis: 'x', priority: 1.5 });
    assert.ok(errors.some((e) => e.path === 'priority'));
  });

  it('rejects non-string description', () => {
    const errors = validateRule({ id: 'r1', match: { path: '**' }, action: 'allow', basis: 'x', description: 42 });
    assert.ok(errors.some((e) => e.path === 'description'));
  });
});

// ---------------------------------------------------------------------------
// validateMatch
// ---------------------------------------------------------------------------

describe('validateMatch', () => {
  it('accepts a valid match with path and operation', () => {
    const errors = validateMatch({ path: 'src/**/*.ts', operation: 'write' }, 'match');
    assert.equal(errors.length, 0);
  });

  it('accepts a match with only path', () => {
    const errors = validateMatch({ path: '**' }, 'match');
    assert.equal(errors.length, 0);
  });

  it('accepts a match with only operation', () => {
    const errors = validateMatch({ operation: 'read' }, 'match');
    assert.equal(errors.length, 0);
  });

  it('rejects null match', () => {
    const errors = validateMatch(null, 'match');
    assert.ok(errors.length > 0);
  });

  it('rejects empty match object', () => {
    const errors = validateMatch({}, 'match');
    assert.ok(errors.some((e) => e.code === 'E_EMPTY'));
  });

  it('rejects unknown match field', () => {
    const errors = validateMatch({ path: '**', unknownField: 'x' }, 'match');
    assert.ok(errors.some((e) => e.code === 'E_UNKNOWN'));
  });

  it('rejects empty path string', () => {
    const errors = validateMatch({ path: '' }, 'match');
    assert.ok(errors.some((e) => e.code === 'E_TYPE'));
  });

  it('rejects invalid operation value', () => {
    const errors = validateMatch({ path: '**', operation: 'delete' }, 'match');
    assert.ok(errors.some((e) => e.code === 'E_ENUM'));
  });
});

// ---------------------------------------------------------------------------
// validatePolicyYaml
// ---------------------------------------------------------------------------

describe('validatePolicyYaml', () => {
  it('accepts valid policy YAML', () => {
    const yaml = `rules:
  - id: allow-src
    match: { path: "src/**/*.ts", operation: "write" }
    action: allow
    basis: "policy.yaml#allow-src"
  - id: deny-protected
    match: { path: "policy/**" }
    action: deny
    basis: "AGENTS.md#禁区"
`;
    const result = validatePolicyYaml(yaml);
    assert.equal(result.valid, true);
  });

  it('rejects empty content', () => {
    const result = validatePolicyYaml('');
    assert.equal(result.valid, false);
  });

  it('rejects content without rules key', () => {
    const result = validatePolicyYaml('foo: bar');
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.code === 'E_STRUCTURE'));
  });

  it('validates rule action in YAML', () => {
    const yaml = `rules:
  - id: bad-action
    match: { path: "**" }
    action: invalid
    basis: "test"
`;
    const result = validatePolicyYaml(yaml);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.path.includes('action') && e.code === 'E_ENUM'));
  });

  it('validates rule id in YAML', () => {
    const yaml = `rules:
  - id: ""
    match: { path: "**" }
    action: allow
    basis: "test"
`;
    const result = validatePolicyYaml(yaml);
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some((e) => e.path.includes('id') || e.code === 'E_PARSE' || e.code === 'E_EMPTY'),
      `Expected id-related or parse error, got: ${JSON.stringify(result.errors)}`,
    );
  });

  it('detects unclosed inline match object', () => {
    const yaml = `rules:
  - id: bad-match
    match: { path: "src/**/*.ts"
    action: allow
    basis: "test"
`;
    const result = validatePolicyYaml(yaml);
    assert.equal(result.valid, false);
  });

  it('validates with real policy.yaml content', () => {
    const yaml = `rules:
  - id: allow-src-ts
    match: { path: "src/**/*.ts", operation: "write" }
    action: allow
    basis: "policy.yaml#allow-src-ts"
  - id: deny-acceptance-direct
    match: { path: "tests/acceptance/**", operation: "write" }
    action: deny
    basis: "AGENTS.md#禁区-5"
    guidance: "Acceptance tests are frozen with the spec."
  - id: allow-read-all
    match: { path: "**", operation: "read" }
    action: allow
    basis: "policy.yaml#allow-read-all"
    priority: 0
`;
    const result = validatePolicyYaml(yaml);
    assert.equal(result.valid, true);
  });
});

// ---------------------------------------------------------------------------
// validateRuleResult
// ---------------------------------------------------------------------------

describe('validateRuleResult', () => {
  it('returns valid for a correct rule', () => {
    const result = validateRuleResult({ id: 'r1', match: { path: '**' }, action: 'allow', basis: 'test' });
    assert.equal(result.valid, true);
  });

  it('returns invalid for a malformed rule', () => {
    const result = validateRuleResult(null);
    assert.equal(result.valid, false);
  });
});

// ---------------------------------------------------------------------------
// isValidGlobPattern
// ---------------------------------------------------------------------------

describe('isValidGlobPattern', () => {
  it('accepts valid glob patterns', () => {
    assert.equal(isValidGlobPattern('**/*.ts'), true);
    assert.equal(isValidGlobPattern('src/**'), true);
    assert.equal(isValidGlobPattern('*.{ts,js}'), true);
    assert.equal(isValidGlobPattern('policy/**'), true);
  });

  it('rejects empty string', () => {
    assert.equal(isValidGlobPattern(''), false);
    assert.equal(isValidGlobPattern('  '), false);
  });

  it('rejects non-string input', () => {
    assert.equal(isValidGlobPattern(null as unknown as string), false);
    assert.equal(isValidGlobPattern(undefined as unknown as string), false);
  });

  it('rejects unbalanced braces', () => {
    assert.equal(isValidGlobPattern('{a,b'), false);
    assert.equal(isValidGlobPattern('a,b}'), false);
  });
});

// ---------------------------------------------------------------------------
// isValidAction
// ---------------------------------------------------------------------------

describe('isValidAction', () => {
  it('accepts valid actions', () => {
    assert.equal(isValidAction('allow'), true);
    assert.equal(isValidAction('deny'), true);
    assert.equal(isValidAction('ask'), true);
  });

  it('rejects invalid actions', () => {
    assert.equal(isValidAction('forbid'), false);
    assert.equal(isValidAction('grant'), false);
    assert.equal(isValidAction(''), false);
  });
});

// ---------------------------------------------------------------------------
// isValidOperation
// ---------------------------------------------------------------------------

describe('isValidOperation', () => {
  it('accepts valid operations', () => {
    assert.equal(isValidOperation('read'), true);
    assert.equal(isValidOperation('write'), true);
    assert.equal(isValidOperation('execute'), true);
  });

  it('rejects invalid operations', () => {
    assert.equal(isValidOperation('delete'), false);
    assert.equal(isValidOperation(''), false);
    assert.equal(isValidOperation('WRITE'), false);
  });
});
