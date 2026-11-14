// 验收测试 —— `zelto sign --review` 第二轮修复（切片 v2-sign-review-fix）
//
// 修复主干验证在 v1 交付切片上暴露的两处误判：
//   1. 写集项陈旧 —— collectWriteSetAudit 只取最新一条 policy.violation，
//      无视之后已通过的 gate.result。越界在扩写集/重跑后已解决，
//      旧结论还留着，已交付切片永远显示「改动在写集内 FAIL」。
//   2. 验收项漏判 —— collectGateFacts 只认 payload.acceptance 与
//      results[].command === 'acceptance'。项目没配 gate.acceptance
//      （skipped），真正跑过的验收是 spec.gateCommands 里的
//      acceptance-cli（6 用例全过），被判成「没跑过」。
//
// 本文件是 CommonJS（.cjs），直接由 node --test 执行：
//   node --test tests/acceptance/v2-sign-review-fix/acceptance.test.cjs
//
// 被测的是 dist 产物（先跑 pnpm build）。collect-facts 是 CLI 层（唯一允许
// 读 .zelto / 跑 git 的模块），evaluate 是 core 层纯函数。两条路径都走
// 真实产物，不做 mock 的自我满足。全部用例是真断言，无 todo / skip。
//
// 夹具与 v1-sign-review-cli / v1-sign-review-core 的**真实事件流**对齐：
// 越界事件与 gate.result 事件从真实 events.jsonl 摘录（时间戳、命令名、
// acceptance 状态、violations 原样保留），只有 acceptance-cli 的 stdout
// 归一成 TAP 汇总行 —— 那是 parseTestRunnerStats 唯一能解析出 pass>0 的
// 形态（真实 spec 报告器输出的 `ℹ pass 6` 无法解析，见 regress 用例）。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
  statSync,
} = require('node:fs');
const { join, resolve, sep } = require('node:path');
const { pathToFileURL } = require('node:url');
const { tmpdir } = require('node:os');

// dist CLI 入口 / 工作区根 —— 相对本文件（tests/acceptance/v2-sign-review-fix/）
// 向上三级到仓库根，再进 dist/。
const CLI_SCRIPT = resolve(__dirname, '..', '..', '..', 'dist', 'cli', 'index.js');
const ROOT = resolve(__dirname, '..', '..', '..');

// evaluate 纯函数：dist-test/（pnpm test 重建）优先，dist/（pnpm build）兜底。
const EVALUATE_MODULE = [
  join(ROOT, 'dist-test', 'src', 'core', 'sign-review', 'evaluate.js'),
  join(ROOT, 'dist', 'core', 'sign-review', 'evaluate.js'),
].find((p) => existsSync(p));
if (!EVALUATE_MODULE) {
  throw new Error('找不到 evaluate 编译产物（dist-test/ 或 dist/）—— 请先运行 `pnpm test` 或 `pnpm build`');
}
const { evaluateSignChecks } = require(EVALUATE_MODULE);

let sandbox;

// ─── 夹具 ────────────────────────────────────────────────────────────────────
//
// fix-slice：镜像 v1-sign-review-cli 的真实事件流。16:50 有一次写集越界
// （violations 原样：evaluate.ts / types.ts 不在写集内），之后写集扩大、
// 门禁重跑，17:30 的最新 gate.result 通过 —— 越界已解决。acceptance 是
// skipped（项目没配 gate.acceptance 段），真正跑过的验收在 results 里的
// acceptance-cli（TAP 汇总 # pass 6）。
const FIX_SLICE = {
  id: 'fix-slice',
  title: 'Fix slice',
  state: 'completed',
  spec: { path: 'specs/slices/fix-slice.md', frozenHash: 'sha256:abc', frozenAt: '2026-11-13T09:42:05.812Z' },
  acceptance: { dir: 'tests/acceptance/fix-slice/', frozenHash: null, oracleSrc: null },
  baseCommit: null,
  drift: { detected: false, reason: null, at: null },
  trace: {
    requirements: ['req-1794561287258'],
    contracts: ['contracts/schemas/slice.json'],
    tests: ['tests/acceptance/fix-slice/acceptance.test.cjs'],
  },
  traceWaiver: null,
  baseline: false,
  writes: ['src/cli/sign-review/collect-facts.ts'],
  runs: [],
  clarifyRounds: 0,
  stall: { class: null, autoResolved: 0, gateRetries: 0 },
  createdAt: '2026-11-13T09:00:00.000Z',
  updatedAt: '2026-11-13T17:30:57.000Z',
};

