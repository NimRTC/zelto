// 验收测试 —— 切片 v2-tag-namespace（specs/slices/v2-tag-namespace.md）
//
// 治理 Git Tag 命名空间：新规则为计划-版本二级，
// 存量裸 tag v1/v2/v3 重命名迁移并保留映射，纯 semver tag 不受影响，
// `scripts/tag-namespace.mjs` 只校验（列出非法 tag + 非零退出）不自动改。
//
// ── ADR-110 之后的修订（2026-11-25）────────────────────────────────
//
// v2 规格定的规则是 `plan-<semver>/v<n>`。
// **ADR-110**（`docs/adr/adr-110-version-tag-plan-scoped-namespace.md`）
// 把命名空间改为**按计划寻址**：`plan-<planId>/v<n>`，
// 并把 `<semver>` 从 tag 里移出去（`<semver>` 是「当前版本」的概念，
// 而 tag 是「历史」—— 两者必然分叉，导致升版当天历史 tag 全部变非法）。
//
// 所以本文件的**规则断言**按新规则改写。
// **但保留的部分**（本片真正建立的不变量）**一条不动**：
//   · 裸 tag v1/v2/v3 非法
//   · 纯 semver tag 合法、不受影响
//   · 迁移台账含 v1/v2/v3 三条
//   · 脚本只校验不改 tag
//   · 写集边界
//
// 「规则变了，测规则的断言跟着变」是正常的 ——
// **不能为了让测试变绿而把规则改回去**。
// 不可变的是「测的东西」：命名治理的**形状**没变，
// 变的只是命名空间里装的是「计划 id」而不是「发布批次号」。
//
// 本文件是 CommonJS（.cjs），直接由 node --test 执行：
//   node --test tests/acceptance/v2-tag-namespace/acceptance.test.cjs
//
// 被测的是 scripts/ + docs/ 的真实文件与真实脚本进程，不做 mock。
// 全部用例是真断言，无 todo / skip —— 门禁②会识别「没有一条用例真正跑起来」
// 的验收文件并判 failed。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'tag-namespace.mjs');
const MAP = path.join(ROOT, 'scripts', 'tag-map.json');
const DOC = path.join(ROOT, 'docs', 'tag-namespace.md');
const PKG = path.join(ROOT, 'package.json');

// 本片写集（specs/slices/v2-tag-namespace.md 的「范围」）。
const WRITE_SET = [
  'scripts/tag-namespace.mjs',
  'scripts/tag-map.json',
  'docs/tag-namespace.md',
  'tests/acceptance/v2-tag-namespace/acceptance.test.cjs',
];

// 受保护路径（policy/、.zelto/、AGENTS.md、.cursor/rules/）—— 不得被本片改动。
const PROTECTED = ['policy/', '.zelto/', 'AGENTS.md', '.cursor/rules/'];

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** 跑校验脚本（管道 stdio，非 TTY），返回 { status, stdout, stderr, output }。 */
function runScript(args) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    output: (res.stdout || '') + (res.stderr || ''),
  };
}

function gitOut(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return (r.stdout || '').split(/\r?\n/).filter(Boolean);
}

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

