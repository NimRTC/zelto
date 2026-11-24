// v2-e2e-write-guard 验收：端到端用例存在且覆盖四条验收标准。
// 对应 specs/slices/v2-e2e-write-guard.md。
// 不重跑 git（门禁 worktree 可能无 git），只做静态 + 产物断言 + 真实判定复验。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
const REPO = findRepoRoot(path.resolve(__dirname, '..', '..', '..'));
const E2E_PATH = path.join(REPO, 'tests', 'guard-deny-e2e.test.ts');
const PRETOOL_PATH = path.join(REPO, 'dist', 'hook', 'pretool.js');
const HARNESS_PATH = path.join(REPO, 'dist', 'hook', 'harness.js');

test('tests/guard-deny-e2e.test.ts 存在且为真实断言（非占位）', () => {
  assert.ok(fs.existsSync(E2E_PATH), 'e2e 测试文件必须存在');
  const src = fs.readFileSync(E2E_PATH, 'utf-8');
  assert.ok(src.includes('judgeWriteTargets'), '必须调用逐写判定');
  assert.ok(src.includes('auditWorktreeWrites'), '必须调用审计兜底');
  assert.ok(src.includes('policy.violation'), '必须覆盖事件落盘');
  assert.ok(!src.includes('待需求补齐'), '不许残留占位');
});

test('越界写入三 harness 判定一致为 deny', () => {
  const { judgeWriteTargets, extractWriteTargets } = require(PRETOOL_PATH);
  const { normalizePayload } = require(HARNESS_PATH);
  const WT = path.join('/repo', '.zelto', 'worktrees', 'e2e');
  const outside = path.join(WT, 'other', 'evil.ts');
  const ctx = {
    projectRoot: '/repo',
    worktreeRoot: WT,
    sliceId: 'v2-e2e-write-guard',
    writes: ['src/**'],
    rules: [{ id: 'allow-src', match: { path: 'src/**', operation: 'write' }, action: 'allow', basis: 't' }],
    policyVersion: 'sha256:test',
  };
  const payloads = [
    normalizePayload('claude-code', { tool_name: 'Write', tool_input: { file_path: outside } }),
    normalizePayload('cursor', { tool_name: 'edit_file', tool_input: { path: outside } }),
    normalizePayload('codex', { tool_name: 'apply_patch', tool_input: { path: outside } }),
  ];
  const verdicts = payloads.map((p) => judgeWriteTargets(extractWriteTargets(p), ctx));
  assert.ok(verdicts.every((v) => v.decision === 'deny'));
});

test('审计兜底：越界改动 violations 非空（真实 git 仓库）', () => {
  const { auditWorktreeWrites } = require(path.join(REPO, 'dist', 'core', 'sched', 'audit.js'));
  const { execFileSync } = require('node:child_process');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zelto-e2e-acc-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir });
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'x', 'utf-8');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
    fs.mkdirSync(path.join(dir, 'other'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'other', 'evil.ts'), 'evil', 'utf-8');
    const r = auditWorktreeWrites(dir, ['src/**']);
    assert.equal(r.error, null);
    assert.ok(r.violations.includes('other/evil.ts'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('非越界写入放行', () => {
  const { judgeWriteTargets, extractWriteTargets } = require(PRETOOL_PATH);
  const { normalizePayload } = require(HARNESS_PATH);
  const WT = path.join('/repo', '.zelto', 'worktrees', 'e2e');
  const ctx = {
    projectRoot: '/repo',
    worktreeRoot: WT,
    sliceId: 'v2-e2e-write-guard',
    writes: ['src/**'],
    rules: [{ id: 'allow-src', match: { path: 'src/**', operation: 'write' }, action: 'allow', basis: 't' }],
    policyVersion: 'sha256:test',
  };
  const p = normalizePayload('claude-code', {
    tool_name: 'Write',
    tool_input: { file_path: path.join(WT, 'src', 'a.ts') },
  });
  assert.equal(judgeWriteTargets(extractWriteTargets(p), ctx).decision, 'allow');
});