const FIX_EVENTS = [
  {
    ts: '2026-11-13T16:50:45.722Z',
    runSeq: 201,
    slice: 'fix-slice',
    run: null,
    type: 'policy.violation',
    actor: 'zelto',
    payload: {
      sliceId: 'fix-slice',
      kind: 'write-outside-write-set',
      violations: ['src/core/sign-review/evaluate.ts', 'src/core/sign-review/types.ts'],
      tampered: [],
      changed: ['src/cli/sign-review/collect-facts.ts', 'src/cli/sign-review/render.ts'],
    },
  },
  {
    ts: '2026-11-13T17:30:56.624Z',
    runSeq: 337,
    slice: 'fix-slice',
    run: null,
    type: 'gate.result',
    actor: 'zelto',
    payload: {
      sliceId: 'fix-slice',
      passed: true,
      results: [
        { command: 'build', passed: true, exitCode: 0, durationMs: 1068, stderr: null, stdout: '\n> zelto@0.5.0 build\n> tsc\n\n' },
        { command: 'build-tests', passed: true, exitCode: 0, durationMs: 1654, stderr: null, stdout: null },
        { command: 'acceptance-cli', passed: true, exitCode: 0, durationMs: 1899, stderr: null, stdout: '# tests 6\n# suites 0\n# pass 6\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# \n' },
      ],
      retryCount: 0,
      totalDurationMs: 4625,
      acceptance: {
        status: 'skipped',
        path: null,
        command: null,
        reason: '未配置切片级验收（config.yaml 的 gate.acceptance 段）',
        exitCode: null,
        durationMs: 0,
      },
    },
  },
];

// missing-slice：gate.result 连 acceptance 字段都没有 —— 回退路径的「缺失」分支。
// results 里只有一条命令名恰为 `acceptance`（名字含 acceptance，同样命中回退）。
const MISSING_SLICE = {
  id: 'missing-slice',
  title: 'Missing acceptance slice',
  state: 'completed',
  spec: { path: 'specs/slices/missing-slice.md', frozenHash: 'sha256:abc', frozenAt: '2026-11-13T09:00:00.000Z' },
  acceptance: { dir: 'tests/acceptance/missing-slice/', frozenHash: null, oracleSrc: null },
  baseCommit: null,
  drift: { detected: false, reason: null, at: null },
  trace: {
    requirements: ['req-1'],
    contracts: ['contracts/schemas/slice.json'],
    tests: ['tests/acceptance/missing-slice/acceptance.test.cjs'],
  },
  traceWaiver: null,
  baseline: false,
  writes: ['src/cli/sign-review/collect-facts.ts'],
  runs: [],
  clarifyRounds: 0,
  stall: { class: null, autoResolved: 0, gateRetries: 0 },
  createdAt: '2026-11-13T09:00:00.000Z',
  updatedAt: '2026-11-13T09:10:00.000Z',
};

const MISSING_EVENTS = [
  {
    ts: '2026-11-13T09:05:00.000Z',
    runSeq: 1,
    slice: 'missing-slice',
    run: null,
    type: 'gate.result',
    actor: 'zelto',
    payload: {
      sliceId: 'missing-slice',
      passed: true,
      results: [
        { command: 'acceptance', passed: true, exitCode: 0, durationMs: 500, stderr: null, stdout: '# pass 3\n# fail 0\n# todo 0\n# skipped 0\n' },
      ],
      retryCount: 0,
      totalDurationMs: 500,
    },
  },
];

