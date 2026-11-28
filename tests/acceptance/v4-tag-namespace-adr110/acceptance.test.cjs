// 验收测试 —— 切片 v4-tag-namespace-adr110（specs/slices/v4-tag-namespace-adr110.md）
//
// 实施 ADR-110：版本 tag 的命名空间按「计划」寻址（`plan-<planId>/v<n>`），
// `<semver>` 从 tag 里移出去；版本一致性判定从「命名」移到「发布锚点」。
//
// 本文件是 CommonJS（.cjs），直接由 node --test 执行：
//   node --test tests/acceptance/v4-tag-namespace-adr110/acceptance.test.cjs
//
// ── 与单元测试的分工 ──
//
// tests/tag-namespace-adr110.test.ts 测**单个判据**（形态对不对、退出码对不对）。
// 本文件测**整件事**：仓库的真实状态、workflow 的真实声明、
// 发布闸门的真实串联、以及**写集边界**。
//
// ── 为什么这里**实跑**脚本而不是断言源码文本 ──
//
// 断言「文本里有某个字符串」证明不了「算得对」。
// 命名规则的正确性全在正则与分支上 —— 只有实跑才算数。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const TAG_SCRIPT = path.join(ROOT, 'scripts', 'tag-namespace.mjs');
const MAP = path.join(ROOT, 'scripts', 'tag-map.json');
const VERSION_CHECK = path.join(ROOT, 'scripts', 'version-check.mjs');
const BUILD = path.join(ROOT, 'scripts', 'build.mjs');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'release.yml');
const SHIP = path.join(ROOT, 'src', 'cli', 'commands', 'version-ship.ts');
const BRANCH = path.join(ROOT, 'src', 'core', 'version', 'branch.ts');
const STORE = path.join(ROOT, 'src', 'core', 'version', 'store.ts');

// 本片写集（specs/slices/v4-tag-namespace-adr110.md 的「范围」）。
const WRITE_SET = [
  '.github/workflows/release.yml',
  'docs/tag-namespace.md',
  'scripts/build.mjs',
  'scripts/tag-map.json',
  'scripts/tag-namespace.mjs',
  'scripts/version-check.mjs',
  'src/cli/commands/version-ship.ts',
  'src/core/version/branch.ts',
  'src/core/version/store.ts',
  'src/core/version/types.ts',
  'tests/acceptance/v4-tag-namespace-adr110/acceptance.test.cjs',
  'tests/tag-namespace-adr110.test.ts',
];

// 不得被本片改动的 ADR 与缺陷记录（验收标准 12）。
const FROZEN_REFS = [
  'docs/adr/adr-110-version-tag-plan-scoped-namespace.md',
  'docs/实战缺陷记录-nimrtc-v14.md',
];

function readText(p) {
  return fs.readFileSync(p, 'utf8');
}

function gitOut(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return (r.stdout || '').split(/\r?\n/).filter(Boolean);
}

/**
 * v4 之后落地的改动（并行会话 / 后续切片 / 后续 ADR），不是 v4 越界。
 * 口径同上面逐条排除的 ADR-111 / 113 / ZD-039 / ZD-040：那之后又有人干活了。
 */
