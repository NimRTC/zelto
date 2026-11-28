// 验收测试 —— 切片 adr-134-symlink-containment：符号链接感知的路径 containment
//
// 对应 specs/slices/adr-134-symlink-containment.md（ADR-134）。
// 全部用例是真断言，无 todo / skip —— 门禁②会识别「没有一条用例真正跑起来」
// 的验收文件并判 failed。
//
// 本文件是 CommonJS（.cjs），直接由 node --test 执行：
//   node --test tests/acceptance/adr-134-symlink-containment/acceptance.test.cjs
//
// 被测产物：
//   - src/hook/paths.ts         —— canonicalContainment / canonicalizeForContainment
//   - src/hook/pretool.ts       —— judgeWriteTargets 的三条 containment 检查
//
// ── 为什么用 .cjs 而不是 .ts ───────────────────────────────────────────
//
// .cjs 验收测试直接 require('dist/') 的 JS 产物，**不依赖编译产物目录**，
// 因此门禁在「只构建了 dist/、没跑 tsc -p tsconfig.test.json」的顺序下也能跑。
// 判定的是**运行时行为**（真造 junction、真跑判定），不是源码形状 ——
// 这正是 ADR-134 最需要守住的那条。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DIST = path.join(ROOT, 'dist');

const { canonicalContainment, canonicalizeForContainment } = require(
  path.join(DIST, 'hook', 'paths.js'),
);
const { judgeWriteTargets } = require(path.join(DIST, 'hook', 'pretool.js'));

// ─── 写集（与切片规格一致）─────────────────────────────────────────────
const WRITE_SET = [
  'src/hook/paths.ts',
  'src/hook/pretool.ts',
  'src/hook/acp.ts',
  'tests/hook/paths.test.ts',
  'tests/hook/pretool.test.ts',
  'specs/slices/adr-134-symlink-containment.md',
  'tests/acceptance/adr-134-symlink-containment/acceptance.test.cjs',
];

/** 写集匹配（glob 语义：`**` 与 `*`）。 */
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

/**
 * 本片**之外**的既有脏状态 —— 不算本片越界。
 *
 * 为什么需要这张表：本片已合并进主干，主区里还留着**别的**并行会话
 * 与后续工作的改动（驾驶舱前端、其它切片的验收文件等）。
 * 它们出现在 `git status` 里不是「本片越界」，是「本片之后又有人干活了」。
 *
 * 口径与其它验收套件一致（见 v1-acceptance-triage / v4-tag-namespace-adr110
 * 的同名排除表）：**只排掉本片自己没碰过的文件** ——
 * 本片自己的写集边界仍由上面的 `WRITE_SET` 守。
 */
const NOT_THIS_SLICE = new Set([
  'src/adapters/web/frontend/app.js',
  'src/adapters/web/frontend/styles.css',
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
    'tests/acceptance/adr-135-incomplete-changeset/acceptance.test.cjs',
    'tests/acceptance/adr-139-resume-guard-reinstall/acceptance.test.cjs',
    // ADR-139（续跑守卫重装）并行会话的落点 —— 本片没碰过
    'docs/adr/adr-139-resume-guard-reinstall.md',
    'specs/slices/adr-139-resume-guard-reinstall.md',
    'src/cli/commands/resume-guard.ts',
    'src/cli/commands/question.ts',
    'src/cli/commands/shared.ts',
    'src/cli/commands/parallel-executor.ts',
    'tests/adr-139-resume-guard.test.ts',
    // v3-docs 的验收文件本轮改为「读时快照」（消除 ADR 影子被搬走时的竞态）—— 后续工作
    'tests/acceptance/v3-docs/acceptance.test.cjs',
]);

// ─── 夹具 ──────────────────────────────────────────────────────────────

/** 建临时目录：base/wt（工作区）与 base/outside（外部）。 */
function makeFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zelto-acc-134-'));
  const wt = path.join(base, 'wt');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(wt);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret', 'utf-8');
  return { base, wt, outside };
}

/** 在 worktree 内建一个指向 target 的 junction（Windows）/ symlink（POSIX）。 */
function makeLinkToDir(target, linkPath) {
  fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

function cleanup(base) {
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响判定 */
  }
}