// regress-slice：镜像 v1-sign-review-core 的真实事件流。core 片本身没有
// 切片级验收记录（acceptance 也是 skipped）；results 里的 acceptance-core
// 跑过且 exitCode 0，stdout 是 node spec 报告器（✔ / ℹ 行）。
// v2 落笔时 parseTestRunnerStats 只认 TAP（# pass），解析不出 pass>0 ——
// 回退不得误判，验收保持 FAIL。v3 起 `ℹ pass` 等价（见 v3 验收标准 3），
// 该 fixture 同样可解析出 pass>0（ℹ pass 5），于是判通过 —— 结论与证据一致，
// 不是静默翻转。该片没有任何 policy.violation 事件 → 写集审计为空。
const REG_SLICE = {
  id: 'regress-slice',
  title: 'Regress slice',
  state: 'completed',
  spec: { path: 'specs/slices/regress-slice.md', frozenHash: 'sha256:def', frozenAt: '2026-11-13T09:00:00.000Z' },
  acceptance: { dir: 'tests/acceptance/regress-slice/', frozenHash: null, oracleSrc: null },
  baseCommit: null,
  drift: { detected: false, reason: null, at: null },
  trace: {
    requirements: ['req-1'],
    contracts: ['contracts/schemas/slice.json'],
    tests: ['tests/acceptance/regress-slice/acceptance.test.cjs'],
  },
  traceWaiver: null,
  baseline: false,
  writes: ['src/core/sign-review/evaluate.ts'],
  runs: [],
  clarifyRounds: 0,
  stall: { class: null, autoResolved: 0, gateRetries: 0 },
  createdAt: '2026-11-13T09:00:00.000Z',
  updatedAt: '2026-11-13T16:36:29.000Z',
};

const REG_EVENTS = [
  {
    ts: '2026-11-13T16:36:28.864Z',
    runSeq: 164,
    slice: 'regress-slice',
    run: null,
    type: 'gate.result',
    actor: 'zelto',
    payload: {
      sliceId: 'regress-slice',
      passed: true,
      results: [
        { command: 'build', passed: true, exitCode: 0, durationMs: 2559, stderr: null, stdout: '\n> zelto@0.5.0 build\n> tsc\n\n' },
        { command: 'build-tests', passed: true, exitCode: 0, durationMs: 10516, stderr: null, stdout: null },
        {
          command: 'acceptance-core',
          passed: true,
          exitCode: 0,
          durationMs: 201,
          stderr: null,
          stdout: '✔ types.ts 定义并导出 SignReviewFacts 与 SignCheck (3.178ms)\n✔ evaluate.ts 导出纯函数 evaluateSignChecks（C3） (1.6894ms)\n✔ 四项确认项各有一条 ADR 锚点 (0.3775ms)\n✔ 产物证据为 unknown 时不谎报失败 (0.2926ms)\n✔ 阴性对照四种失败各一组断言 (0.7778ms)\nℹ tests 5\nℹ suites 0\nℹ pass 5\nℹ fail 0\nℹ skipped 0\nℹ \n',
        },
      ],
      retryCount: 0,
      totalDurationMs: 13282,
      acceptance: {
        status: 'skipped',
        path: null,
        command: null,
        reason: '未配置切片级验收（config.yaml 的 gate.acceptance 段）',
        exitCode: null,
        durationMs: 0,
      },
    },
  },
];

// stale-slice：负向控制 —— 越界之后**没有**通过的 gate.result 跟着
// （只有一条失败的门禁）。越界没被证明解决，旧结论必须保留（fail closed），
// 修复不得把 violations 无脑清空。
const STALE_SLICE = {
  id: 'stale-slice',
  title: 'Stale slice',
  state: 'completed',
  spec: { path: 'specs/slices/stale-slice.md', frozenHash: 'sha256:ghi', frozenAt: '2026-11-13T09:00:00.000Z' },
  acceptance: { dir: 'tests/acceptance/stale-slice/', frozenHash: null, oracleSrc: null },
  baseCommit: null,
  drift: { detected: false, reason: null, at: null },
  trace: {
    requirements: ['req-1'],
    contracts: ['contracts/schemas/slice.json'],
    tests: ['tests/acceptance/stale-slice/acceptance.test.cjs'],
  },
  traceWaiver: null,
  baseline: false,
  writes: ['src/a.ts'],
  runs: [],
  clarifyRounds: 0,
  stall: { class: null, autoResolved: 0, gateRetries: 0 },
  createdAt: '2026-11-13T09:00:00.000Z',
  updatedAt: '2026-11-13T10:05:01.000Z',
};