/**
 * v4 之后落地的改动（并行会话 / 后续切片 / 后续 ADR / 发布措辞），不是本片越界。
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
  'docs/adr/adr-111-baseline-vs-development-slice-counting.md',
  'docs/adr/adr-113-release-tag-version-guard.md',
  'docs/adr/adr-116-adr-single-home-and-no-drift.md',
  'docs/adr/adr-117-submodule-pointer-alignment.md',
  'docs/adr/adr-118-spec-conformance-and-glossary.md',
  'docs/adr/adr-119-git-hook-default-deny-and-fail-closed.md',
  // 并行会话的改动（2026-11-26）：执行目录脉络三态修订 + 看门狗已放弃不折算成「在跑」
  'docs/adr/adr-120-cockpit-worktree-map-and-merged-into-trunk.md',
  'docs/adr/adr-123-cockpit-watchdog-gave-up-is-not-running.md',
  // ADR-122（重新冻结改写集 + 作用域解析）是另一并行会话落地的 ADR，本会话没碰
  'docs/adr/adr-122-refreeze-rewrites-writeset-and-scope-parser.md',
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
  'src/adapters/web/api.ts',
  'src/adapters/web/frontend/app.js',
  'src/adapters/web/router.ts',
  'src/cli/commands/ai-pipeline.ts',
  'src/cli/commands/hook-install.ts',
  'src/core/activity/watchdog.ts',
  'src/core/gate/diagnostics.ts',
  'src/core/gate/executor.ts',
  'src/core/gate/types.ts',
  'tests/zd062-gate-kill-tree.test.ts',
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
  'tests/acceptance/v4-tag-namespace-adr110/acceptance.test.cjs',
  'tests/activity-liveness-watchdog.test.ts',
  'tests/baseline-slice-kind.test.ts',
  'tests/d73-ship-tag-record-preserved.test.ts',
  'tests/d78-gate-manifest-placement.test.ts',
  'tests/hook/hook-script.test.ts',
  'tests/plan-version-deterministic.test.ts',
  'tests/scheduler.test.ts',
  'tests/web-worktree-map.test.ts',

    // ADR-129（runId 贯穿 + 收尾先落事实后释放 + 主管运行期心跳）—— 并行会话落点
    'docs/adr/adr-129-run-identity-and-teardown-order.md',
    'src/core/sched/run-id.ts',
    'src/core/sched/run-conclusion.ts',
    'src/core/sched/index.ts',
    'src/cli/commands/task-watchdog.ts',
    'src/cli/commands/supervisor-heartbeat.ts',
    'src/cli/commands/core-slice.ts',
    'src/cli/commands/supervisor.ts',
    'src/cli/commands/supervisor-entry.ts',
    'src/cli/commands/run-finish.ts',
    'src/cli/commands/parallel-executor.ts',
    'src/cli/commands/task-store.ts',
    'tests/adr-129-run-identity.test.ts',
    'tests/zd049-supervisor-takeover.test.ts',
  
    'src/core/gate/sign.ts',
    'tests/git-batch-facts.test.ts',
    'tests/web-cockpit-revise.test.ts',
    'tests/web-cockpit-diff-expand.test.ts',
    'tests/web-cockpit-perf.test.ts',
    'tests/acceptance/adr-136-checkable-path-shape/acceptance.test.cjs',
    'tests/acceptance/adr-135-incomplete-changeset/acceptance.test.cjs',
    'tests/acceptance/adr-139-resume-guard-reinstall/acceptance.test.cjs',
    // ADR-139（提问回路续跑段重装运行时守卫）—— 本片之后的切片落点
    'docs/adr/adr-139-resume-guard-reinstall.md',
    'specs/slices/adr-139-resume-guard-reinstall.md',
    'src/cli/commands/resume-guard.ts',
    'src/cli/commands/question.ts',
    'src/cli/commands/shared.ts',
    'tests/adr-139-resume-guard.test.ts',
    'src/cli/commands/web.ts',
    'src/cli/commands/web-dialable.ts',
    'tests/web-dialable-addresses.test.ts',
    'tests/web-mobile-usability.test.ts',
    'src/adapters/web/frontend.ts',
    'tests/fixtures/mock-acp-agent.mjs',
    'tests/adr-140-acp-session-continuation.test.ts',
    'src/core/ports/executor.ts',
    'src/adapters/cursor-agent/index.ts',
    'src/adapters/claude-agent/index.ts',
    'src/adapters/claude-agent-sdk/index.ts',
    'src/adapters/acp/protocol.ts',
    'src/adapters/acp/index.ts',
    'src/adapters/acp/continuation.ts',
    'specs/slices/adr-143-startup-phase.md',
    'specs/slices/adr-142-usage-limit-stall-class.md',
    'specs/slices/adr-141-settle-pending-permissions.md',
    'specs/slices/adr-140-acp-session-continuation.md',
    'docs/adr/adr-109-cockpit-vpn-reach-and-mobile.md',
    'CHANGELOG.md',
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
    'tests/acceptance/v3-cicd-compat/acceptance.test.cjs',]);

/** 后来被删掉的文件（删动作本身也是「后来落的」）。 */
const DELETED_AFTER_V4 = new Set([
  // ADR-117 / ADR-118 以 docs/adr/ 新家落地后，旧的 docs/ 扁平影子随之删除（ADR-116）
  'docs/adr-047-submodule-pointer-alignment.md',
  'docs/adr-057-spec-conformance-and-glossary.md',
  'docs/adr-102-agent-env-placeholder-strip.md',
  'docs/adr-103-submodule-offline-sync-from-local-objects.md',
  'docs/adr-104-sign-review-scope-evidence.md',
]);