/** 判定用的上下文。 */
function ctx(worktreeRoot, overrides = {}) {
  return {
    projectRoot: worktreeRoot,
    worktreeRoot,
    sliceId: 'adr-134-symlink-containment',
    // 写集故意给 `**` —— 词法上目标必然「在写集内」。
    // 如果实现只修「逃逸检查」而不修「写集检查」，这里就会误判为真。
    writes: ['**'],
    rules: null,
    policyVersion: 'sha256:test',
    ...overrides,
  };
}

// ─── 验收标准 1：junction 指向 worktree 外 → 拒绝 ──────────────────────

test('junction 指向 worktree 外 → 拒绝，ruleId 为 protected:0a', () => {
  const { base, wt, outside } = makeFixture();
  try {
    makeLinkToDir(outside, path.join(wt, 'escape'));
    const target = path.join(wt, 'escape', 'secret.txt');

    const v = judgeWriteTargets([target], ctx(wt));

    assert.equal(v.decision, 'deny', '指向外部的 junction 必须被拒绝');
    assert.equal(v.ruleId, 'protected:0a', '越界的 ruleId 与既有越界判定同一口径');
    assert.match(v.reason, /隔离目录之外|越界/, `reason 要说清是越界，实际：${v.reason}`);
  } finally {
    cleanup(base);
  }
});

// ─── 验收标准 2（核心用例）：词法上在写集内也拦 ────────────────────────

test('junction 指向外部但词法上在写集内 → 仍然拒绝', () => {
  const { base, wt, outside } = makeFixture();
  try {
    makeLinkToDir(outside, path.join(wt, 'escape'));
    const target = path.join(wt, 'escape', 'secret.txt');

    // 词法相对路径确实是 `escape/secret.txt` —— 在写集 `**` 内。
    // 所以拦不住它只能是因为**判定用的是 canonical 路径**。
    const v = judgeWriteTargets([target], ctx(wt));

    assert.equal(v.decision, 'deny', '词法在写集内不能成为放行理由');
    assert.equal(v.ruleId, 'protected:0a');
  } finally {
    cleanup(base);
  }
});

// ─── 验收标准 3：正常写集内路径 → 放行（行为不变）────────────────────

test('普通相对路径在写集内 → 放行', () => {
  const { base, wt } = makeFixture();
  try {
    fs.writeFileSync(path.join(wt, 'a.ts'), 'x', 'utf-8');
    const v = judgeWriteTargets([path.join(wt, 'a.ts')], ctx(wt));
    assert.equal(v.decision, 'allow', `正常路径必须放行，实际：${v.reason}`);
  } finally {
    cleanup(base);
  }
});

// ─── 验收标准 4：新建文件（目标不存在）→ 放行 ─────────────────────────

test('新建文件（目标不存在，父目录存在）→ 放行', () => {
  const { base, wt } = makeFixture();
  try {
    const target = path.join(wt, 'new-file.ts');
    assert.equal(fs.existsSync(target), false, '前置条件：目标确实不存在');

    const v = judgeWriteTargets([target], ctx(wt));
    assert.equal(v.decision, 'allow', `不存在的新文件不能被误拒，实际：${v.reason}`);
  } finally {
    cleanup(base);
  }
});

// ─── 验收标准 5：realpath 失败 → 拒绝（fail closed）────────────────────

test('realpath 失败（ELOOP 循环链接）→ 拒绝，reason 说明原因', () => {
  const { base, wt } = makeFixture();
  try {
    // 造一个循环链接：loopA ⇄ loopB
    if (process.platform === 'win32') {
      fs.symlinkSync(path.join(wt, 'loopB'), path.join(wt, 'loopA'), 'junction');
      fs.symlinkSync(path.join(wt, 'loopA'), path.join(wt, 'loopB'), 'junction');
    } else {
      fs.symlinkSync('loopB', path.join(wt, 'loopA'));
      fs.symlinkSync('loopA', path.join(wt, 'loopB'));
    }
    const target = path.join(wt, 'loopA', 'x.ts');

    const v = judgeWriteTargets([target], ctx(wt));

    assert.equal(v.decision, 'deny', '解析不出真实路径必须 fail closed');
    assert.equal(v.ruleId, 'protected:0a');
    assert.match(v.reason, /无法解析真实路径/, `reason 要说明是解析失败，实际：${v.reason}`);
  } finally {
    cleanup(base);
  }
});

