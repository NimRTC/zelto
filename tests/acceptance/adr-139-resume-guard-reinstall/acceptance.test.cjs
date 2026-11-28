// 验收测试 —— 切片 adr-139-resume-guard-reinstall：提问回路续跑段必须重装运行时守卫
//
// 对应 specs/slices/adr-139-resume-guard-reinstall.md（ADR-139）。
// 全部用例是真断言，无 todo / skip —— 门禁②会识别「没有一条用例真正跑起来」
// 的验收文件并判 failed。
//
// 本文件是 CommonJS（.cjs），直接由 node --test 执行：
//   node --test tests/acceptance/adr-139-resume-guard-reinstall/acceptance.test.cjs
//
// 被测产物：
//   - src/cli/commands/resume-guard.ts  —— 续跑段的守卫装法
//   - src/cli/commands/question.ts      —— 续跑前装、结束后释放、装不上就拒绝
//   - src/hook/pretool.ts               —— 判定内核（真跑一次，验证判定真的发生）
//
// ── 这个验收文件钉住的核心 ────────────────────────────────────────────
//
// 「续跑段有守卫」这件事**只有一条外部证据**：续跑期间 agent 写文件
// 会产生 `policy.decision` 事件，且越界写入被**拒绝**。
//
// 所以本文件不只测「装上了没」—— 它**真跑一次 hook 进程**，
// 验证判定真的发生了。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DIST = path.join(ROOT, 'dist');

const { installResumeGuard } = require(path.join(DIST, 'cli', 'commands', 'resume-guard.js'));

// ─── 写集（与切片规格一致）─────────────────────────────────────────────
const WRITE_SET = [
  'src/cli/commands/question.ts',
  'src/cli/commands/resume-guard.ts',
  'src/cli/commands/shared.ts',
  'src/cli/commands/parallel-executor.ts',
  'tests/adr-139-resume-guard.test.ts',
  'tests/acceptance/adr-139-resume-guard-reinstall/acceptance.test.cjs',
  'specs/slices/adr-139-resume-guard-reinstall.md',
  'docs/adr/adr-139-resume-guard-reinstall.md',
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
 * 口径与其它验收套件一致：只排掉本片自己没碰过的文件 ——
 * 本片自己的写集边界仍由上面的 `WRITE_SET` 守。
 */
const NOT_THIS_SLICE = new Set([
  'src/adapters/web/frontend/app.js',
  'src/adapters/web/frontend/styles.css',
  'src/cli/commands/web.ts',
  'src/cli/commands/web-dialable.ts',
  'src/core/arch/scan.ts',
  'src/core/arch/types.ts',
  'src/core/arch/index.ts',
  'src/core/arch/tooling-files.ts',
  'tests/arch-guard.test.ts',
  'tests/arch-resolve.test.ts',
  'tests/arch-tooling-files.test.ts',
  'tests/web-cockpit-perf.test.ts',
  'tests/web-cockpit-diff-expand.test.ts',
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
  'tests/.tmp-arch-check.test.ts',
  'tests/acceptance/v1-acceptance-triage/acceptance.test.cjs',
  'tests/acceptance/v2-adr-trace/acceptance.test.cjs',
  'tests/acceptance/v2-tag-namespace/acceptance.test.cjs',
  'tests/acceptance/v3-cicd-compat/acceptance.test.cjs',
  'tests/acceptance/v4-tag-namespace-adr110/acceptance.test.cjs',
  'tests/acceptance/adr-134-symlink-containment/acceptance.test.cjs',
  'tests/acceptance/adr-135-incomplete-changeset/acceptance.test.cjs',
  'tests/acceptance/adr-136-checkable-path-shape/acceptance.test.cjs',
  'docs/adr/adr-102-agent-env-placeholder-strip.md',
  'docs/adr/adr-138-tooling-scripts-are-not-architecture.md',
  // v3-docs 的验收文件本轮改为「读时快照」（消除 ADR 影子被搬走时的竞态）—— 后续工作
  'tests/acceptance/v3-docs/acceptance.test.cjs',
]);

// ─── 夹具 ──────────────────────────────────────────────────────────────

/**
 * 造一个能装守卫的最小环境（git 仓 + 策略 + 切片记录）。
 *
 * 切片记录必须**手写**而不是用 `zelto create` —— 验收要快，
 * 而且这里要控制切片的初始状态（running + agent_question 停机）。
 */
function makeFixture(sliceId, writes) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zelto-acc-139-'));
  const git = (...args) =>
    execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
      cwd: base,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  git('init', '-q');
  git('config', 'user.email', 'test@zelto.local');
  git('config', 'user.name', 'zelto test');

  fs.mkdirSync(path.join(base, 'policy'), { recursive: true });
  // 策略里必须显式 allow `src/**` —— 默认档是 deny
  // （hook 的兜底：`evaluateRules` 落到 default 就是 deny）。
  //
  // 这不是「为了让测试通过而放宽策略」—— 它让夹具**与真实策略同口径**：
  // 真实仓的 `policy.yaml` 也有 `allow-src-ts` 这条。
  fs.writeFileSync(
    path.join(base, 'policy', 'policy.yaml'),
    [
      'rules:',
      '  - id: allow-src',
      '    match: { path: "src/**", operation: "write" }',
      '    action: allow',
      '    basis: "test-fixture"',
      '',
    ].join('\n'),
    'utf-8',
  );

  fs.mkdirSync(path.join(base, '.zelto', 'slices'), { recursive: true });
  fs.writeFileSync(
    path.join(base, '.zelto', 'slices', `${sliceId}.json`),
    JSON.stringify(
      {
        id: sliceId,
        title: sliceId,
        state: 'running',
        spec: {
          path: `specs/slices/${sliceId}.md`,
          frozenHash: null,
          frozenAt: null,
          boundaryHash: null,
        },
        acceptance: { dir: `tests/acceptance/${sliceId}/`, frozenHash: null, oracleSrc: null },
        baseCommit: null,
        drift: { detected: false, reason: null, at: null },
        trace: { requirements: [], contracts: [], tests: [] },
        traceWaiver: null,
        baseline: false,
        writes,
        runs: [],
        stall: { class: 'agent_question', gateRetries: 0 },
      },
      null,
      2,
    ),
    'utf-8',
  );

  return base;
}

