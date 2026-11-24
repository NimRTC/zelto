// v2-hook-write-guard 验收：预约→逐写判定→审计链路可用
// 对应 specs/slices/v2-hook-write-guard.md 四条验收标准。
// 用编译产物 dist/hook/pretool.js 与 dist/core/sched/audit.js 跑真实逻辑。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

function findRepoRoot(start) {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'dist', 'cli', 'index.js'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}
const ROOT = findRepoRoot(path.resolve(__dirname, '..', '..', '..'));
const REPO = ROOT;
const PRETOOL_PATH = path.join(REPO, 'dist', 'hook', 'pretool.js');
const AUDIT_PATH = path.join(REPO, 'dist', 'core', 'sched', 'audit.js');

const WORKTREE = path.join('/repo', '.zelto', 'worktrees', 'e2e');

function baseCtx() {
  return {
    projectRoot: '/repo',
    worktreeRoot: WORKTREE,
    sliceId: 'v2-hook-write-guard',
    writes: ['src/**'],
    rules: [
      { id: 'allow-src', match: { path: 'src/**', operation: 'write' }, action: 'allow', basis: 'test#allow-src' },
    ],
    policyVersion: 'sha256:test',
  };
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zelto-hook-acc-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'ok.ts'), 'export const ok = 1;\n', 'utf-8');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

test('预约缺失时逐写判定默认拒绝（reservation:missing）', () => {
  const { judgeWriteTargets, extractWriteTargets } = require(PRETOOL_PATH);
  const { normalizePayload } = require(path.join(REPO, 'dist', 'hook', 'harness.js'));
  const p = normalizePayload('claude-code', {
    tool_name: 'Write',
    tool_input: { file_path: path.join(WORKTREE, 'src', 'a.ts') },
  });
  const verdict = judgeWriteTargets(extractWriteTargets(p), { ...baseCtx(), writes: null });
  assert.equal(verdict.decision, 'deny');
  assert.equal(verdict.ruleId, 'reservation:missing');
});

test('写集外路径被逐写判定拒绝', () => {
  const { judgeWriteTargets, extractWriteTargets } = require(PRETOOL_PATH);
  const { normalizePayload } = require(path.join(REPO, 'dist', 'hook', 'harness.js'));
  const p = normalizePayload('claude-code', {
    tool_name: 'Write',
    tool_input: { file_path: path.join(WORKTREE, 'other', 'evil.ts') },
  });
  const verdict = judgeWriteTargets(extractWriteTargets(p), baseCtx());
  assert.equal(verdict.decision, 'deny');
  assert.ok(String(verdict.ruleId || '').startsWith('writes:'));
});

test('写集内路径被逐写判定放行', () => {
  const { judgeWriteTargets, extractWriteTargets } = require(PRETOOL_PATH);
  const { normalizePayload } = require(path.join(REPO, 'dist', 'hook', 'harness.js'));
  const p = normalizePayload('claude-code', {
    tool_name: 'Write',
    tool_input: { file_path: path.join(WORKTREE, 'src', 'a.ts') },
  });
  const verdict = judgeWriteTargets(extractWriteTargets(p), baseCtx());
  assert.equal(verdict.decision, 'allow');
});

test('运行后审计能识别越界改动（violations 非空）', () => {
  const { auditWorktreeWrites } = require(AUDIT_PATH);
  const repo = makeRepo();
  try {
    fs.mkdirSync(path.join(repo, 'other'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'other', 'evil.ts'), 'export const evil = 1;\n', 'utf-8');
    const result = auditWorktreeWrites(repo, ['src/**']);
    assert.equal(result.error, null);
    assert.ok(result.violations.includes('other/evil.ts'));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