const STALE_EVENTS = [
  {
    ts: '2026-11-13T10:00:00.000Z',
    runSeq: 1,
    slice: 'stale-slice',
    run: null,
    type: 'policy.violation',
    actor: 'zelto',
    payload: {
      sliceId: 'stale-slice',
      kind: 'write-outside-write-set',
      violations: ['src/evil.ts'],
      tampered: [],
      changed: ['src/a.ts'],
    },
  },
  {
    ts: '2026-11-13T10:05:00.000Z',
    runSeq: 2,
    slice: 'stale-slice',
    run: null,
    type: 'gate.result',
    actor: 'zelto',
    payload: {
      sliceId: 'stale-slice',
      passed: false,
      results: [{ command: 'test', passed: false, exitCode: 1, durationMs: 100, stderr: 'boom', stdout: null }],
      retryCount: 0,
      totalDurationMs: 100,
      acceptance: { status: 'skipped', path: null, command: null, reason: '未配置切片级验收', exitCode: null, durationMs: 0 },
    },
  },
];

function writeSlice(slice) {
  writeFileSync(join(sandbox, '.zelto', 'slices', `${slice.id}.json`), JSON.stringify(slice, null, 2), 'utf-8');
}

function writeEvents(sliceId, events) {
  const dir = join(sandbox, '.zelto', 'events', sliceId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
}

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'zelto-sign-review-fix-'));
  mkdirSync(join(sandbox, '.zelto', 'slices'), { recursive: true });
  mkdirSync(join(sandbox, '.zelto', 'events'), { recursive: true });
  writeSlice(FIX_SLICE);
  writeEvents('fix-slice', FIX_EVENTS);
  writeSlice(MISSING_SLICE);
  writeEvents('missing-slice', MISSING_EVENTS);
  writeSlice(REG_SLICE);
  writeEvents('regress-slice', REG_EVENTS);
  writeSlice(STALE_SLICE);
  writeEvents('stale-slice', STALE_EVENTS);
});

after(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

// 跑 CLI 子进程（管道 stdio → 非 TTY），返回 { status, stdout, stderr }。
function runCLI(args, { cwd, timeoutMs } = {}) {
  const res = spawnSync(process.execPath, [CLI_SCRIPT, ...args], {
    cwd: cwd ?? sandbox,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
  });
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    error: res.error,
    signal: res.signal,
  };
}

/** 动态 import dist 里的 collectSignReviewFacts（ESM 产物，cjs 里用 await import）。 */
async function collectFactsFor(sliceId) {
  const collectFactsPath = join(ROOT, 'dist', 'cli', 'sign-review', 'collect-facts.js');
  const mod = await import(pathToFileURL(collectFactsPath).href);
  const previousCwd = process.cwd();
  try {
    process.chdir(sandbox); // store / events 按 cwd 解析
    return await mod.collectSignReviewFacts(sliceId);
  } finally {
    process.chdir(previousCwd);
  }
}

/** 按 label 取确认项，便于断言「只坏一项、其余仍通过」。 */
function byLabel(checks) {
  return Object.fromEntries(checks.map((c) => [c.label, c]));
}

// ─── 验收标准 1 + 2：写集陈旧消解 + 验收项回退识别（fix-slice）────────────

