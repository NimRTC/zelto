import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judgeWriteTargets, extractWriteTargets } from '../src/hook/pretool.js';
import { normalizePayload } from '../src/hook/harness.js';
import { auditWorktreeWrites } from '../src/core/sched/audit.js';
import { EventStream } from '../src/core/events/stream.js';

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zelto-guard-e2e-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# test\n');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'ok.ts'), 'export const ok = 1;\n', 'utf-8');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

const WORKTREE = join('/repo', '.zelto', 'worktrees', 'e2e');

function baseCtx() {
  return {
    projectRoot: '/repo',
    worktreeRoot: WORKTREE,
    sliceId: 'v2-e2e-write-guard',
    writes: ['src/**'],
    rules: [
      { id: 'allow-src', match: { path: 'src/**', operation: 'write' }, action: 'allow' as const, basis: 'test#allow-src' },
    ],
    policyVersion: 'sha256:test',
  };
}

describe('v2-e2e-write-guard: 越界被拦端到端', () => {
  let repo: string;
  let eventsDir: string;

  beforeEach(() => {
    repo = makeRepo();
    eventsDir = mkdtempSync(join(tmpdir(), 'zelto-e2e-events-'));
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(eventsDir, { recursive: true, force: true });
  });

  it('越界写入被逐写判定拒绝（三 harness 信封一致）', () => {
    const outside = join(WORKTREE, 'other', 'evil.ts');
    const payloads = [
      normalizePayload('claude-code', { tool_name: 'Write', tool_input: { file_path: outside } }),
      normalizePayload('cursor', { tool_name: 'edit_file', tool_input: { path: outside } }),
      normalizePayload('codex', { tool_name: 'apply_patch', tool_input: { path: outside } }),
    ];
    const verdicts = payloads.map((p) => judgeWriteTargets(extractWriteTargets(p), baseCtx()));
    for (const v of verdicts) {
      assert.equal(v.decision, 'deny');
    }
    assert.equal(new Set(verdicts.map((v) => v.decision)).size, 1);
  });

  it('未预约路径判定为 reservation:missing（默认拒绝）', () => {
    const p = normalizePayload('claude-code', {
      tool_name: 'Write',
      tool_input: { file_path: join(WORKTREE, 'src', 'a.ts') },
    });
    const verdict = judgeWriteTargets(extractWriteTargets(p), { ...baseCtx(), writes: null });
    assert.equal(verdict.decision, 'deny');
    assert.equal(verdict.ruleId, 'reservation:missing');
  });

  it('git 真实改动的审计兜底非空', () => {
    writeFileSync(join(repo, 'src', 'ok.ts'), 'export const ok = 2;\n', 'utf-8');
    mkdirSync(join(repo, 'other'), { recursive: true });
    writeFileSync(join(repo, 'other', 'evil.ts'), 'export const evil = 1;\n', 'utf-8');
    const result = auditWorktreeWrites(repo, ['src/**']);
    assert.equal(result.error, null);
    assert.ok(result.violations.includes('other/evil.ts'));
    assert.ok(result.violations.length >= 1);
  });

  it('审计结论落盘为 policy.violation 事件', async () => {
    const stream = new EventStream(eventsDir);
    writeFileSync(join(repo, 'other2.ts'), 'export const x = 1;\n', 'utf-8');
    const result = auditWorktreeWrites(repo, ['src/**']);
    assert.ok(result.violations.length >= 1);
    const ev = await stream.append('v2-e2e-write-guard', 'policy.violation', 'test', {
      kind: 'write-outside-write-set',
      violations: result.violations,
      changed: result.changed,
    });
    assert.equal(ev.type, 'policy.violation');
    const chain = await stream.loadChain('v2-e2e-write-guard');
    assert.equal(chain.length, 1);
    assert.deepEqual((chain[0].payload as { violations: string[] }).violations, result.violations);
  });

  it('写集内且策略允许的路径放行', () => {
    const p = normalizePayload('claude-code', {
      tool_name: 'Write',
      tool_input: { file_path: join(WORKTREE, 'src', 'a.ts') },
    });
    const verdict = judgeWriteTargets(extractWriteTargets(p), baseCtx());
    assert.equal(verdict.decision, 'allow');
  });
});