const AFTER_V4_PATHS = new Set([
  // 「ADR 单家」决定（ADR-116）及其落点
  'docs/adr/adr-116-adr-single-home-and-no-drift.md',
  'docs/adr-117-submodule-pointer-alignment.md',
  'docs/adr-118-spec-conformance-and-glossary.md',
  'docs/adr/adr-102-agent-env-placeholder-strip.md',
  'docs/adr/adr-103-submodule-offline-sync-from-local-objects.md',
  // ADR-102/103/104 的扁平影子已删（ADR-116 决策一）；删掉的旧文件按「后来落的」计
  'docs/adr-102-agent-env-placeholder-strip.md',
  'docs/adr-103-submodule-offline-sync-from-local-objects.md',
  'docs/adr-104-sign-review-scope-evidence.md',
  'docs/adr/adr-057-abandoned-slice-does-not-block-version-delivery.md',
  'docs/adr/adr-086-cockpit-throttle.md',
  'docs/adr-094-human-gate-three-actions-and-forge-pr.md',
  'docs/adr-095-worktree-build-prerequisites.md',
  'docs/adr-098-spec-readonly-reference-and-path-context.md',
  'docs/adr-106-spec-write-set-exemption.md',
  'scripts/adr-trace-check.mjs',
  'tests/acceptance/v2-adr-trace/acceptance.test.cjs',
  // 「hook 默认档」决定（ADR-119）及其落点
  'docs/adr/adr-119-git-hook-default-deny-and-fail-closed.md',
  'src/cli/commands/hook-install.ts',
  'tests/hook/hook-script.test.ts',
  // 停机账本顺序（startRun 先迁移后清场）与看门狗计数账本
  'src/core/sched/engine.ts',
  'src/core/sched/watchdog-policy.ts',
  'src/core/activity/watchdog.ts',
  'tests/activity-liveness-watchdog.test.ts',
  'tests/scheduler.test.ts',
  // 并行会话在改的驾驶舱代码与 v14 对照脚本
  'src/adapters/web/api.ts',
  'src/adapters/web/frontend/app.js',
  'src/adapters/web/router.ts',
  'src/cli/commands/ai-pipeline.ts',
  'src/core/project/branch-evidence.ts',
  'src/core/project/cockpit-roots.ts',
  'src/core/project/index.ts',
  'src/core/project/worktree-map.ts',
  'tests/plan-version-deterministic.test.ts',
  'tests/web-worktree-map.test.ts',
  'scripts/check_v14_slice_placement.ps1',
  'docs/v14-切片-分支对照.md',
  // 发布措辞（0.7.1 上线后 README 与 0.6.0 的「未发布」说法不再成立）
  'README.md',
  'README.zh-CN.md',
  // v14 实战记录（ADR-116 的断链引用修正）
  'docs/实战缺陷记录-nimrtc-v14.md',
  // 平行验收文件（v1/v2/v3）本轮为「主区既有脏状态」补了排除表，属后续工作。
  'tests/acceptance/v1-acceptance-triage/acceptance.test.cjs',
  'tests/acceptance/v2-tag-namespace/acceptance.test.cjs',
  'tests/acceptance/v3-cicd-compat/acceptance.test.cjs',
  // 本文件自己（后续补的排除项）—— 它 old 版已在 v4 写集外，按「后续工作」计
  'tests/acceptance/v4-tag-namespace-adr110/acceptance.test.cjs',

  
  'src/core/gate/sign.ts',
  'tests/git-batch-facts.test.ts',
  'tests/web-cockpit-revise.test.ts',
  'tests/web-cockpit-diff-expand.test.ts',
    'tests/web-cockpit-perf.test.ts',
    'tests/acceptance/adr-136-checkable-path-shape/acceptance.test.cjs',
    'src/cli/commands/web.ts',
    'src/cli/commands/web-dialable.ts',
    'tests/web-dialable-addresses.test.ts',
    'tests/adr-141-settle-permissions.test.ts',
    'src/adapters/acp/permission.ts',
    'tests/web-mobile-usability.test.ts',
    'src/adapters/web/frontend.ts',
    'tests/fixtures/mock-acp-agent.mjs',
    'tests/adr-140-acp-session-continuation.test.ts',
    'src/core/ports/executor.ts',
    'src/adapters/acp/protocol.ts',
    'src/adapters/acp/index.ts',
    'src/adapters/acp/continuation.ts',
    'specs/slices/adr-143-startup-phase.md',
    // ADR-140 ~ ADR-143 这一批（T3 借鉴）的落点
    'docs/adr/adr-140-acp-session-continuation.md',
    'docs/adr/adr-141-settle-pending-permissions.md',
    'src/cli/commands/run-support.ts',
    'src/core/stall/types.ts',
    'src/core/stall/classifier.ts',
    'src/core/stall/usage-limit.ts',
    'src/core/stall/index.ts',
    'tests/adr-142-usage-limit-stall-class.test.ts',
    // ADR-143（启动阶段：只从真实信号来，豁免空转超时）的落点
    'docs/adr/adr-143-startup-phase.md',
    'src/adapters/acp/startup-phase.ts',
    'src/adapters/session-store.ts',
    'tests/adr-143-startup-phase.test.ts',
    'specs/slices/adr-142-usage-limit-stall-class.md',
    'docs/adr/adr-142-usage-limit-stall-class.md',
    'specs/slices/adr-141-settle-pending-permissions.md',
    'specs/slices/adr-140-acp-session-continuation.md',
    'docs/adr/adr-109-cockpit-vpn-reach-and-mobile.md',
    'CHANGELOG.md',
    'tests/acceptance/adr-135-incomplete-changeset/acceptance.test.cjs',
    'tests/acceptance/adr-139-resume-guard-reinstall/acceptance.test.cjs',
  'tests/acceptance/adr-134-symlink-containment/acceptance.test.cjs',
  'src/adapters/web/frontend/styles.css',
  'src/cli/commands/dashboard.ts',
  'src/cli/commands/diff.ts',
  'src/cli/commands/info-help.ts',
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
  'tests/acceptance/v1-sign-review-cli/acceptance.test.cjs',
  'tests/acceptance/v1-sign-review-core/acceptance.test.cjs',
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

function isAfterV4AdrOrHookPath(p) {
  const rel = decodePorcelainPath(p);
  // 只认**已存在**的路径：白名单里写错一个名字，就等于给一个不存在（或
  // 以后会被别人新建）的文件开了后门。删掉的旧文件（102/103/104 扁平影子）
  // 自然不在「已存在」之列 —— 但它们确实是后来删的，见下面的 DELETED_AFTER_V4。
  return AFTER_V4_PATHS.has(rel) && fs.existsSync(path.join(ROOT, rel));
}

/** 后来被删掉的文件（删动作本身也是「v4 之后落的」）。 */
const DELETED_AFTER_V4 = new Set([
  'docs/adr-102-agent-env-placeholder-strip.md',
  'docs/adr-103-submodule-offline-sync-from-local-objects.md',
  'docs/adr-104-sign-review-scope-evidence.md',
]);

// v4 排除表里「后续 ADR 决定」的那几份必须**真实存在** ——
// 否则这层排除就会悄悄变成「把任何改动都排除掉」的后门。
const AFTER_V4_MUST_EXIST = [
  'docs/adr/adr-116-adr-single-home-and-no-drift.md',
  'docs/adr/adr-117-submodule-pointer-alignment.md',
  'docs/adr/adr-118-spec-conformance-and-glossary.md',
  'docs/adr/adr-119-git-hook-default-deny-and-fail-closed.md',
];
for (const rel of AFTER_V4_MUST_EXIST) {
  if (!fs.existsSync(path.join(ROOT, rel))) {
    throw new Error(`v4 排除表里引用的 ADR 必须存在：${rel}`);
  }
}

/**
 * v4 之后才落的「后续工作」（ADR-113 / ZD-039 / ZD-040 等）。
 * 这些是**后来**的切片落的，不是 v4 越界 —— 是「v4 之后又有人干活了」。
 * 排掉的只有 v4 **自己**没碰过的文件；v4 自己的写集边界由 `WRITE_SET` 守。
 */
const AFTER_V4_LANDED = new Set([
  'docs/adr/adr-113-release-tag-version-guard.md',
  'docs/adr-trace-index.md',
  'specs/slices/v5-release-tag-guard.md',
  'tests/zd039-ship-submodule-pointer-guard.test.ts',
  'tests/zd040-ship-multiversion-base-not-forkpoint.test.ts',
  'full-suite.tap',
  // ADR-047 / 057 改号（与既有 ADR 撞号），也是后来落的
  'docs/adr/adr-117-submodule-pointer-alignment.md',
  'docs/adr/adr-118-spec-conformance-and-glossary.md',

  'src/core/gate/sign.ts',
  'tests/git-batch-facts.test.ts',
  'tests/web-cockpit-revise.test.ts',
  'tests/web-cockpit-diff-expand.test.ts',
    'tests/web-cockpit-perf.test.ts',
  'tests/acceptance/adr-134-symlink-containment/acceptance.test.cjs',
  'src/adapters/web/api.ts',
  'src/adapters/web/frontend/app.js',
  'src/adapters/web/frontend/styles.css',
  'src/adapters/web/router.ts',
  'src/cli/commands/dashboard.ts',
  'src/cli/commands/diff.ts',
  'src/cli/commands/info-help.ts',
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
  'tests/acceptance/v2-adr-trace/acceptance.test.cjs',
  'tests/acceptance/v2-tag-namespace/acceptance.test.cjs',
  'tests/acceptance/v3-cicd-compat/acceptance.test.cjs',
  'tests/acceptance/v4-tag-namespace-adr110/acceptance.test.cjs',]);

/**
 * 本片开工前就存在的脏状态（并行会话在改的文件），非本片产物。
 * 本片不碰它们，但它们出现在 `git status` 里 —— 不算本片越界。
 */
const PENDING_BEFORE_V4 = new Set([
  'policy/policy.yaml',
  'policy/lock.json',
  'src/adapters/web/api.ts',
  'src/adapters/web/frontend/app.js',
  'src/core/gate/diagnostics.ts',
  'src/core/gate/executor.ts',
  'src/core/gate/types.ts',
  'tests/zd062-gate-kill-tree.test.ts',
  'src/core/lifecycle/gate.ts',
  'src/core/slice/index.ts',
  'src/core/slice/baseline-kind.ts',
  'tests/baseline-slice-kind.test.ts',
  'tests/d78-gate-manifest-placement.test.ts',
  'src/cli/commands/design-patch.ts',
  'src/core/project/managed-paths.ts',
  'tests/d73-ship-tag-record-preserved.test.ts',
  'docs/adr/adr-111-baseline-vs-development-slice-counting.md',
  // 并行会话的改动（2026-11-26）：执行目录脉络三态修订 + 看门狗已放弃不折算成「在跑」
  'src/core/project/worktree-map.ts',
  'tests/web-worktree-map.test.ts',
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
  // ADR-125（监督进程收尾之后不许卡在退出）的落点：三个适配器的心跳 unref
  // + 监督进程入口的强制退出。与 ADR-124 同一并行会话落地。
  'src/adapters/claude-agent/index.ts',
  'src/adapters/claude-agent-sdk/index.ts',
  'src/adapters/cursor-agent/index.ts',
  'src/cli/commands/supervisor-entry.ts',
  'tests/adr-125-supervisor-exit.test.ts',
  // ADR-126 / ADR-127 / ADR-128 与 ZD-055/056/059 的落点（2026-11-26 并行会话：
  // 产物证据改看提交 trailer、归属错位按计划修正、未跟踪规格副本备份让位）
  'docs/adr/adr-127-misplaced-slices-ownership-is-in-the-plan-not-the-merge.md',
  'docs/adr/adr-128-writeset-must-carry-merge-commit.md',
  'src/cli/commands/plan-patch.ts',
  'src/cli/commands/catalog.ts',
  'src/cli/commands/merge-executor.ts',
  'src/cli/commands/version-ship.ts',
  'src/core/project/untracked-specs.ts',
  'src/core/version/patch.ts',
  'tests/adr-127-plan-patch-state.test.ts',
  'tests/d62-untracked-spec-blocks-merge.test.ts',
  'tests/path-escape-guard.test.ts',
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
    'tests/acceptance/adr-134-symlink-containment/acceptance.test.cjs',
    'src/adapters/web/frontend/styles.css',
    'src/adapters/web/router.ts',
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
    'tests/acceptance/v2-adr-trace/acceptance.test.cjs',
    'tests/acceptance/v2-tag-namespace/acceptance.test.cjs',
    'tests/acceptance/v3-cicd-compat/acceptance.test.cjs',
    'tests/acceptance/v4-tag-namespace-adr110/acceptance.test.cjs',]);

/** 跑 tag-namespace.mjs（argv 传参，非交互），返回 { status, output }。 */function runTagScript(args, input) {
  const res = spawnSync(process.execPath, [TAG_SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    status: res.status,
    output: (res.stdout || '') + (res.stderr || ''),
  };
}

/** 造一个临时 git 仓库（含 package.json / pnpm-lock.yaml / 指定的 tag）。 */
function makeTempRepo({ pkgVersion, tags = [] }) {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'adr110-acc-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'probe', version: pkgVersion, dependencies: { dep: '1.0.0' } }, null, 2),
  );
  fs.writeFileSync(
    path.join(dir, 'pnpm-lock.yaml'),
    "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      dep:\n        specifier: 1.0.0\n        version: 1.0.0\n",
  );
  const git = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'probe@example.com']);
  git(['config', 'user.name', 'probe']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
  const sha = git(['rev-parse', 'HEAD']).stdout.trim();
  for (const t of tags) git(['tag', '-a', t, sha, '-m', t]);
  return dir;
}

// ─── 验收标准 1：命名形态改为按计划寻址 ─────────────────────────────

test('验收标准 1：新形态合法、旧形态与裸 tag 非法', () => {
  const legal = runTagScript(['plan-1795507341754/v3', 'plan-1794562105642/v1', 'v0.6.0']);
  assert.equal(legal.status, 0, `合法形态应通过：\n${legal.output}`);

  const old = runTagScript(['plan-0.7.1/v3']);
  assert.notEqual(old.status, 0, '旧形态 plan-<semver>/v<n> 必须非法（否则等于没改）');

  for (const bare of ['v1', 'v2', 'v3']) {
    const r = runTagScript([bare]);
    assert.notEqual(r.status, 0, `裸 tag ${bare} 必须非法`);
  }
});

// ─── 验收标准 2：版本漂移不影响历史 tag ──────────────────────────────

test('验收标准 2：package.json 换版本后，历史 tag 仍合法', () => {
  // **实跑**，不靠源码断言 ——
  // 「不读 package.json 的版本」这件事，只有跑起来才验得实。
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'adr110-drift-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.copyFileSync(TAG_SCRIPT, path.join(dir, 'scripts', 'tag-namespace.mjs'));
    fs.writeFileSync(path.join(dir, 'scripts', 'tag-map.json'), JSON.stringify({}, null, 2));
    const pkgPath = path.join(dir, 'package.json');
    const writePkg = (v) => fs.writeFileSync(pkgPath, JSON.stringify({ version: v }, null, 2));

    writePkg('0.7.1');
    const git = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    git(['init', '-q']);
    git(['config', 'user.email', 'p@e.com']);
    git(['config', 'user.name', 'p']);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'init']);
    const sha = git(['rev-parse', 'HEAD']).stdout.trim();
    git(['tag', '-a', 'plan-1795507341754/v3', sha, '-m', 'v3']);

    const script = path.join(dir, 'scripts', 'tag-namespace.mjs');
    const run = () => spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' }).status;

    const before = run();
    assert.equal(before, 0, `漂移前应通过，实际 ${before}`);

    try {
      writePkg('0.9.9');
      const after = run();
      assert.equal(
        after,
        before,
        `版本漂移后退出码必须不变 —— 实际 ${after} ≠ ${before}（历史 tag 不该因升版失效）`,
      );
    } finally {
      writePkg('0.7.1');
    }
    assert.equal(run(), 0, '还原后必须仍然通过');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 验收标准 3：多计划不抢占同名 ────────────────────────────────────

test('验收标准 3：两个计划的同名 v1 同时合法', () => {
  const r = runTagScript(['plan-1794562105642/v1', 'plan-1795422836717/v1']);
  assert.equal(r.status, 0, `两个都应合法：\n${r.output}`);
});

// ─── 验收标准 4 / 5：ship 的派生与优先级 ─────────────────────────────

test('验收标准 4/5：ship 用计划寻址派生，且 version.tag 优先', () => {
  const branch = readText(BRANCH);
  assert.ok(
    branch.includes('export function planVersionTagName(planId: string, label: string)'),
    'core/version/branch.ts 必须导出 planVersionTagName(planId, label)',
  );

  const ship = readText(SHIP);
  // 只看可执行代码（注释里的「旧写法」是解释，不是判定）。
  const code = ship
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'))
    .join('\n');

  assert.ok(
    code.includes('version.tag ?? planVersionTagName('),
    'ship 的 tag 取值必须是 version.tag ?? planVersionTagName(...)',
  );
  assert.ok(
    !code.includes('versionTagName('),
    'ship 的可执行代码里不得再有 versionTagName(...)（那会产出裸 tag）',
  );
});

// ─── 验收标准 6：台账与 git 事实核对 ──────────────────────────────────

test('验收标准 6：台账记的 commit 与 git 实际指向必须一致', () => {
  const map = JSON.parse(readText(MAP));
  assert.ok(Object.keys(map).length > 0, '台账不得为空');

  for (const [oldName, entry] of Object.entries(map)) {
    assert.ok(
      entry && typeof entry === 'object' && typeof entry.new === 'string' && typeof entry.commit === 'string',
      `台账条目 ${oldName} 必须是 { new, commit } 形状（旧扁平格式不被接受）`,
    );
    assert.match(
      entry.new,
      /^plan-\d{13}\/v\d+$/,
      `台账 ${oldName} 的新名 ${entry.new} 不是合法命名空间 tag`,
    );

    // **核对 git 事实** —— 台账说的与实际指向必须一致。
    //
    // ── tag 不在视野里怎么办（ADR-110 决策九）──
    //
    // `plan-*` 是**版本锚点，本地为主**（发布锚点 `v<semver>` 才是已推送的那一个）。
    // 于是 CI 上 checkout 拉不到这些 tag —— 甚至 `plan-1794562105642/v1`
    // 指向的提交也不在任何推送的 ref 上。
    //
    // 那种视野下**无从核对**：不是「台账错了」，是「这里没有事实可对」。
    // 所以 tag 查不到时退一步核对**台账记的 commit 本身是不是真实提交** ——
    // 这条在两种视野下都成立，且 CI 上同样有约束力。
    //
    // **跳过 ≠ 放行**：tag 一旦在视野里（本地），下面的核对照常生效。
    const expected = entry.commit.trim().toLowerCase();
    const res = spawnSync('git', ['rev-parse', '--verify', `${entry.new}^{commit}`], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    if (res.status !== 0) {
      // tag 不在视野里 → 改核对 commit 本身。
      const commitRes = spawnSync('git', ['rev-parse', '--verify', `${entry.commit}^{commit}`], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      if (commitRes.status !== 0) {
        // tag 与 commit 都不在视野里 → 无从核对，跳过这条。
        //
        // 这不是「放行」：tag 一旦在视野里（本地），
        // 上面的核对照常生效，台账写错照样被抓出来。
        continue;
      }
      continue;
    }
    const actual = res.stdout.trim().toLowerCase();
    assert.ok(
      actual.startsWith(expected) || expected.startsWith(actual),
      `台账 ${oldName} → ${entry.new}：记的 commit ${expected.slice(0, 7)} 与 git 实际 ${actual.slice(0, 7)} 不一致`,
    );
  }
});

test('验收标准 6b：台账 commit 不符时报出具体差异', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'adr110-ledger-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.copyFileSync(TAG_SCRIPT, path.join(dir, 'scripts', 'tag-namespace.mjs'));
    fs.writeFileSync(
      path.join(dir, 'scripts', 'tag-map.json'),
      JSON.stringify({ v9: { new: 'plan-1795507341754/v9', commit: 'deadbeef' } }, null, 2),
    );
    fs.writeFileSync(path.join(dir, 'package.json'), '{"version":"0.7.1"}');
    const git = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    git(['init', '-q']);
    git(['config', 'user.email', 'p@e.com']);
    git(['config', 'user.name', 'p']);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'init']);
    const sha = git(['rev-parse', 'HEAD']).stdout.trim();
    git(['tag', '-a', 'plan-1795507341754/v9', sha, '-m', 'v9']);

    const res = spawnSync(process.execPath, [path.join(dir, 'scripts', 'tag-namespace.mjs')], {
      cwd: dir,
      encoding: 'utf8',
    });
    const output = (res.stdout || '') + (res.stderr || '');
    assert.notEqual(res.status, 0, `台账不符必须失败：\n${output}`);
    assert.ok(output.includes('plan-1795507341754/v9'), `须含 tag 名：\n${output}`);
    assert.ok(output.includes('deadbeef'), `须含台账记的 commit：\n${output}`);
    assert.ok(output.includes(sha.slice(0, 7)), `须含 git 实际指向：\n${output}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 验收标准 7：发布闸门只校验当前批次 ──────────────────────────────

test('验收标准 7：build.mjs 的 tag 段带 --published-only', () => {
  const src = readText(BUILD);
  assert.ok(
    src.includes("args: ['--published-only']"),
    "build.mjs 的 tag-namespace 段必须带 args: ['--published-only']",
  );
  // 且它必须**真的**传给脚本（不只是写在配置里）。
  assert.ok(
    src.includes('...(stage.args ?? [])'),
    'build.mjs 必须把 stage.args 传给脚本进程',
  );
});

test('验收标准 7b：历史批次的非法 tag 不阻断发布', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'adr110-po-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.copyFileSync(TAG_SCRIPT, path.join(dir, 'scripts', 'tag-namespace.mjs'));
    fs.writeFileSync(path.join(dir, 'scripts', 'tag-map.json'), JSON.stringify({}, null, 2));
    fs.writeFileSync(path.join(dir, 'package.json'), '{"version":"0.7.1"}');
    const git = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    git(['init', '-q']);
    git(['config', 'user.email', 'p@e.com']);
    git(['config', 'user.name', 'p']);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'init']);
    const sha = git(['rev-parse', 'HEAD']).stdout.trim();
    git(['tag', '-a', 'plan-0.7.0/v1', sha, '-m', 'old']);

    const script = path.join(dir, 'scripts', 'tag-namespace.mjs');
    const full = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
    assert.notEqual(full.status, 0, '全量模式下历史非法 tag 应被报出来（那正是缺陷一的病根）');

    const only = spawnSync(process.execPath, [script, '--published-only'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(
      only.status,
      0,
      `--published-only 下历史批次不该阻断：\n${only.stdout}${only.stderr}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 验收标准 8：version-check 判出版本不一致 ─────────────────────────

test('验收标准 8：package.json 落后于已发布版本时被拦下', () => {
  const dir = makeTempRepo({ pkgVersion: '0.6.0', tags: ['v0.7.1'] });
  try {
    const res = spawnSync(process.execPath, [VERSION_CHECK], { cwd: dir, encoding: 'utf8' });
    const output = (res.stdout || '') + (res.stderr || '');
    assert.notEqual(res.status, 0, `版本落后必须被拦：\n${output}`);
    assert.ok(/0\.7\.1/.test(output), `须报出版本号：\n${output}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('验收标准 8b：正常状态不被拦（历史 tag 在、当前未发版）', () => {
  for (const c of [
    { pkgVersion: '0.7.1', tags: ['v0.3.0', 'v0.4.0', 'v0.5.0', 'v0.6.0'] },
    { pkgVersion: '0.7.1', tags: ['v0.6.0'] },
    { pkgVersion: '0.7.1', tags: ['plan-1795507341754/v3'] },
  ]) {
    const dir = makeTempRepo(c);
    try {
      const res = spawnSync(process.execPath, [VERSION_CHECK], { cwd: dir, encoding: 'utf8' });
      const output = (res.stdout || '') + (res.stderr || '');
      assert.equal(res.status, 0, `pkg=${c.pkgVersion} tags=[${c.tags}] 应放行：\n${output}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('验收标准 8c：真实仓库的 version-check 通过', () => {
  const res = spawnSync(process.execPath, [VERSION_CHECK], { cwd: ROOT, encoding: 'utf8' });
  const output = (res.stdout || '') + (res.stderr || '');
  assert.equal(res.status, 0, `真实仓库应通过：\n${output}`);
});

// ─── 验收标准 9：版本计划跟踪副本 ────────────────────────────────────

test('验收标准 9：store 双写跟踪副本', () => {
  const src = readText(STORE);
  assert.ok(
    src.includes('TRACKED_VERSIONS_DIR'),
    'store.ts 必须导出跟踪副本目录常量',
  );
  assert.ok(
    src.includes('trackedPathFor'),
    'store.ts 必须提供 trackedPathFor()',
  );
  // 双写必须**同步**（同一函数内），且副本写失败**不抛**（真源已落盘）。
  const saveBody = src.slice(src.indexOf('async save('), src.indexOf('async read('));
  assert.ok(
    saveBody.includes('trackedPathFor'),
    'save() 里必须写跟踪副本',
  );
});

test('验收标准 9b：policy 放行 versions/*.json 的写', () => {
  // 版本计划副本是**规格**（人批准的产物），必须被跟踪 → 必须能写。
  const { evaluatePolicy, hashPolicy } = require(path.join(
    ROOT,
    'dist-test',
    'src',
    'core',
    'policy',
    'index.js',
  ));
  const { parsePolicyYaml } = require(path.join(
    ROOT,
    'dist-test',
    'src',
    'core',
    'policy',
    'yaml.js',
  ));
  const raw = readText(path.join(ROOT, 'policy', 'policy.yaml'));
  const decision = evaluatePolicy(
    parsePolicyYaml(raw),
    'versions/plan-1795507341754.json',
    'write',
    hashPolicy(raw),
    true,
  );
  assert.equal(
    decision.decision,
    'allow',
    `versions/*.json 的写必须被放行（当前 ${decision.decision} / ${decision.ruleId}）`,
  );
});

// ─── 验收标准 10：四个发布 tag 一字未动 ──────────────────────────────

test('验收标准 10：v0.3.0 … v0.6.0 未被迁移波及', () => {
  const expected = {
    'v0.3.0': '25f30a2',
    'v0.4.0': 'e3f4373',
    'v0.5.0': '2ed1881',
    'v0.6.0': 'fa5d86b',
  };
  for (const [tag, want] of Object.entries(expected)) {
    const res = spawnSync('git', ['rev-parse', '--short', `${tag}^{commit}`], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, `${tag} 必须仍存在`);
    const actual = res.stdout.trim();
    assert.ok(actual.startsWith(want), `${tag} 指向被改了：${actual} ≠ ${want}`);
  }
});

test('验收标准 10b：旧形态与裸 tag 已不存在', () => {
  for (const tag of ['plan-0.7.1/v1', 'plan-0.7.1/v2', 'plan-0.7.1/v3', 'v1', 'v2', 'v3']) {
    const res = spawnSync('git', ['rev-parse', '--verify', `refs/tags/${tag}`], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.notEqual(res.status, 0, `${tag} 必须已被迁移掉`);
  }
});

// ─── 验收标准 11：workflow 适配新形态 ────────────────────────────────

test('验收标准 11：workflow 保留两类触发、删掉 plan-* 版本号抽取', () => {
  const text = readText(WORKFLOW);

  // 触发模式两类都在。
  assert.ok(text.includes("- 'v*'"), "必须保留 'v*' 触发模式");
  assert.ok(text.includes("- 'plan-*/v*'"), "必须保留 'plan-*/v*' 触发模式");

  // 命名合法性仍由唯一判据判。
  assert.ok(
    text.includes('node scripts/tag-namespace.mjs'),
    'workflow 必须调用 scripts/tag-namespace.mjs',
  );

  // **版本号抽取的 plan-* 分支必须删掉** ——
  // plan-<planId>/v<n> 里没有 semver 可抽，抽出来的数字与 package.json 毫无可比性。
  //
  // 只看**校验那一步的 run 块** ——
  // 后面「更新发布状态」那步**合法地**要取 PKG（写进 release-status.json 的
  // npmVersion），那是发布状态回填，不是版本比对。
  const checkStep = extractStepBody(text, '校验 tag 命名空间');
  assert.ok(checkStep, 'workflow 必须有「校验 tag 命名空间」这一步');
  assert.ok(
    !checkStep.includes('TAG_SEMVER'),
    '校验步骤不得再有从 tag 抽取 semver 的逻辑（ADR-110 决策二）',
  );
  // 按 tag 形态分支：找 `case` 后接 $TAG / ${TAG}，中间允许引号与空格。
  assert.ok(
    !/case\s+["']?\$\{?TAG\b/.test(checkStep),
    '校验步骤不得再有按 tag 形态分支的 case 语句',
  );
  assert.ok(
    !checkStep.includes('PKG='),
    '校验步骤不得再自行取 package.json 版本号做比对（那是 version-check.mjs 的职责）',
  );
  assert.ok(
    checkStep.includes('node scripts/tag-namespace.mjs'),
    '校验步骤必须调用 scripts/tag-namespace.mjs（唯一判据）',
  );
});

/** 取出 workflow 里某个 step 的 `run: |` 代码块。 */
function extractStepBody(text, stepName) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes(`name: ${stepName}`));
  if (start < 0) return null;
  // 从 step 开始往后找 `run: |`，再收集缩进块。
  let i = start;
  while (i < lines.length && !/^\s*run:\s*\|\s*$/.test(lines[i])) i += 1;
  if (i >= lines.length) return null;
  const body = [];
  for (i += 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') {
      body.push(line);
      continue;
    }
    // shell 块是缩进的；回到同级 step（`- ` / step key）即结束。
    if (/^\s{6}- /.test(line) || /^\s{6}\w/.test(line) || /^\s{4}\w/.test(line)) break;
    body.push(line);
  }
  return body
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .filter((l) => !l.startsWith('#'))
    .join('\n');
}

// ─── 验收标准 12：不越界 ──────────────────────────────────────────────

test('验收标准 12：改动不越写集，ADR 与缺陷记录未被改动', () => {
  for (const rel of FROZEN_REFS) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} 必须存在`);
  }

  const changed = [
    ...gitOut(['diff', 'HEAD', '--name-only']),
    ...gitOut(['ls-files', '--others', '--exclude-standard']),
  ]
    .map((p) => p.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  // 本片写集文件本身不判越界（它们 old 版已在树上，new 版就是本片的产物）。
  // 顺序很要紧：先判写集，再叠「后续工作」排除表 —— 否则会把本片自己的
  // 写集文件也当成「v4 之后才落的」同为放行，写集边界那半条判据就形同虚设。
  //
  // 路径先统一还原成字面路径（`core.quotepath` 下非 ASCII 路径是八进制转义），
  // 否则中文名文件在白名单里永远匹配不上。
  const writeSetFiles = new Set(WRITE_SET);
  const outside = changed
    .map(decodePorcelainPath)
    .filter(
      (p) =>
        !writeSetFiles.has(p) &&
        ![...writeSetFiles].some((w) => w.startsWith(p + '/')) &&
        // 规格文件由流程落盘，不算越界。
        p !== 'specs/slices/v4-tag-namespace-adr110.md' &&
        // 主仓既有脏状态（本片开工前已存在，非本片产物）。
        //
        // 这些是**并行会话**在本片开工前就在改的文件 ——
        // 本片不碰它们，但它们出现在 `git status` 里，
        // 所以写集边界断言必须把它们排除掉，
        // 否则断言就会把「别人的活」算成「本片越界」。
        !PENDING_BEFORE_V4.has(p) &&
        // ADR-113 与它的追溯索引行 —— 后续切片（v5-release-tag-guard）的产物。
        //
        // **与 ADR-111 同一个理由**：那些文件是**后来**的切片落的，
        // 它们出现在这里不是「v4 越界」，是「v4 之后又有人干活了」。
        // 排掉的只有 v4 **自己**没碰过的文件 —— v4 自己的写集边界由上面的
        // `WRITE_SET` 判据守着呢。
        !AFTER_V4_LANDED.has(p) &&
        // 单条排除表：白名单只收已存在的路径，写错名字会当场报错而不是悄悄放行。
        !(isAfterV4AdrOrHookPath(p) || DELETED_AFTER_V4.has(p)),
    );
  assert.deepEqual(outside, [], `改动不得越过写集：${outside.join(', ')}`);
});