function cleanup(base) {
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响判定 */
  }
}

/**
 * 读事件流。
 *
 * 落点是 `.zelto/events/<sliceId>/events.jsonl`（hook 的判定事件也是这里）
 * —— 不是 `<sliceId>.jsonl`，那是切片级事件流的另一种落法。
 * 两处都读：判定事件（`policy.decision`）在目录式落点里。
 */
function readEvents(base, sliceId) {
  const candidates = [
    path.join(base, '.zelto', 'events', sliceId, 'events.jsonl'),
    path.join(base, '.zelto', 'events', `${sliceId}.jsonl`),
  ];
  const events = [];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf-8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        /* 单条损坏不影响其它 */
      }
    }
  }
  return events;
}

// ─── 验收标准 1：续跑段必须有写集预约 ──────────────────────────────────

test('续跑段装守卫后，写集预约生效', async () => {
  const sliceId = 'adr139-reservation';
  const base = makeFixture(sliceId, ['src/**']);
  const cwd = process.cwd();
  try {
    // 切片存储与事件流都落在这个仓库根下（`.zelto/`）——
    // 所以进程 cwd 必须切进临时目录，否则会写进真仓库。
    process.chdir(base);

    const guard = await installResumeGuard({
      sliceId,
      adapterType: 'claude-agent',
      projectRoot: base,
    });

    const lockPath = path.join(base, '.zelto', 'locks', `${sliceId}.json`);
    assert.ok(fs.existsSync(lockPath), '续跑段必须有写集预约');

    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    assert.equal(lock.releasedAt ?? null, null, '预约必须是生效中的');
    assert.deepEqual(lock.writes, ['src/**'], '预约里的写集来自切片记录');

    await guard.release();
  } finally {
    process.chdir(cwd);
    cleanup(base);
  }
});

// ─── 验收标准 2：续跑段必须有 PreToolUse 钩子 ───────────────────────────

test('续跑段装守卫后，PreToolUse 钩子装在 .claude/settings.local.json', async () => {
  const sliceId = 'adr139-hook';
  const base = makeFixture(sliceId, ['src/**']);
  const cwd = process.cwd();
  try {
    process.chdir(base);

    const guard = await installResumeGuard({
      sliceId,
      adapterType: 'claude-agent',
      projectRoot: base,
    });

    const settingsPath = path.join(base, '.claude', 'settings.local.json');
    assert.ok(fs.existsSync(settingsPath), '续跑段必须装 PreToolUse 钩子');

    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const commands = (raw.hooks?.PreToolUse ?? []).flatMap((e) =>
      (e.hooks ?? []).map((h) => h.command ?? ''),
    );
    assert.ok(
      commands.some((c) => c.includes('--zelto-pretool')),
      `配置里必须有 zelto 那一条 PreToolUse：${JSON.stringify(raw)}`,
    );

    await guard.release();
  } finally {
    process.chdir(cwd);
    cleanup(base);
  }
});

