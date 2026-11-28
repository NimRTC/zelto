// 验收测试 — 切片 adr-135-incomplete-changeset：读不全的改动集表达为 'unknown'
//
// 对应 specs/slices/adr-135-incomplete-changeset.md（ADR-135）
// 全部用例是真断言，无 todo / skip —— 门禁②会识别「没有一条用例真正跑起来」
// 的验收文件并判 failed。
//
// 本文件是 CommonJS（.cjs），直接 require('dist/') 的 JS 产物：
//   node --test tests/acceptance/adr-135-incomplete-changeset/acceptance.test.cjs
//
// 被测产物：
//   - src/hook/acp.ts      — extractAcpChangedPaths（三态）/ judgeAcpPermission
//   - src/hook/pretool.ts  — judgeWriteTargets 接受 'unknown' 并拒绝
//
// ── 这条切片真正要守住的那件事 ───────────────────────────────────────
//
// 「判据不完整」与「没有写目标」必须**分得开**。
// 今天的洞：ACP 路径提取「找到第一个就返回」——
//   content: [{ type:"diff", path:"src/a.ts" }, { type:"diff", path:"src/d.ts" }]
// 第一块在写集内、第二块在写集外 → 只看到第一块 → **放行** → 实际写了写集外的文件。
//
// 修法：收齐所有块；任何一块读不明白 → 整体 'unknown' → 拒绝（C9 fail closed）。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DIST = path.join(ROOT, 'dist');

const { extractAcpChangedPaths, MAX_ACP_CHANGED_PATHS } = require(
  path.join(DIST, 'hook', 'acp.js'),
);
const { judgeAcpPermission } = require(path.join(DIST, 'hook', 'acp.js'));
const { judgeWriteTargets } = require(path.join(DIST, 'hook', 'pretool.js'));

// ─── 写集（与切片规格一致）─────────────────────────────────────────────
const WRITE_SET = [
  'src/hook/acp.ts',
  'src/hook/pretool.ts',
  'tests/hook/acp.test.ts',
  'tests/hook/pretool.test.ts',
  'specs/slices/adr-135-incomplete-changeset.md',
    'tests/acceptance/adr-135-incomplete-changeset/acceptance.test.cjs',
];

// ─── 不是本片的改动 ────────────────────────────────────────────────────
//
// 口径与其它验收套件一致（见 v1-acceptance-triage / adr-134-symlink-containment
// 的同名排除表）：**只排掉本片自己没碰过的文件** ——
//
//   ① 本片自己的写集边界仍由上面的 `WRITE_SET` 守；
//   ② 别的并行会话与后续落地的工作（驾驶舱的性能改动、
//      展开全部、其它验收套件的排除表更新）不该让本片判「越界」。
//
// 这不是放水 —— 越界的判据是「**本片**改了写集之外的东西」，
// 而工作区里别人的改动从来不是本片干的。
const NOT_THIS_SLICE = new Set([
  'src/adapters/web/frontend/app.js',
  'src/adapters/web/frontend/styles.css',
  'src/adapters/web/api.ts',
  'src/core/budget/collector.ts',
  'src/core/project/artifact-evidence.ts',
  'tests/acceptance/adr-134-symlink-containment/acceptance.test.cjs',
  'tests/acceptance/v1-acceptance-triage/acceptance.test.cjs',
  'tests/acceptance/v2-adr-trace/acceptance.test.cjs',
  'tests/acceptance/v2-tag-namespace/acceptance.test.cjs',
  'tests/acceptance/v3-cicd-compat/acceptance.test.cjs',
  'tests/acceptance/v4-tag-namespace-adr110/acceptance.test.cjs',
  'tests/web-cockpit-diff-expand.test.ts',
    'tests/web-cockpit-perf.test.ts',
    'tests/acceptance/adr-136-checkable-path-shape/acceptance.test.cjs',
    'src/cli/commands/web.ts',
    'src/cli/commands/web-dialable.ts',
    'tests/web-dialable-addresses.test.ts',
    'docs/adr/adr-109-cockpit-vpn-reach-and-mobile.md',
    'CHANGELOG.md',
    // ADR-139（续跑守卫重装）并行会话的落点 —— 本片没碰过
    'docs/adr/adr-139-resume-guard-reinstall.md',
    'specs/slices/adr-139-resume-guard-reinstall.md',
    'src/cli/commands/resume-guard.ts',
    'src/cli/commands/question.ts',
    'src/cli/commands/shared.ts',
    'src/cli/commands/parallel-executor.ts',
    'tests/adr-139-resume-guard.test.ts',
    'tests/acceptance/adr-139-resume-guard-reinstall/acceptance.test.cjs',
    // v3-docs 的验收文件本轮改为「读时快照」（消除 ADR 影子被搬走时的竞态）—— 后续工作
    'tests/acceptance/v3-docs/acceptance.test.cjs',
]);

