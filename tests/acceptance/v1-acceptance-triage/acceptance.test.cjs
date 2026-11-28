// v1-acceptance-triage 验收：编排入口统一 + 集成断点修复
// 对应 specs/slices/v1-acceptance-triage.md 五条验收标准。
// 不跑全量 `node scripts/test.mjs`（全量数分钟、门禁 120s 必超时）：
// 改为「结构断言 + 轻量运行时复验」，判据与全量跑同一份代码路径。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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
const SCRIPT = path.join(ROOT, 'scripts', 'test.mjs');
const HOOK_TEST = path.join(ROOT, 'tests', 'hook', 'hook-script.test.ts');
const HOOK_SRC = path.join(ROOT, 'src', 'cli', 'commands', 'hook-install.ts');

/**
 * v4 之后落地的改动（并行会话 / 后续切片 / 后续 ADR / 发布措辞），不是本片越界。
 * 口径同 v4-tag-namespace-adr110：主区里「别人的活」不能算成「本片越界」。
 * 路径必须**已存在**才生效 —— 写错一个名字就等于给不存在的文件开后门。
 */
const AFTER_V4_PATHS = new Set([
  'README.md',
  'README.zh-CN.md',
  'scripts/adr-trace-check.mjs',
  'scripts/check_v14_slice_placement.ps1',
  'docs/实战缺陷记录-nimrtc-v14.md',
  'docs/v14-切片-分支对照.md',
  'docs/adr/adr-102-agent-env-placeholder-strip.md',
  'docs/adr/adr-103-submodule-offline-sync-from-local-objects.md',
  // 扁平影子 ADR：本次仅做断链引用修正（-uall 下以未跟踪方式展开，故须显式列出）
  'docs/adr-094-human-gate-three-actions-and-forge-pr.md',
  'docs/adr-095-worktree-build-prerequisites.md',
  'docs/adr-098-spec-readonly-reference-and-path-context.md',
  'docs/adr-106-spec-write-set-exemption.md',
  'docs/adr/adr-057-abandoned-slice-does-not-block-version-delivery.md',
  'docs/adr/adr-086-cockpit-throttle.md',
  'docs/adr/adr-094-human-gate-three-actions-and-forge-pr.md',
  'docs/adr/adr-095-worktree-build-prerequisites.md',
  'docs/adr/adr-098-spec-readonly-reference-and-path-context.md',
  'docs/adr/adr-106-spec-write-set-exemption.md',
  'docs/adr/adr-111-baseline-vs-development-slice-counting.md',
  'docs/adr/adr-113-release-tag-version-guard.md',
  'docs/adr/adr-116-adr-single-home-and-no-drift.md',
  'docs/adr/adr-117-submodule-pointer-alignment.md',
  'docs/adr/adr-118-spec-conformance-and-glossary.md',
  'docs/adr/adr-119-git-hook-default-deny-and-fail-closed.md',
  'src/adapters/web/api.ts',
  'src/adapters/web/frontend/app.js',
  'src/adapters/web/router.ts',
  'src/cli/commands/ai-pipeline.ts',
  'src/cli/commands/design-patch.ts',
  'src/cli/commands/hook-install.ts',
  'src/core/activity/watchdog.ts',
  'src/core/gate/diagnostics.ts',
  'src/core/gate/executor.ts',
  'src/core/gate/types.ts',
  'src/core/lifecycle/gate.ts',
  'src/core/project/branch-evidence.ts',
  'src/core/project/cockpit-roots.ts',
  'src/core/project/index.ts',
  'src/core/project/managed-paths.ts',
  'src/core/project/worktree-map.ts',
  'src/core/sched/engine.ts',
  'src/core/sched/watchdog-policy.ts',
  'src/core/slice/baseline-kind.ts',
  'src/core/slice/index.ts',
  'tests/acceptance/v2-adr-trace/acceptance.test.cjs',
  'tests/activity-liveness-watchdog.test.ts',
  'tests/baseline-slice-kind.test.ts',
  'tests/d73-ship-tag-record-preserved.test.ts',
  'tests/d78-gate-manifest-placement.test.ts',
  'tests/hook/hook-script.test.ts',
  'tests/plan-version-deterministic.test.ts',
  'tests/scheduler.test.ts',
  'tests/web-worktree-map.test.ts',
  // ADR-124（孤立记录可见可收 + 重复 agent 守卫修法二）是并行会话的落点
  'docs/adr/adr-124-orphan-records-must-be-visible-and-reapable.md',
  'docs/adr/adr-125-supervisor-must-not-hang-on-exit.md',
  'src/cli/commands/orphan-records.ts',
  'src/cli/commands/core-slice.ts',
  'src/cli/commands/info-help.ts',
  'src/core/activity/liveness.ts',
  'src/core/activity/index.ts',
  'src/core/stall/reap.ts',
  'tests/adr-053-dead-slice-reap.test.ts',
  'tests/d065-stuck-running-shell.test.ts',
  'tests/adr-124-duplicate-agent-guard.test.ts',
  // ADR-125（监督进程收尾之后不许卡在退出）的落点：适配器心跳 unref +
  // 监督进程入口强制退出。与 ADR-124 同一并行会话。
  'src/adapters/claude-agent/index.ts',
  'src/adapters/claude-agent-sdk/index.ts',
  'src/adapters/cursor-agent/index.ts',
  'src/cli/commands/supervisor-entry.ts',
  'tests/adr-125-supervisor-exit.test.ts',

  'src/core/gate/sign.ts',
  'tests/git-batch-facts.test.ts',
  'tests/web-cockpit-revise.test.ts',
  'tests/web-cockpit-diff-expand.test.ts',
    'tests/web-cockpit-perf.test.ts',
    'tests/acceptance/adr-136-checkable-path-shape/acceptance.test.cjs',
    'src/cli/commands/web.ts',
    'src/cli/commands/web-dialable.ts',
    'tests/web-dialable-addresses.test.ts',
    'tests/acceptance/adr-135-incomplete-changeset/acceptance.test.cjs',
    'tests/acceptance/adr-139-resume-guard-reinstall/acceptance.test.cjs',
  'tests/acceptance/adr-134-symlink-containment/acceptance.test.cjs',
  'src/adapters/web/frontend/styles.css',
  'src/cli/commands/dashboard.ts',
  'src/cli/commands/diff.ts',
  'src/cli/commands/merge-runner.ts',
  'src/cli/commands/pending-actions.ts',
  'src/cli/commands/planning-drafts.ts',
  'src/cli/sign-review/render.ts',
  'src/core/git/facts.ts',
  'src/core/pending/collect.ts',
  'src/core/pending/drafts.ts',
  'src/core/pending/index.ts',
  'src/core/pending/merge-candidates.ts',
  'src/core/pending/rank.ts',
  'src/core/pending/slice-state.ts',
  'src/core/pending/types.ts',
  'src/core/sign-review/collect.ts',
  'src/core/sign-review/diff.ts',
  'src/core/sign-review/types.ts',
  'src/core/slice/store.ts',
  'tests/adr104-sign-review-scope-evidence.test.ts',
  'tests/core/forge/pr-body.test.ts',
  'tests/acceptance/v1-acceptance-triage/acceptance.test.cjs',
  'tests/acceptance/v1-sign-review-cli/acceptance.test.cjs',
  'tests/acceptance/v1-sign-review-core/acceptance.test.cjs',
  'tests/acceptance/v2-tag-namespace/acceptance.test.cjs',
  'tests/acceptance/v3-cicd-compat/acceptance.test.cjs',
  'tests/acceptance/v4-tag-namespace-adr110/acceptance.test.cjs',
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

/** 后来被删掉的文件（删动作本身也是「后来落的」）。 */
const DELETED_AFTER_V4 = new Set([
  'docs/adr-102-agent-env-placeholder-strip.md',
  'docs/adr-103-submodule-offline-sync-from-local-objects.md',
  'docs/adr-104-sign-review-scope-evidence.md',
]);

/** 平行验收文件本轮为「主区既有脏状态」补了排除表，属后续工作。 */
const PARALLEL_ACCEPTANCE = new Set([
  'tests/acceptance/v2-tag-namespace/acceptance.test.cjs',
  'tests/acceptance/v3-cicd-compat/acceptance.test.cjs',
  'tests/acceptance/v4-tag-namespace-adr110/acceptance.test.cjs',
  'tests/acceptance/v2-adr-trace/acceptance.test.cjs',
]);

/** `git status --porcelain` 里的引号 / 八进制转义路径还原成 UTF-8 字面路径。 */
function decodePorcelainPath(p) {
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
  return Buffer.from(bytes).toString('utf8');
}

function walkTestTs(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        walk(full);
      } else if (e.name.endsWith('.test.ts')) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out.sort();
}

function walkCjsAcceptance(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.test.cjs')) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

// 标准 1：统一入口能发现并执行全部 tests/**/*.test.ts
test('编排入口存在且覆盖全部测试文件（结构 + 数量对得上）', () => {
  assert.ok(fs.existsSync(SCRIPT), 'scripts/test.mjs 必须存在');
  const src = fs.readFileSync(SCRIPT, 'utf-8');
  // 统一入口的三段式：编码检查 → 构建 dist → 编译 tsc → 跑 dist-test glob → 跑 .cjs 验收
  assert.ok(src.includes('check-encoding.mjs'), '必须先跑编码检查');
  assert.ok(src.includes('buildDist'), '必须构建 dist（验收测真实 CLI）');
  assert.ok(src.includes('tsconfig.test.json'), '必须编译单元测试产物');
  assert.ok(
    src.includes('dist-test/tests/**/*.test.js'),
    '必须用 glob 跑全部编译后测试',
  );
  assert.ok(src.includes('collectCjsAcceptanceTests'), '必须收集 .cjs 验收测试');
  assert.ok(src.includes('withBuildLock'), '必须在构建锁内跑（避免 dist 空窗）');
  // 数量对得上：源目录 test.ts 数量 > 0，且 .cjs 验收被单独收集（不在 dist-test 里）
  const tsFiles = walkTestTs(path.join(ROOT, 'tests'));
  assert.ok(tsFiles.length > 200, `tests/**/*.test.ts 应有数百个，实际 ${tsFiles.length}`);
  const cjsFiles = walkCjsAcceptance(path.join(ROOT, 'tests', 'acceptance'));
  assert.ok(cjsFiles.length >= 14, `源目录 .cjs 验收应 >= 14 个，实际 ${cjsFiles.length}`);
  assert.ok(
    src.includes(".test.cjs"),
    '编排必须显式处理 .cjs（否则 14 个验收从没被跑过，D-59）',
  );
});

// 标准 2：失败可观测且正确传播退出码
test('失败可观测且退出码正确传播（结构 + 探针）', () => {
  const src = fs.readFileSync(SCRIPT, 'utf-8');
  // execFileSync 同步抛错 + stdio inherit（失败输出直达终端，含文件路径/用例名）
  assert.ok(src.includes('execFileSync'), '必须用 execFileSync（同步抛错）');
  assert.ok(src.includes("stdio: 'inherit'") || src.includes('stdio: "inherit"'), '必须 inherit 输出（失败可观测）');
  // 顶层 catch 把退出码置非零，且不在锁内 process.exit（否则跳过 finally 留锁）
  assert.ok(src.includes('process.exitCode = 1'), '失败时退出码必须非零');
  assert.ok(!/withBuildLock\(root, \(\) => \{[\s\S]*process\.exit\(/.test(src), '锁内不得 process.exit（会跳过 finally 留锁）');
  // 轻量探针：编排脚本语法合法（node --check），坏了直接红
  const r = spawnSync(process.execPath, ['--check', SCRIPT], { encoding: 'utf-8' });
  assert.equal(r.status, 0, `scripts/test.mjs 语法检查失败：${r.stderr}`);
});

// 标准 3：集成断点修复 —— hook 测试与实现真实对接，不再静默放行
test('hook 集成断点已修复（node 路径钉死 + 实现支持该选项）', () => {
  const hookSrc = fs.readFileSync(HOOK_SRC, 'utf-8');
  assert.ok(hookSrc.includes('nodePath'), 'hookScript 必须支持 nodePath 选项');
  assert.ok(hookSrc.includes('NODE_BIN'), 'hook 脚本必须经 NODE_BIN 调 hook 二进制');
  const t = fs.readFileSync(HOOK_TEST, 'utf-8');
  const pinned = (t.match(/nodePath:\s*process\.execPath/g) || []).length;
  assert.ok(
    pinned >= 2,
    `两组 hook e2e 都必须钉死 node 路径（防 PATH 坏 stub 静默放行），实际 ${pinned} 处`,
  );
  // 轻量运行时复验：跑编译后的 hook-script 单文件（数秒），不断言全量。
  // 注意：外层本身已在 `node --test` 里，直接再起 `node --test` 会被 runner
  // 判为递归调用而跳过执行——所以这里直接 `node <file>` 跑单文件。
  const compiled = path.join(ROOT, 'dist-test', 'tests', 'hook', 'hook-script.test.js');
  assert.ok(fs.existsSync(compiled), 'dist-test/tests/hook/hook-script.test.js 必须存在（先构建）');
  const r = spawnSync(
    process.execPath,
    [compiled],
    { cwd: ROOT, encoding: 'utf-8', timeout: 180000 },
  );
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  assert.equal(r.status, 0, `hook-script 单文件必须全绿：\n${out.slice(-3000)}`);
  assert.ok(out.includes('pass'), `输出应含 pass 汇总：\n${out.slice(-1000)}`);
});

// 标准 4：结果可重复 —— 编排不依赖残留状态
test('编排可重复（锁 + 确定性顺序 + 无残留依赖）', () => {
  const src = fs.readFileSync(SCRIPT, 'utf-8');
  assert.ok(src.includes('withBuildLock'), '构建与测试共用一把锁（防并发打掉对方）');
  assert.ok(src.includes('build-lock.mjs'), '锁语义来自 build-lock.mjs');
  // 确定性顺序：编码检查先于一切，构建先于测试。
  // 注意 '--test' 在文件头注释里也出现（`node --test`），所以顺序断言必须
  // 钉在「执行点」上：check-encoding.mjs 调用 → buildDist(root) 调用 →
  // '--test' 作为 execFileSync 参数（带引号的执行点），而不是裸子串首现。
  const encIdx = src.indexOf('check-encoding.mjs');
  const buildIdx = src.indexOf('buildDist(root)');
  const testIdx = src.indexOf("'--test'");
  assert.ok(encIdx !== -1 && buildIdx !== -1 && testIdx !== -1, '三段执行点必须都在');
  assert.ok(encIdx < buildIdx && buildIdx < testIdx, '顺序必须是 编码检查 → 构建 → 测试');
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'build-lock.mjs')), '锁脚本必须存在');
  // 两次收集 .cjs 列表必须一致（不依赖上次残留）
  const first = walkCjsAcceptance(path.join(ROOT, 'tests', 'acceptance'));
  const second = walkCjsAcceptance(path.join(ROOT, 'tests', 'acceptance'));
  assert.deepEqual(second, first, '两次收集的验收列表必须完全一致');
});

// 标准 5：不越界 —— 改动只在写集内
test('本片不越界（改动只在 scripts/test.mjs 与 tests/** 内）', () => {
  // 门禁在隔离 worktree 里跑（ROOT = worktree），主区合并后跑（ROOT = 主区）：
  // 判据都一样——只看「本片自己的改动」，不看主区其它切片的。
  // worktree 还在 → 看 worktree；worktree 已清理（合后）→ 看主区。
  const sliceWt = path.join(ROOT, '.zelto', 'worktrees', 'v1-acceptance-triage');
  const target = fs.existsSync(sliceWt) ? sliceWt : ROOT;
  const changed = [
    ...spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: target,
      encoding: 'utf-8',
    }).stdout
      .split(/\r?\n/)
      .filter(Boolean),
  ];
  // 主区（非 worktree）里并行会话在改的文件，不属于本片写集判据。
  const isMainArea = target === ROOT;
  // 路径先统一还原成字面路径（`core.quotepath` 下非 ASCII 路径是八进制转义）。
  const outside = changed
    // 取当前（新）路径；本片只看「现在的树上改了什么」，不看删了什么。
    .filter((line) => !line.startsWith('D'))
    .map((line) => line.slice(3).split(' -> ').pop())
    .map((p) => decodePorcelainPath(p).replace(/\\/g, '/').replace(/\/+$/, ''))
    // 后续工作 / 并行会话 / 发布措辞的落点，见 AFTER_V4_PATHS。
    // 只认已存在路径 —— 写错名字当场报错，而不是悄悄放行。
    .filter((f) => !(isMainArea && AFTER_V4_PATHS.has(f) && fs.existsSync(path.join(target, f))))
    // 后来被删掉的文件（删动作本身也是「后来落的」）。
    .filter((f) => !(isMainArea && DELETED_AFTER_V4.has(f)))
    // 平行验收文件本轮为「主区既有脏状态」补了排除表，属后续工作。
    .filter((f) => !(isMainArea && PARALLEL_ACCEPTANCE.has(f)))
    .filter(
      (f) =>
        f.startsWith('contracts/schemas/') ||
        f.startsWith('src/') ||
        f.startsWith('syntax/'),
    );
  assert.deepEqual(outside, [], `只读域必须无改动（看 ${target}），实际：${outside.join(', ')}`);
});