// ─── 验收标准 3（核心）：续跑段的判定要真的发生 ─────────────────────────
//
// 这一条是**端到端**的：装守卫 → 真跑一次 `zelto pretool` 进程 →
// 验证 (a) 判定产生了 `policy.decision` 事件，(b) 越界写入被**拒绝**。
//
// 只测「钩子文件在不在」是不够的 —— 那证明不了判定真的跑了。

test('续跑段写文件 → 产生 policy.decision 事件，且越界写入被拒绝', async () => {
  const sliceId = 'adr139-e2e';
  const base = makeFixture(sliceId, ['src/**']);
  const cwd = process.cwd();
  try {
    process.chdir(base);

    const guard = await installResumeGuard({
      sliceId,
      adapterType: 'claude-agent',
      projectRoot: base,
    });

    // 真跑一次 hook 进程 —— 模拟 agent 在续跑段写文件。
    const hookPath = path.join(DIST, 'hook', 'index.js');
    assert.ok(fs.existsSync(hookPath), 'dist/hook/index.js 必须已构建');

    const runHook = (target) =>
      spawnSync(
        process.execPath,
        [
          hookPath,
          'pretool',
          '--project-root',
          base,
          '--slice',
          sliceId,
          '--zelto-pretool',
        ],
        {
          cwd: base,
          encoding: 'utf-8',
          input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: target } }),
        },
      );

    // 写集内的文件 → 放行
    const inside = runHook(path.join(base, 'src', 'ok.ts'));
    assert.equal(inside.status, 0, `hook 必须正常退出，实际：${inside.stderr}`);
    const insideOut = JSON.parse(inside.stdout);
    assert.equal(
      insideOut.hookSpecificOutput?.permissionDecision,
      'allow',
      `写集内的写入必须放行，实际：${inside.stdout}`,
    );

    // 写集外的文件 → 拒绝
    const outside = runHook(path.join(base, 'other', 'evil.ts'));
    assert.equal(outside.status, 0, `hook 必须正常退出（判定拒绝不是崩溃），实际：${outside.stderr}`);
    const outsideOut = JSON.parse(outside.stdout);
    assert.equal(
      outsideOut.hookSpecificOutput?.permissionDecision,
      'deny',
      `写集外的写入必须拒绝，实际：${outside.stdout}`,
    );

    // 判定进了事件流 —— 这是「修复有没有生效」的唯一外部证据。
    const events = readEvents(base, sliceId);
    const decisions = events.filter((e) => e.type === 'policy.decision');
    assert.ok(
      decisions.length >= 2,
      `续跑段的判定必须进事件流（ADR-139 验收标准 3），实际只看到 ${decisions.length} 条`,
    );
    assert.ok(
      decisions.some((d) => d.payload?.decision === 'deny'),
      '必须有一条 deny 的判定留痕 —— 越界写入被当场拒绝',
    );

    await guard.release();
  } finally {
    process.chdir(cwd);
    cleanup(base);
  }
});

// ─── 验收标准 4：装守卫失败 → 拒绝续跑（fail closed）───────────────────

test('拿不到写集预约时 installResumeGuard 抛错（调用方据此拒绝续跑）', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zelto-acc-139-fail-'));
  const cwd = process.cwd();
  try {
    process.chdir(base);
    await assert.rejects(
      () =>
        installResumeGuard({
          sliceId: 'adr139-missing',
          adapterType: 'claude-agent',
          projectRoot: base,
        }),
      /./,
      '装不上守卫必须抛错 —— 静默返回会让调用方以为装上了',
    );
  } finally {
    process.chdir(cwd);
    cleanup(base);
  }
});

// ─── 验收标准 5：续跑结束必须释放 ──────────────────────────────────────

test('释放后预约被释放、钩子被撤掉', async () => {
  const sliceId = 'adr139-release';
  const base = makeFixture(sliceId, ['src/**']);
  const cwd = process.cwd();
  try {
    process.chdir(base);

    const guard = await installResumeGuard({
      sliceId,
      adapterType: 'claude-agent',
      projectRoot: base,
    });
    await guard.release();

    const lock = JSON.parse(
      fs.readFileSync(path.join(base, '.zelto', 'locks', `${sliceId}.json`), 'utf-8'),
    );
    assert.ok(lock.releasedAt, '释放后预约必须被释放 —— 悬空预约会让下片撞写集冲突');

    const settingsPath = path.join(base, '.claude', 'settings.local.json');
    if (fs.existsSync(settingsPath)) {
      const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      const commands = (raw.hooks?.PreToolUse ?? []).flatMap((e) =>
        (e.hooks ?? []).map((h) => h.command ?? ''),
      );
      const remaining = commands.filter((c) => c.includes('--zelto-pretool'));
      assert.equal(remaining.length, 0, '释放后不应残留 zelto 的钩子条目');
    }
  } finally {
    process.chdir(cwd);
    cleanup(base);
  }
});