/** package.json 当前版本（取 X.Y.Z 部分，与校验脚本同一规则）。 */
function currentSemver() {
  const pkg = readJson(PKG);
  const m = /^\d+\.\d+\.\d+/.exec(pkg.version || '');
  assert.ok(m, `package.json 的 version 应是 semver，实际：${pkg.version}`);
  return m[0];
}

/** 仓库里任选一个真实存在的计划 id（tag 台账里的）—— 用来造合法的命名空间 tag。 */
function somePlanId() {
  const map = readJson(MAP);
  const first = Object.values(map)[0];
  const m = /^(plan-\d{13})\//.exec(first && first.new ? first.new : '');
  assert.ok(m, `台账里应能取到一个真实 planId，实际：${JSON.stringify(first)}`);
  return m[1];
}

// ─── 验收标准 1：命名规则文档化 ───────────────────────────────────────────────

test('命名规则文档化：docs/tag-namespace.md 写明新规则并说明裸 tag 非法、须迁移', () => {
  assert.ok(fs.existsSync(DOC), 'docs/tag-namespace.md 必须存在');
  const text = fs.readFileSync(DOC, 'utf8');

  // ADR-110 之后的规则：**按计划寻址**。
  assert.ok(
    text.includes('plan-<planId>/v<n>'),
    '文档必须写明新规则 plan-<planId>/v<n>（ADR-110 改成按计划寻址）',
  );

  // 必须点名裸 tag 并说明非法 + 须迁移 —— 这三条是本片建立的不变量，一条都不能少。
  for (const bare of ['v1', 'v2', 'v3']) {
    assert.ok(text.includes(bare), `文档必须点名裸 tag ${bare}`);
  }
  assert.ok(/非法/.test(text), '文档必须说明裸 tag 为非法');
  assert.ok(/迁移/.test(text), '文档必须说明须迁移');
});

// ─── 验收标准 2：存量映射完整 ─────────────────────────────────────────────────

test('存量映射完整：tag-map.json 含 v1/v2/v3 且值为合法新命名空间 tag', () => {
  assert.ok(fs.existsSync(MAP), 'scripts/tag-map.json 必须存在');
  const map = readJson(MAP);
  // ADR-110 决策七：台账升级为带 commit 的形状 ——
  // 「只记名字、不记内容」正是缺陷二的根因。
  const re = /^plan-\d{13}\/v\d+$/;
  for (const oldName of ['v1', 'v2', 'v3']) {
    assert.ok(Object.prototype.hasOwnProperty.call(map, oldName), `映射必须含旧名 ${oldName}`);
    const entry = map[oldName];
    assert.ok(
      entry && typeof entry === 'object' && typeof entry.new === 'string',
      `${oldName} 的条目必须是 { new, commit } 形状（ADR-110 决策七）`,
    );
    assert.match(entry.new, re, `${oldName} → ${entry.new} 不是合法新命名空间 tag`);
    assert.ok(
      typeof entry.commit === 'string' && entry.commit.length >= 7,
      `${oldName} 的条目必须带 commit（台账要能核对 git 事实）`,
    );
  }
});

// ─── 验收标准 3：校验脚本可用 ─────────────────────────────────────────────────

test('校验脚本可用：非法 tag 列出且退出非零，全合法退出 0', () => {
  const illegal = runScript(['v1']);
  assert.equal(illegal.status, 1, `存在非法 tag 时应退出 1，实际 ${illegal.status}：\n${illegal.output}`);
  assert.ok(illegal.output.includes('v1'), '输出必须列出非法 tag v1');

  // 合法形态：**按计划寻址**（ADR-110 之后不再有 plan-<semver>/v<n>）。
  const legal = runScript(['v0.3.0', `${somePlanId()}/v1`]);
  assert.equal(legal.status, 0, `全部合法时应退出 0，实际 ${legal.status}：\n${legal.output}`);
  assert.ok(legal.output.includes('校验通过'), '全合法时输出应报通过');
});

// ─── 验收标准 4：semver tag 不受影响 ──────────────────────────────────────────