test('fix-slice: stale cleared, 6/6', async () => {
  const facts = await collectFactsFor('fix-slice');

  // 验收标准 1：最新 passed gate（17:30）晚于最新 violation（16:50）→ 越界已解决
  assert.deepEqual(facts.writeSetAudit.violations, [], '越界在扩写集/重跑后已通过 gate，violations 应为空');

  // 验收标准 2：acceptance.status=skipped → 回退 results[] 里名字含 acceptance 的命令
  assert.equal(facts.gate.acceptanceRan, true, '回退应判 acceptanceRan=true');
  assert.equal(facts.gate.acceptancePassed, true, '回退应判 acceptancePassed=true');
  assert.equal(facts.gate.passCount, 6, 'pass 应从 acceptance-cli 的 stdout 解析出 6');
  assert.equal(facts.gate.totalCount, 6, 'total 应为 pass+fail+todo+skipped = 6');

  const checks = evaluateSignChecks(facts);
  assert.equal(checks.length, 4);
  const by = byLabel(checks);
  assert.equal(by['验收真跑过本片'].ok, true, '验收项应为 ok');
  assert.equal(by['改动在写集内'].ok, true, '写集项应为 ok');
});

// ─── 验收标准 2 的「缺失」分支：连 acceptance 字段都没有 ──────────────────────

test('missing-slice: no acceptance field, 3/3', async () => {
  const facts = await collectFactsFor('missing-slice');

  assert.deepEqual(facts.writeSetAudit.violations, [], '无 violation 事件 → 空清单');
  assert.equal(facts.gate.acceptanceRan, true, '缺失分支应回退且判 ran=true');
  assert.equal(facts.gate.acceptancePassed, true, '缺失分支应判 passed=true');
  assert.equal(facts.gate.passCount, 3);
  assert.equal(facts.gate.totalCount, 3);

  const by = byLabel(evaluateSignChecks(facts));
  assert.equal(by['验收真跑过本片'].ok, true, '验收项应为 ok');
  assert.equal(by['改动在写集内'].ok, true, '写集项应为 ok（空清单）');
});

// ─── 验收标准 3 回归（v3 起更新）：v1-sign-review-core 同样有可解析的验收证据 ──

test('regress-slice: ℹ pass 5 → pass', async () => {
  const facts = await collectFactsFor('regress-slice');

  // v3 起 `ℹ pass` 与 `# pass` 等价：core 片的 acceptance-core stdout 含
  // `ℹ pass 5`，回退能解析出 pass>0 → 判 ran/passed（v3 验收标准 3 允许此翻转，
  // 其验收用例确实真跑了 5 条且全过）。不是静默翻转 —— v3 注释已说明。
  assert.equal(facts.gate.acceptanceRan, true, 'core 片 acceptance-core 可解析出 pass>0，应判 ran=true');
  assert.equal(facts.gate.acceptancePassed, true);
  assert.equal(facts.gate.passCount, 5);
  assert.equal(facts.gate.totalCount, 5);

  // 无 violation 事件 → 空清单（验收标准 3）
  assert.deepEqual(facts.writeSetAudit.violations, [], '无 violation 事件的切片仍为空清单');

  const by = byLabel(evaluateSignChecks(facts));
  assert.equal(by['追溯链未断'].ok, true, '追溯 ok（trace 非空）');
  assert.equal(by['验收真跑过本片'].ok, true, '验收项判通过（有可解析的验收证据）');
  assert.equal(by['改动在写集内'].ok, true, '写集项 ok（空清单）');
});

// ─── 验收标准 1 的负向控制：越界没有被证明解决时不得清空 ─────────────────────

test('stale-slice: failed gate keeps violation', async () => {
  const facts = await collectFactsFor('stale-slice');

  assert.deepEqual(facts.writeSetAudit.violations, ['src/evil.ts'], '没有通过的 gate 跟着，越界记录必须保留（fail closed）');

  const by = byLabel(evaluateSignChecks(facts));
  assert.equal(by['改动在写集内'].ok, false, '写集项应 FAIL');
});

// ─── 验收标准 4：--json 可 parse；只读性与非 TTY 不变 ───────────────────────

