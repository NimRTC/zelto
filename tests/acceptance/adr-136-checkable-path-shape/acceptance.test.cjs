// 验收测试 — 切片 adr-136-checkable-path-shape：可检查路径的形状判据
//
// 对应 specs/slices/adr-136-checkable-path-shape.md（ADR-136）
// 全部用例是真断言，无 todo / skip —— 门禁②会识别「没有一条用例真正跑起来」
// 的验收文件并判 failed。
//
// 本文件是 CommonJS（.cjs），直接 require('dist/') 的 JS 产物：
//   node --test tests/acceptance/adr-136-checkable-path-shape/acceptance.test.cjs
//
// 被测产物：
//   - src/hook/paths.ts     — isCheckablePath（形状判据）
//   - src/hook/pretool.ts   — judgeWriteTargets（判定内核的形状闸门）
//   - src/hook/acp.ts       — extractAcpChangedPaths（ACP 提取层报 unknown）
//
// ── 这一片真正要守住的那件事 ─────────────────────────────────────────
//
// 「这个值是不是一条路径」必须在**归一化之前**回答。
// 词法归一化只会把畸形值改写成 worktree 内的相对路径：
//
//   file:///etc/passwd  →  <worktree>/file:/etc/passwd  → 落在写集内 → 放行
//   ~/../../etc/passwd  →  <worktree>/~/../../etc/passwd → 归一化后仍越界
//   a\0b               →  fs 调用抛 ERR_INVALID_ARG_VALUE → 判定层崩掉
//
// 而 agent 真正要写的是 `/etc/passwd`。
// 判定的对象必须是「agent 真正会写的那个文件」，而不是「一个我们能归一化的字符串」。
//
// ── 这一片最容易被做错的地方 ─────────────────────────────────────────
//
// 形状闸门必须放在**判定内核**（judgeWriteTargets），不是提取层。
// 提取层过滤掉畸形值 = 提取结果为空 = judgeWriteTargets([]) = **放行**
// （空目标是 allow，不是 deny —— 实测 2026-11-27）。
// 静默过滤 = 把「可能有写目标」当成「没有写目标」——
// 那等于把这一片要堵的洞亲手放开了。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DIST = path.join(ROOT, 'dist');

const { isCheckablePath } = require(path.join(DIST, 'hook', 'paths.js'));
const { judgeWriteTargets } = require(path.join(DIST, 'hook', 'pretool.js'));
const { extractAcpChangedPaths, judgeAcpPermission } = require(path.join(DIST, 'hook', 'acp.js'));

// ─── 写集（与切片规格一致）─────────────────────────────────────────────
const WRITE_SET = [
  'src/hook/paths.ts',
  'src/hook/acp.ts',
  'src/hook/pretool.ts',
  'tests/hook/paths.test.ts',
  'tests/hook/acp.test.ts',
  'specs/slices/adr-136-checkable-path-shape.md',
  'tests/acceptance/adr-136-checkable-path-shape/acceptance.test.cjs',
];

