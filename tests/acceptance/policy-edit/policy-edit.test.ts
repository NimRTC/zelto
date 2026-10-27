// Acceptance test: policy-edit
// Verifies that zelto policy edit works correctly

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const BASE_DIR = join(tmpdir(), `zelto-acceptance-policy-edit-${Date.now()}`);
const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');

const POLICY_YAML = `rules:
  - id: rule-one
    match: { path: "src/**", operation: "write" }
    action: allow
    basis: "test#one"
  - id: rule-two
    match: { path: "docs/**", operation: "write" }
    action: deny
    basis: "test#two"
`;

function zelto(...args: string[]): { stdout: string; stderr: string; code: number } {
  const result = spawnSync('node', [CLI_SCRIPT, ...args], {
    cwd: BASE_DIR,
    encoding: 'utf-8',
    timeout: 10000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    code: result.status ?? 1,
  };
}

describe('acceptance: policy-edit', { concurrency: false }, () => {
  before(async () => {
    await rm(BASE_DIR, { recursive: true, force: true });
    await mkdir(BASE_DIR, { recursive: true });
    await mkdir(join(BASE_DIR, '.zelto', 'slices'), { recursive: true });
    await mkdir(join(BASE_DIR, 'policy'), { recursive: true });
    await writeFile(join(BASE_DIR, 'policy', 'policy.yaml'), POLICY_YAML, 'utf-8');
  });

  after(async () => {
    await rm(BASE_DIR, { recursive: true, force: true });
  });

  it('edit changes action from allow to deny', () => {
    const result = zelto('policy', 'edit', 'rule-one', '--action', 'deny');
    assert.equal(result.code, 0, `edit should exit 0: ${result.stderr}`);
    assert.ok(result.stdout.includes('action: deny'), 'should show changed action');
  });

  it('edit changes path and basis simultaneously', () => {
    const result = zelto('policy', 'edit', 'rule-two', '--path', 'config/**', '--basis', 'test#two-edited');
    assert.equal(result.code, 0, `edit should exit 0: ${result.stderr}`);
    assert.ok(result.stdout.includes('path: config/**'), 'should show changed path');
    assert.ok(result.stdout.includes('basis: test#two-edited'), 'should show changed basis');
  });

  it('list shows updated rules after edits', () => {
    const result = zelto('policy', 'list');
    assert.equal(result.code, 0, `list should exit 0: ${result.stderr}`);
    assert.ok(result.stdout.includes('deny'), 'rule-one should now be deny');
    assert.ok(result.stdout.includes('config/**'), 'rule-two path should be updated');
  });

  it('edit nonexistent rule shows error', () => {
    const result = zelto('policy', 'edit', 'nonexistent', '--action', 'allow');
    assert.equal(result.code, 1, 'edit nonexistent should exit 1');
    assert.ok(result.stderr.includes('not found'), 'should show not found error');
  });

  it('edit without changes shows error', () => {
    const result = zelto('policy', 'edit', 'rule-one');
    assert.equal(result.code, 1, 'edit without changes should exit 1');
    assert.ok(result.stderr.includes('No changes'), 'should show no changes error');
  });

  it('validate still passes after edits', () => {
    const result = zelto('policy', 'validate');
    assert.equal(result.code, 0, 'validate should exit 0');
    assert.ok(result.stdout.includes('PASSED'), 'should show PASSED');
  });

  it('edit --json outputs valid JSON', () => {
    const result = zelto('policy', 'edit', 'rule-one', '--action', 'allow', '--json');
    assert.equal(result.code, 0, `edit --json should exit 0: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.success, true);
    assert.equal(parsed.ruleId, 'rule-one');
    assert.equal(parsed.changes.action, 'allow');
  });
});