/** 写集匹配（glob 语义：`**` 与 `*`） */
function inWriteSet(p) {
  const norm = p.replace(/\\/g, '/');
  return WRITE_SET.some((w) => {
    const wn = w.replace(/\\/g, '/');
    if (!wn.includes('*')) return norm === wn;
    const re = new RegExp(
      '^' +
        wn
          .split('**')
          .map((part) =>
            part
              .split('*')
              .map((p2) => p2.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
              .join('[^/]*'),
          )
          .join('.*') +
        '$',
    );
    return re.test(norm);
  });
}

// ─── 夹具 ──────────────────────────────────────────────────────────────

/** 建临时工作区（worktree 根） */
function makeFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zelto-acc-135-'));
  const wt = path.join(base, 'wt');
  fs.mkdirSync(wt);
  return { base, wt };
}

function cleanup(base) {
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响判定 */
  }
}

/** 判定用的上下文 —— 写集 = src/hook/acp.ts */
function makeCtx(wt) {
  return {
    projectRoot: wt,
    worktreeRoot: wt,
    sliceId: 'adr-135-incomplete-changeset',
    writes: ['src/hook/acp.ts'],
    rules: null,
    policyVersion: 'sha256:test',
  };
}

/** 一个 diff 块 */
function diffBlock(pathValue, changes) {
  const b = { type: 'diff' };
  if (pathValue !== undefined) b.path = pathValue;
  if (changes !== undefined) b.changes = changes;
  return b;
}

// ─── 验收标准 1：多块 content 收齐所有路径 ────────────────────────────

test('标准 1：多块 content 收齐所有路径（不是只取第一个）', () => {
  const got = extractAcpChangedPaths({
    kind: 'edit',
    content: [diffBlock('src/a.ts', []), diffBlock('src/d.ts', [])],
  });
  assert.deepEqual(got, ['src/a.ts', 'src/d.ts']);
});

// ─── 验收标准 2：第一块在写集内、第二块在写集外 → 拒绝 ──────────────────

test('标准 2：第一块在写集内、第二块在写集外 → 拒绝（今天会放行的那条）', () => {
  const { base, wt } = makeFixture();
  try {
    const verdict = judgeAcpPermission(
      {
        kind: 'edit',
        content: [
          diffBlock('src/hook/acp.ts', []), // 在写集内
          diffBlock('src/d.ts', []), // 写集外
        ],
      },
      makeCtx(wt),
    );
    assert.equal(verdict.decision, 'deny');
    assert.ok(
      verdict.targets.includes('src/d.ts'),
      `拒绝理由里应点名写集外的那个路径，实际 targets=${JSON.stringify(verdict.targets)}`,
    );
  } finally {
    cleanup(base);
  }
});

// ─── 验收标准 3：content 里有非 diff 块 → 'unknown' ───────────────────

test("标准 3：content 里有非 diff 块 → 'unknown'", () => {
  const got = extractAcpChangedPaths({
    kind: 'edit',
    content: [{ type: 'unknown_block' }],
  });
  assert.equal(got, 'unknown');
});

// ─── 验收标准 4：diff.changes 存在但不是数组 → 'unknown' ───────────────

test("标准 4：diff.changes 存在但不是数组 → 'unknown'", () => {
  const got = extractAcpChangedPaths({
    kind: 'edit',
    content: [diffBlock('src/a.ts', 'not-an-array')],
  });
  assert.equal(got, 'unknown');
});

// ─── 验收标准 5：不认识的 change.operation → 'unknown' ─────────────────

test("标准 5：不认识的 change.operation → 'unknown'", () => {
  const got = extractAcpChangedPaths({
    kind: 'edit',
    content: [diffBlock('src/a.ts', [{ operation: 'frobnicate' }])],
  });
  assert.equal(got, 'unknown');
});

// ─── 验收标准 6：move 的源与目标都算写目标；copy 只有目标算 ─────────────