// ─── 不是本片的改动 ────────────────────────────────────────────────────
//
// 口径与其它验收套件一致：只排掉**本片自己没碰过**的文件 ——
// 别的并行会话与后续落地的工作（驾驶舱的性能改动、ADR-138 的架构扫描
// 工具脚本改动、其它验收套件的排除表更新）不该让本片判「越界」。
//
// 这不是放水 —— 越界的判据是「**本片**改了写集之外的东西」，
// 而工作区里别人的改动从来不是本片干的。
const NOT_THIS_SLICE = new Set([
  'src/adapters/web/frontend/app.js',
  'src/adapters/web/frontend/styles.css',
  'src/adapters/web/api.ts',
  'src/core/budget/collector.ts',
  'src/core/project/artifact-evidence.ts',
  'src/core/arch/index.ts',
  'src/core/arch/scan.ts',
  'src/core/arch/tooling-files.ts',
  'docs/adr/adr-136-checkable-path-shape.md',
  'docs/adr/adr-138-tooling-scripts-are-not-architecture.md',
  'tests/arch-tooling-files.test.ts',
  'tests/.tmp-probe-tooling.test.ts',
  '.tmp-probe-tooling.ts',
  'tests/web-cockpit-diff-expand.test.ts',
  'tests/web-cockpit-perf.test.ts',
  'tests/acceptance/adr-134-symlink-containment/acceptance.test.cjs',
  'tests/acceptance/adr-135-incomplete-changeset/acceptance.test.cjs',
  'tests/acceptance/v1-acceptance-triage/acceptance.test.cjs',
  'tests/acceptance/v2-adr-trace/acceptance.test.cjs',
  'tests/acceptance/v2-tag-namespace/acceptance.test.cjs',
  'tests/acceptance/v3-cicd-compat/acceptance.test.cjs',
  'tests/acceptance/v4-tag-namespace-adr110/acceptance.test.cjs',
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
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zelto-acc-136-'));
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

/** 判定用的上下文 —— 写集可定制 */
function makeCtx(wt, writes) {
  return {
    projectRoot: wt,
    worktreeRoot: wt,
    sliceId: 'adr-136-checkable-path-shape',
    writes: writes,
    rules: null,
    policyVersion: 'sha256:test',
  };
}

// ─── 验收标准 1：~ 开头 → 不是路径 ────────────────────────────────────

test('标准 1：~/../../etc/passwd → 不是路径，且走完整判定是拒绝', () => {
  assert.equal(isCheckablePath('~/../../etc/passwd'), false);

  const { base, wt } = makeFixture();
  try {
    const verdict = judgeWriteTargets(['~/../../etc/passwd'], makeCtx(wt, ['src/hook/paths.ts']));
    assert.equal(verdict.decision, 'deny');
    assert.equal(verdict.basis, 'hook:malformed-path');
  } finally {
    cleanup(base);
  }
});

// ─── 验收标准 2：URL scheme → 不是路径 ────────────────────────────────

test('标准 2：file:///etc/passwd → 不是路径，且走完整判定是拒绝', () => {
  assert.equal(isCheckablePath('file:///etc/passwd'), false);

  const { base, wt } = makeFixture();
  try {
    const verdict = judgeWriteTargets(['file:///etc/passwd'], makeCtx(wt, ['src/hook/paths.ts']));
    assert.equal(verdict.decision, 'deny');
    assert.equal(verdict.basis, 'hook:malformed-path');
  } finally {
    cleanup(base);
  }
});

// ─── 验收标准 3：含 NUL 字节 → 不是路径，且判定流程不抛异常 ────────────

test('标准 3：含 NUL 字节 → 不是路径，且整条判定流程正常返回（不抛）', () => {
  assert.equal(isCheckablePath('a\0b'), false);

  const { base, wt } = makeFixture();
  try {
    // 不加形状闸门时，ADR-134 的 realpath 遇到 NUL 会抛 ERR_INVALID_ARG_VALUE
    // —— 崩掉，而不是 fail closed。这条不能省：只测「返回 false」不够。
    const verdict = judgeWriteTargets(['a\0b'], makeCtx(wt, ['src/hook/paths.ts']));
    assert.equal(verdict.decision, 'deny');
    assert.equal(verdict.basis, 'hook:malformed-path');
  } finally {
    cleanup(base);
  }
});

// ─── 验收标准 4：纯空白 / 空串 → 不是路径 ──────────────────────────────

test('标准 4：纯空白 / 空串 → 不是路径', () => {
  assert.equal(isCheckablePath(''), false);
  assert.equal(isCheckablePath('   '), false);
  assert.equal(isCheckablePath('\t\n '), false);
});

// ─── 验收标准 5：Windows 盘符在 Windows 上 → 是路径 ────────────────────

test('标准 5：Windows 盘符 C:\\foo\\bar 在 Windows 上 → 是路径', () => {
  if (process.platform !== 'win32') {
    // POSIX 主机上这条判据不适用（本片验收在 Windows 上跑）
    return;
  }
  assert.equal(isCheckablePath('C:\\foo\\bar'), true);
  assert.equal(isCheckablePath('C:/foo/bar'), true);
});

// ─── 验收标准 6：POSIX 主机上的 a\b → 不是路径 ────────────────────────

test('标准 6：POSIX 主机上的 a\\b → 不是路径（Windows 上允许）', () => {
  // POSIX 上 `a\b` 与 `a/b` 含义不同 → 不是路径；
  // Windows 上反斜杠是正常分隔符 → 是路径。
  const expected = process.platform === 'win32';
  assert.equal(isCheckablePath('a\\b'), expected);
});

// ─── 验收标准 7：正常路径 → 是路径，行为不变 ──────────────────────────

test('标准 7：正常相对路径 / 绝对路径 → 是路径，且行为不变', () => {
  assert.equal(isCheckablePath('src/a.ts'), true);
  assert.equal(isCheckablePath('src/nested/deep/a.ts'), true);
  assert.equal(isCheckablePath('/abs/path/a.ts'), true);

  const { base, wt } = makeFixture();
  try {
    // 正常路径落在写集内 → 放行（行为不变）
    const verdict = judgeWriteTargets(['src/hook/paths.ts'], makeCtx(wt, ['src/hook/paths.ts']));
    assert.equal(verdict.decision, 'allow');
  } finally {
    cleanup(base);
  }
});

// ─── 验收标准 8：形状非法的值不能被静默忽略 ───────────────────────────

test('标准 8：ACP 路线给形状非法的路径 → unknown（不是 []），且拒绝', () => {
  const malformed = ['file:///etc/passwd', '~/../../etc/passwd', 'a\0b'];

  for (const bad of malformed) {
    const paths = extractAcpChangedPaths({ kind: 'edit', rawInput: { path: bad } });
    assert.equal(
      paths,
      'unknown',
      `形状非法的值 "${JSON.stringify(bad)}" 必须被识别为 unknown，不能被静默忽略成 []`,
    );

    const { base, wt } = makeFixture();
    try {
      const verdict = judgeAcpPermission(
        { kind: 'edit', rawInput: { path: bad } },
        makeCtx(wt, ['src/hook/paths.ts']),
      );
      assert.equal(verdict.decision, 'deny');
      assert.equal(verdict.basis, 'acp:incomplete-targets');
    } finally {
      cleanup(base);
    }
  }
});

// ─── 验收标准 9：判定内核的形状闸门（hook 路线共用）────────────────────

test('标准 9：判定内核 judgeWriteTargets 给形状非法的写目标 → 拒绝', () => {
  const { base, wt } = makeFixture();
  try {
    const verdict = judgeWriteTargets(['file:///etc/passwd'], makeCtx(wt, ['src/hook/paths.ts']));
    assert.equal(verdict.decision, 'deny');
    assert.equal(verdict.basis, 'hook:malformed-path');
    assert.equal(verdict.ruleId, 'hook:malformed-path');
    assert.ok(
      /不是合法路径/.test(verdict.reason),
      `reason 应说明「不是合法路径」，实际=${verdict.reason}`,
    );
  } finally {
    cleanup(base);
  }
});

// ─── 验收标准 10：宽写集不放松 ───────────────────────────────────────

test('标准 10：宽写集 ** 下 file:///etc/passwd → 仍然拒绝', () => {
  // 实测（2026-11-27）：不加形状闸门时，`file:///etc/passwd` 归一化成
  // `<worktree>/file:/etc/passwd` 落在写集内 → **放行**。
  // agent 真的写到 `/etc/passwd`。
  // 窄写集（`src/**`）下它被写集检查挡住，所以只测窄写集会漏掉这个洞。
  const { base, wt } = makeFixture();
  try {
    const verdict = judgeWriteTargets(['file:///etc/passwd'], makeCtx(wt, ['**']));
    assert.equal(verdict.decision, 'deny');
    assert.equal(verdict.basis, 'hook:malformed-path');
  } finally {
    cleanup(base);
  }
});

// ─── 验收标准 11：npm test 全绿、lint 通过（由门禁①/②负责）───────────
//
// 这一条不写在这里 —— 全量测试与 lint 是门禁的一部分，
// 由 zelto gate 自己跑（见 specs/slices/adr-136-checkable-path-shape.md
// 验收标准 11）。这里写「断言测试是绿的」是自证，没有意义。

// ─── 验收标准 12：不越界 ──────────────────────────────────────────────

test('标准 12：本片不越界（改动只在写集内）', () => {
  const changed = require('node:child_process')
    .execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: ROOT, encoding: 'utf-8' })
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => l.slice(3).trim())
    .map((p) => p.replace(/\\/g, '/'));

  const outside = changed.filter((f) => !inWriteSet(f) && !NOT_THIS_SLICE.has(f));
  assert.deepEqual(outside, [], `写集之外存在改动：${outside.join(', ')}`);
});
