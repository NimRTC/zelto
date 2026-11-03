// Tests for the PreToolUse hook's decision logic (ADR-014 §3.2)
//
// The hook must fail closed: anything it cannot judge is a deny.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import {
  type PreToolContext,
  extractWriteTargets,
  extractBashWriteTargets,
  isProtectedPath,
  judgeWriteTargets,
  parsePolicyRules,
  relativizeTarget,
} from '../../src/hook/pretool.js';

const WORKTREE = join('/', 'repo', '.zelto', 'worktrees', 'slice-a');

function ctx(overrides: Partial<PreToolContext> = {}): PreToolContext {
  return {
    projectRoot: join('/', 'repo'),
    worktreeRoot: WORKTREE,
    sliceId: 'slice-a',
    writes: ['src/core/**'],
    rules: null,
    policyVersion: 'sha256:test',
    ...overrides,
  };
}

describe('relativizeTarget', () => {
  it('makes an absolute path relative to the worktree', () => {
    assert.equal(relativizeTarget(join(WORKTREE, 'src', 'a.ts'), WORKTREE), 'src/a.ts');
  });

  it('resolves a relative path against the worktree', () => {
    assert.equal(relativizeTarget('src/a.ts', WORKTREE), 'src/a.ts');
  });

  it('returns null when the target escapes the worktree', () => {
    assert.equal(relativizeTarget('/etc/passwd', WORKTREE), null);
    assert.equal(relativizeTarget('../outside.ts', WORKTREE), null);
  });
});

describe('isProtectedPath', () => {
  it('protects the policy, the state directory and the agent instructions', () => {
    assert.equal(isProtectedPath('policy/policy.yaml'), true);
    assert.equal(isProtectedPath('.zelto/slices/a.json'), true);
    assert.equal(isProtectedPath('AGENTS.md'), true);
    assert.equal(isProtectedPath('.cursor/rules/x.mdc'), true);
  });

  it('does not protect ordinary source files', () => {
    assert.equal(isProtectedPath('src/core/a.ts'), false);
  });
});

describe('extractWriteTargets', () => {
  it('reads the target of a Write tool call', () => {
    const targets = extractWriteTargets({
      tool_name: 'Write',
      tool_input: { file_path: '/repo/src/a.ts' },
    });
    assert.deepEqual(targets, ['/repo/src/a.ts']);
  });

  it('reads the target of an Edit tool call', () => {
    const targets = extractWriteTargets({
      tool_name: 'Edit',
      tool_input: { file_path: '/repo/src/a.ts' },
    });
    assert.deepEqual(targets, ['/repo/src/a.ts']);
  });

  it('reads the target of a NotebookEdit tool call', () => {
    const targets = extractWriteTargets({
      tool_name: 'NotebookEdit',
      tool_input: { notebook_path: '/repo/nb.ipynb' },
    });
    assert.deepEqual(targets, ['/repo/nb.ipynb']);
  });

  it('finds shell redirect targets', () => {
    const targets = extractBashWriteTargets('echo hi > out.txt');
    assert.deepEqual(targets, ['out.txt']);
  });

  it('finds the destination of mv and cp', () => {
    assert.ok(extractBashWriteTargets('mv a.ts b.ts').includes('b.ts'));
    assert.ok(extractBashWriteTargets('cp a.ts b.ts').includes('b.ts'));
  });

  it('finds in-place sed targets', () => {
    assert.ok(extractBashWriteTargets('sed -i "s/a/b/" file.ts').includes('file.ts'));
  });

  it('ignores commands that do not write', () => {
    assert.deepEqual(extractBashWriteTargets('ls -la'), []);
    assert.deepEqual(extractBashWriteTargets('cat README.md'), []);
  });
});

describe('judgeWriteTargets', () => {
  it('allows a write inside the write-set', () => {
    const verdict = judgeWriteTargets([join(WORKTREE, 'src/core/a.ts')], ctx());
    assert.equal(verdict.decision, 'allow');
  });

  it('denies a write outside the write-set', () => {
    const verdict = judgeWriteTargets([join(WORKTREE, 'src/policy/a.ts')], ctx());
    assert.equal(verdict.decision, 'deny');
    assert.equal(verdict.ruleId, 'writes:slice-a');
  });

  it('denies a write that escapes the worktree', () => {
    const verdict = judgeWriteTargets(['/etc/passwd'], ctx());
    assert.equal(verdict.decision, 'deny');
    assert.equal(verdict.basis, 'AGENTS.md#禁区');
  });

  it('denies a write into the protected domain even when it is inside the write-set', () => {
    const verdict = judgeWriteTargets([join(WORKTREE, 'policy/policy.yaml')], ctx({
      writes: ['policy/**'],
    }));
    assert.equal(verdict.decision, 'deny');
    assert.equal(verdict.basis, 'AGENTS.md#禁区');
  });

  it('denies everything when the reservation is missing', () => {
    const verdict = judgeWriteTargets([join(WORKTREE, 'src/core/a.ts')], ctx({ writes: null }));
    assert.equal(verdict.decision, 'deny');
    assert.equal(verdict.ruleId, 'reservation:missing');
  });

  it('allows when there are no targets to judge', () => {
    const verdict = judgeWriteTargets([], ctx());
    assert.equal(verdict.decision, 'allow');
    assert.equal(verdict.basis, 'hook:no-target');
  });

  it('applies policy rules when there are no slice constraints', () => {
    const rules = parsePolicyRules(
      [
        'rules:',
        '  - id: deny-docs',
        '    match: { path: "docs/**" }',
        '    action: deny',
        '    basis: "policy.yaml#docs"',
        '  - id: allow-src',
        '    match: { path: "src/**" }',
        '    action: allow',
        '    basis: "policy.yaml#src"',
      ].join('\n'),
    );

    const denied = judgeWriteTargets([join(WORKTREE, 'docs/a.md')], ctx({
      sliceId: null,
      writes: null,
      rules,
    }));
    assert.equal(denied.decision, 'deny');
    assert.equal(denied.ruleId, 'deny-docs');

    const allowed = judgeWriteTargets([join(WORKTREE, 'src/a.ts')], ctx({
      sliceId: null,
      writes: null,
      rules,
    }));
    assert.equal(allowed.decision, 'allow');
  });

  it('denies when the policy asks for confirmation (non-interactive run)', () => {
    const rules = parsePolicyRules(
      [
        '  - id: ask-docs',
        '    match: { path: "docs/**" }',
        '    action: ask',
        '    basis: "policy.yaml#docs"',
      ].join('\n'),
    );

    const verdict = judgeWriteTargets([join(WORKTREE, 'docs/a.md')], ctx({
      sliceId: null,
      writes: null,
      rules,
    }));
    assert.equal(verdict.decision, 'deny');
    assert.match(verdict.reason, /人工确认/);
  });

  it('denies when there is no policy file and no reservation', () => {
    const verdict = judgeWriteTargets([join(WORKTREE, 'src/a.ts')], ctx({
      sliceId: null,
      writes: null,
      rules: null,
    }));
    assert.equal(verdict.decision, 'deny');
    assert.equal(verdict.ruleId, 'policy:missing');
  });

  it('falls back to the write-set when there is no policy file', () => {
    const verdict = judgeWriteTargets([join(WORKTREE, 'src/core/a.ts')], ctx({ rules: null }));
    assert.equal(verdict.decision, 'allow');
    assert.equal(verdict.basis, 'reservation:only');
  });
});