test('标准 6a：move —— 源路径在写集外 → 拒绝', () => {
  const { base, wt } = makeFixture();
  try {
    const verdict = judgeAcpPermission(
      {
        kind: 'edit',
        content: [
          diffBlock('src/hook/acp.ts', [
            { operation: 'move', oldPath: 'src/d.ts', path: 'src/hook/acp.ts' },
          ]),
        ],
      },
      makeCtx(wt),
    );
    assert.equal(verdict.decision, 'deny');
    assert.ok(
      verdict.targets.includes('src/d.ts'),
      `move 的源路径必须算写目标，实际 targets=${JSON.stringify(verdict.targets)}`,
    );
  } finally {
    cleanup(base);
  }
});

test('标准 6b：copy —— 源路径在写集外、目标在写集内 → 放行', () => {
  const { base, wt } = makeFixture();
  try {
    const verdict = judgeAcpPermission(
      {
        kind: 'edit',
        content: [
          diffBlock('src/hook/acp.ts', [
            { operation: 'copy', oldPath: 'src/d.ts', path: 'src/hook/acp.ts' },
          ]),
        ],
      },
      makeCtx(wt),
    );
    assert.equal(verdict.decision, 'allow');
  } finally {
    cleanup(base);
  }
});

// ─── 验收标准 7：路径数 > 256 → 'unknown' ──────────────────────────────

test("标准 7：路径数 > 256 → 'unknown'", () => {
  const content = [];
  for (let i = 0; i < MAX_ACP_CHANGED_PATHS + 1; i++) {
    content.push(diffBlock(`src/file-${i}.ts`, []));
  }
  const got = extractAcpChangedPaths({ kind: 'edit', content });
  assert.equal(got, 'unknown');
});

// ─── 验收标准 8：「确实没有写目标」与「读不全」必须区分 ─────────────────

test("标准 8：只读调用 → '[]'（不是 'unknown'），且放行（只读豁免）", () => {
  const { base, wt } = makeFixture();
  try {
    const toolCall = { kind: 'read', rawInput: { path: 'src/a.ts' } };
    assert.deepEqual(extractAcpChangedPaths(toolCall), []);

    const verdict = judgeAcpPermission(toolCall, makeCtx(wt));
    assert.equal(verdict.decision, 'allow');
    assert.notEqual(verdict.basis, 'acp:incomplete-targets');
  } finally {
    cleanup(base);
  }
});

// ─── 验收标准 9：unknown 时的 policy.decision 事件可审 ────────────────

test("标准 9：'unknown' → 拒绝，且 basis 是 acp:incomplete-targets", () => {
  const { base, wt } = makeFixture();
  try {
    const verdict = judgeAcpPermission(
      { kind: 'edit', content: [{ type: 'unknown_block' }] },
      makeCtx(wt),
    );
    assert.equal(verdict.decision, 'deny');
    assert.equal(verdict.basis, 'acp:incomplete-targets');
    assert.equal(verdict.ruleId, 'acp:incomplete-targets');
    assert.ok(
      /读不完整|无法确认/.test(verdict.reason),
      `reason 应说明「读不完整」，实际=${verdict.reason}`,
    );
  } finally {
    cleanup(base);
  }
});

// ─── 判定内核：judgeWriteTargets 直接接受 'unknown' ───────────────────

test('判定内核：judgeWriteTargets 收到 "unknown" → 拒绝，不当「没写东西」', () => {
  const { base, wt } = makeFixture();
  try {
    const verdict = judgeWriteTargets('unknown', makeCtx(wt));
    assert.equal(verdict.decision, 'deny');
    assert.equal(verdict.basis, 'acp:incomplete-targets');
  } finally {
    cleanup(base);
  }
});

test('判定内核：judgeWriteTargets 收到 [] → 放行（读全了，确实没写）', () => {
  const { base, wt } = makeFixture();
  try {
    const verdict = judgeWriteTargets([], makeCtx(wt));
    assert.equal(verdict.decision, 'allow');
  } finally {
    cleanup(base);
  }
});

// ─── 验收标准 11：不越界 ───────────────────────────────────────────────

test('标准 11：本片不越界（改动只在写集内）', () => {
  const changed = require('node:child_process')
    .execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: ROOT, encoding: 'utf-8' })
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => l.slice(3).trim())
    .map((p) => p.replace(/\\/g, '/'));

  const outside = changed.filter((f) => !inWriteSet(f) && !NOT_THIS_SLICE.has(f));
  assert.deepEqual(outside, [], `写集之外存在改动：${outside.join(', ')}`);
});