test('json fix-slice: parseable, 6/6', () => {
  const res = runCLI(['sign', 'fix-slice', '--review', '--json'], { cwd: sandbox });
  assert.equal(res.error, undefined, `CLI 启动失败：${res.error}`);
  assert.equal(res.status, 0, `--json 应退出 0，实际 ${res.status}：\n${res.stdout}${res.stderr}`);

  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(res.stdout); }, '--json 输出应能被 JSON.parse 解析');

  assert.ok(parsed.facts, '--json 应含 facts 段');
  assert.equal(parsed.facts.sliceId, 'fix-slice');
  assert.deepEqual(parsed.facts.writeSetAudit.violations, [], 'facts 里写集审计应为空');
  assert.equal(parsed.facts.gate.passCount, 6);
  assert.equal(parsed.facts.gate.totalCount, 6);

  assert.ok(Array.isArray(parsed.checks), '--json 应含 checks 段');
  assert.equal(parsed.checks.length, 4, '应有四项签字前确认项');
  const by = byLabel(parsed.checks);
  assert.equal(by['验收真跑过本片'].ok, true, '验收项应为 ok');
  assert.equal(by['改动在写集内'].ok, true, '写集项应为 ok');
});

test('json regress-slice: pass kept', () => {
  const res = runCLI(['sign', 'regress-slice', '--review', '--json'], { cwd: sandbox });
  assert.equal(res.error, undefined, `CLI 启动失败：${res.error}`);
  assert.equal(res.status, 0, `--json 应退出 0，实际 ${res.status}：\n${res.stdout}${res.stderr}`);

  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(res.stdout); }, '--json 输出应能被 JSON.parse 解析');
  assert.deepEqual(parsed.facts.writeSetAudit.violations, [], 'core 片写集审计为空');

  const by = byLabel(parsed.checks);
  assert.equal(by['验收真跑过本片'].ok, true, 'core 片 acceptance-core 可解析出 pass>0，验收项判通过（v3 起）');
  assert.equal(by['改动在写集内'].ok, true, '写集项 ok');
});

test('非 TTY 不挂死', () => {
  // spawnSync + 8s 超时：stdin/stdout/stderr 全走管道（非 TTY）。
  // 若实现里去等人输入，进程会卡到超时被 kill → res.error / res.signal 非空 → 断言失败。
  const res = runCLI(['sign', 'fix-slice', '--review'], { cwd: sandbox, timeoutMs: 8000 });
  assert.equal(res.error, undefined, `进程卡死或启动失败（超时会被 kill 并置 error）：${res.error}`);
  assert.equal(res.signal, null, `进程被信号终止（疑似挂死等待输入）：${res.signal}`);
  assert.equal(res.status, 0, `非 TTY 下 --review 应直接退出 0，实际 ${res.status}：\n${res.stdout}${res.stderr}`);
  assert.ok(res.stdout.includes('签字前请确认四件事'), '非 TTY 下也应打印复查内容');
  assert.ok(res.stdout.includes('验收（门禁②）'), '输出应含验收段');
});

test('只读性：不写文件不追加事件', () => {
  function snapshotDir(dir) {
    const out = {};
    function walk(d, rel) {
      for (const entry of readdirSync(d)) {
        const p = join(d, entry);
        const relP = rel ? `${rel}${sep}${entry}` : entry;
        if (statSync(p).isDirectory()) {
          walk(p, relP);
        } else {
          out[relP] = readFileSync(p, 'utf-8');
        }
      }
    }
    if (!existsSync(dir)) return out;
    walk(dir, '');
    return out;
  }

  const slicesDir = join(sandbox, '.zelto', 'slices');
  const eventsDir = join(sandbox, '.zelto', 'events');

  const beforeSlices = snapshotDir(slicesDir);
  const beforeEvents = snapshotDir(eventsDir);

  const res = runCLI(['sign', 'fix-slice', '--review'], { cwd: sandbox });
  assert.equal(res.status, 0, `--review 应退出 0，实际 ${res.status}：\n${res.stdout}${res.stderr}`);

  assert.deepEqual(snapshotDir(slicesDir), beforeSlices, '.zelto/slices 在 --review 后不应有任何新增/修改');
  assert.deepEqual(snapshotDir(eventsDir), beforeEvents, '.zelto/events 在 --review 后不应有任何新增/追加');
});