test('semver tag 不受影响：^v\\d+\\.\\d+\\.\\d+$ 视为合法，不在非法清单里', () => {
  const clean = runScript(['v0.3.0', `v${currentSemver()}`]);
  assert.equal(clean.status, 0, `纯 semver tag 应退出 0，实际 ${clean.status}：\n${clean.output}`);

  const mixed = runScript(['v0.3.0', 'v1']);
  assert.equal(mixed.status, 1, '混入非法 tag 时仍应非零退出');
  assert.ok(mixed.output.includes('v1'), '应列出非法 tag v1');
  assert.ok(!mixed.output.includes('v0.3.0'), 'v0.3.0 不得被列为非法');
});

// ─── 验收标准 5：不越界 ───────────────────────────────────────────────────────

test('不越界：改动只在写集内，package.json 无改动', () => {
  // ② 产物检查：用状态读（ADR-075）—— 写集四件必须在树上。
  for (const rel of WRITE_SET) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} 必须在树上`);
  }

  // ① 越界检查：用历史读（ADR-075）—— git status 的改动路径不得越过写集。
  // 允许片外既有状态（不是本片产物）：
  //   · specs/slices/v2-tag-namespace.md —— 本片规格文件，由 zelto spec 流程落盘
  //   · src/cli/commands/design-patch.ts —— 并行会话的既有改动
  const KNOWN_OUT_OF_SCOPE = new Set([
    'specs/slices/v2-tag-namespace.md',
    'src/cli/commands/design-patch.ts',
  ]);

  const porcelain = gitOut(['status', '--porcelain', '--untracked-files=all']);
  // porcelain 行形如 `M  path` / `R  old -> new` / `RD old -> new`：
  // 取当前（新）路径；`D` 开头的行是删除，本身就说明「现在的树上没有这个改动」。
  const changedPaths = porcelain
    .filter((line) => !line.startsWith('D'))
    .map((line) => line.slice(3))
    .map((p) => p.split(' -> ').pop())
    .map(decodePorcelainPath)
    .map((p) => p.replace(/\/+$/, ''))
    .filter(Boolean);

  assert.ok(!changedPaths.includes('package.json'), 'package.json 不得改动');

  const writeSetFiles = new Set(WRITE_SET);
  // 后续工作 / 并行会话 / 发布措辞的落点（只认已存在路径）。
  // 平行验收文件本轮为「主区既有脏状态」补了排除表，属后续工作。
  const AFTER_V4_EXTRA = new Set([
    'tests/acceptance/v1-acceptance-triage/acceptance.test.cjs',
    'tests/acceptance/v3-cicd-compat/acceptance.test.cjs',
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
  // 后续工作 / 并行会话 / 发布措辞的落点（只认已存在路径）：
  // 主区里「别人的活」不算本片越界；白名单写错名字时路径不存在，等于不能放行。
  const outside = changedPaths.filter(
    (p) =>
      !writeSetFiles.has(p) && // 不是写集文件本身
      ![...writeSetFiles].some((w) => w.startsWith(p + '/')) && // 不是写集文件的父目录
      !KNOWN_OUT_OF_SCOPE.has(p) &&
      !AFTER_V4_EXTRA.has(p) &&
      !DELETED_AFTER_V4.has(p) &&
      !(AFTER_V4_PATHS.has(p) && fs.existsSync(path.join(ROOT, p))),
  );
  assert.deepEqual(outside, [], `改动不得越过写集：${outside.join(', ')}`);
});
// ─── 风险应对：区分「台账不符」与「命名非法」两种错误 ──────────────────────────

test('校验脚本区分「台账与 git 事实不符」与「非法命名」两种错误并分开列出', () => {
  // ADR-110 决策七之后，脚本会核对台账记的 commit 与 git 实际指向 ——
  // 不符时报「台账」类错误，与「命名非法」是**两类**不同的错误。
  //
  // 这里用**命名非法**那条路径验证分类（台账那条由 v4 切片的验收测）。
  const res = runScript(['v1']);
  assert.equal(res.status, 1, '非法命名应非零退出');
  assert.ok(res.output.includes('v1'), '输出必须点名非法 tag');
  assert.ok(res.output.includes('非法'), '输出必须报「非法命名」类别');
  assert.ok(
    !res.output.includes('版本号不一致'),
    '命名非法不该被报成「版本号不一致」（ADR-110 后脚本不再判 tag 的版本号）',
  );
});