// ─── 验收标准 6：三条检查统一用 canonical 路径 ────────────────────────

test('canonicalContainment 区分 inside / escape / unresolvable 三种结果', () => {
  const { base, wt, outside } = makeFixture();
  try {
    makeLinkToDir(outside, path.join(wt, 'escape'));
    fs.writeFileSync(path.join(wt, 'ok.ts'), 'x', 'utf-8');

    const inside = canonicalContainment(path.join(wt, 'ok.ts'), wt);
    assert.equal(inside.kind, 'inside', 'worktree 内的真实文件必须在 inside');
    assert.equal(inside.rel, 'ok.ts');

    const escape = canonicalContainment(path.join(wt, 'escape', 'secret.txt'), wt);
    assert.equal(escape.kind, 'escape', '指向外部的链接必须判 escape');

    // 逃逸与解析失败是**两回事** —— reason 要能区分（ADR-134 决策三）。
    assert.notEqual(escape.kind, 'unresolvable');
  } finally {
    cleanup(base);
  }
});

// ─── 验收标准 7：判定层无第三方依赖（C2）─────────────────────────────

test('src/hook/paths.ts 只 import node: 内置模块（零第三方依赖）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'hook', 'paths.ts'), 'utf-8');
  const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const external = imports.filter((i) => !i.startsWith('node:') && !i.startsWith('./') && !i.startsWith('../'));
  assert.deepEqual(external, [], `paths.ts 不得有第三方依赖，实际：${external.join(', ')}`);
});

// ─── 验收标准 8：产物存在 ──────────────────────────────────────────────

test('产物存在：src/hook/paths.ts 与 dist/hook/paths.js', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'src', 'hook', 'paths.ts')), 'src/hook/paths.ts 必须在树上存在');
  assert.ok(fs.existsSync(path.join(DIST, 'hook', 'paths.js')), 'dist/hook/paths.js 必须已构建');
  assert.ok(
    fs.existsSync(path.join(DIST, 'hook', 'pretool.js')),
    'dist/hook/pretool.js 必须已构建',
  );
});

// ─── 验收标准 9：不越界（改动只在写集内）─────────────────────────────

test('本片不越界（改动只在写集内）', () => {
  // 门禁在隔离 worktree 里跑（ROOT = worktree），主区合并后跑（ROOT = 主区）：
  // 判据一样 —— 只看「本片自己的改动」。
  const sliceWt = path.join(ROOT, '.zelto', 'worktrees', 'adr-134-symlink-containment');
  const target = fs.existsSync(sliceWt) ? sliceWt : ROOT;

  const status = require('node:child_process').spawnSync(
    'git',
    ['status', '--porcelain', '--untracked-files=all'],
    { cwd: target, encoding: 'utf-8' },
  );
  const changed = (status.stdout || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((l) => !l.startsWith('D'))
    .map((l) => l.slice(3).split(' -> ').pop())
    .map((p) => {
      const trimmed = p.replace(/^"|"$/g, '');
      const bytes = [];
      for (let i = 0; i < trimmed.length; i++) {
        if (trimmed[i] === '\\' && /[0-7]{3}/.test(trimmed.slice(i + 1, i + 4))) {
          bytes.push(Number.parseInt(trimmed.slice(i + 1, i + 4), 8));
          i += 3;
        } else {
          for (const b of Buffer.from(trimmed[i], 'utf8')) bytes.push(b);
        }
      }
      return Buffer.from(bytes).toString('utf-8');
    })
    .map((p) => p.replace(/\\/g, '/'));

  const outside = changed.filter((f) => !inWriteSet(f) && !NOT_THIS_SLICE.has(f));
  assert.deepEqual(outside, [], `写集之外存在改动：${outside.join(', ')}`);
});