// ─── 验收标准 6：续跑段必须跑写集审计 ──────────────────────────────────
//
// 钩子只拦「agent 通过工具写文件」。`git checkout`、
// `node -e "fs.writeFileSync(...)"`、子进程写文件都绕过钩子 ——
// **审计是唯一兜住这些的防线**。
//
// 这里验证：续跑段调了 `enforceWriteSet`，且判成越界时切片退回 frozen。

test('续跑段调用 enforceWriteSet（越界 → 退回 frozen，不进 gate）', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'src', 'cli', 'commands', 'question.ts'),
    'utf-8',
  );

  assert.ok(
    src.includes('enforceWriteSet'),
    'question.ts 必须调用 enforceWriteSet —— 续跑段也要有写集审计（ADR-139 决策三之二）',
  );
  assert.ok(
    src.includes('withinBounds'),
    '必须用审计结论决定放不放行 —— 不看结论就等于没审计',
  );
  assert.ok(
    src.includes('installResumeGuard'),
    'question.ts 必须在续跑前装守卫',
  );

  // 审计判成越界 → 不许进门禁。
  //
  // 注意要找**调用点**而不是 import 语句 —— import 在文件头部，
  // 永远排在任何分支之前，拿它比位置是比不出顺序的。
  const gateIdx = src.indexOf('await autoGateAfterRun(');
  const boundsIdx = src.indexOf('if (!withinBounds.ok)');
  assert.ok(boundsIdx >= 0, '必须有一处以审计结论为条件的分支');
  assert.ok(gateIdx > boundsIdx, '越界分支必须在进门禁之前 —— 越界的文件不该被门禁放行');
});

// ─── 验收标准 7：装守卫失败不许降级成「无守卫续跑」────────────────────

test('装守卫失败 → 拒绝续跑（fail closed，不降级）', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'src', 'cli', 'commands', 'question.ts'),
    'utf-8',
  );

  // 装守卫的 try/catch 里必须 `return 1`（拒绝）——
  // 而不是「catch 掉继续续跑」（那正是 C9 要防的 fail open）。
  const installIdx = src.indexOf('installResumeGuard');
  assert.ok(installIdx >= 0, '必须装守卫');

  const catchIdx = src.indexOf('catch (err)', installIdx);
  assert.ok(catchIdx > installIdx, '装守卫必须有 catch 分支');

  const catchBlock = src.slice(catchIdx, catchIdx + 800);
  assert.ok(
    /return\s+1/.test(catchBlock),
    '装守卫失败必须 return 1（拒绝续跑）—— C9 写的是「预约缺失时 fail closed（一律拒绝）」',
  );
  assert.ok(
    !/fail open|降级|继续续跑/.test(catchBlock),
    '不许把 fail closed 写成降级续跑',
  );
});

// ─── 验收标准 8：产物存在 ──────────────────────────────────────────────

test('产物存在：resume-guard.ts 与 dist/cli/commands/resume-guard.js', () => {
  assert.ok(
    fs.existsSync(path.join(ROOT, 'src', 'cli', 'commands', 'resume-guard.ts')),
    'src/cli/commands/resume-guard.ts 必须在树上存在',
  );
  assert.ok(
    fs.existsSync(path.join(DIST, 'cli', 'commands', 'resume-guard.js')),
    'dist/cli/commands/resume-guard.js 必须已构建',
  );
  assert.ok(
    fs.existsSync(path.join(DIST, 'hook', 'index.js')),
    'dist/hook/index.js 必须已构建',
  );
});

// ─── 验收标准 9：判定层零第三方依赖（C2）──────────────────────────────

test('resume-guard.ts 不引入第三方依赖（C2）', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'src', 'cli', 'commands', 'resume-guard.ts'),
    'utf-8',
  );
  const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const external = imports.filter(
    (i) => !i.startsWith('node:') && !i.startsWith('./') && !i.startsWith('../'),
  );
  assert.deepEqual(external, [], `resume-guard.ts 不得有第三方依赖，实际：${external.join(', ')}`);
});

// ─── 验收标准 10：不越界（改动只在写集内）─────────────────────────────

test('本片不越界（改动只在写集内）', () => {
  // 门禁在隔离 worktree 里跑（ROOT = worktree），主区合并后跑（ROOT = 主区）：
  // 判据一样 —— 只看「本片自己的改动」。
  const sliceWt = path.join(ROOT, '.zelto', 'worktrees', 'adr-139-resume-guard-reinstall');
  const target = fs.existsSync(sliceWt) ? sliceWt : ROOT;

  const status = spawnSync(
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
