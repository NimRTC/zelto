// 验收测试 —— `zelto sign --review`（切片 v1-sign-review-cli，ADR-070 §5）
//
// 每条验收标准一条用例，全部跑真实 CLI 进程（dist/cli/index.js）或动态
// import dist 产物，不做 mock 的自我满足。门禁②会识别「没有一条用例真正
// 跑起来」的验收文件并判 failed —— 这里没有 todo / skip，全是真断言。
//
// 沙箱：每条用例都在 os.tmpdir() 下临时目录里造一片切片 + 事件流，
// 以该目录为 cwd 跑 CLI —— 与其它 acceptance 测试（sign.test.ts 等）同一做法。
// 改这块文件不会影响规格 —— 规格在 specs/slices/ 下，两者各自独立。
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

// dist CLI 入口 —— 相对本文件（tests/acceptance/v1-sign-review-cli/）
// 向上三级到仓库根，再进 dist/。
const CLI_SCRIPT = resolve(__dirname, '..', '..', '..', 'dist', 'cli', 'index.js');

let sandbox;

// ─── 沙箱夹具 ────────────────────────────────────────────────────────────────
//
// demo-slice：一片「已经走完流程」的切片。trace 三线齐全、acceptance 跑过、
// 花过钱、停过一次机、有一次写集越界记录 —— 覆盖 collect-facts 要过滤的
// gate.result / budget.spent / stall.classified / policy.violation 四类事件，
// 也覆盖 render 的六段。
const DEMO_SLICE = {
  id: 'demo-slice',
  title: 'Demo slice',
  state: 'completed',
  spec: { path: 'specs/slices/demo-slice.md', frozenHash: 'sha256:abc', frozenAt: '2026-01-01T00:00:00.000Z' },
  acceptance: { dir: 'tests/acceptance/demo-slice/', frozenHash: null, oracleSrc: null },
  baseCommit: null,
  drift: { detected: false, reason: null, at: null },
  trace: {
    requirements: ['req-1794561287258'],
    contracts: ['contract-1'],
    tests: ['test-1'],
  },
  traceWaiver: null,
  baseline: false,
  writes: ['src/demo.ts'],
  runs: [],
  clarifyRounds: 0,
  stall: { class: null, autoResolved: 0, gateRetries: 0 },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const DEMO_EVENTS = [
  { ts: '2026-01-01T00:00:00.000Z', runSeq: 1, slice: 'demo-slice', run: null, type: 'budget.spent', actor: 'cli', payload: { amount: 0.0012 } },
  { ts: '2026-01-01T00:00:00.001Z', runSeq: 2, slice: 'demo-slice', run: null, type: 'stall.classified', actor: 'human', payload: { sliceId: 'demo-slice', class: 'human_halt', reason: 'needs human' } },
  { ts: '2026-01-01T00:00:00.002Z', runSeq: 3, slice: 'demo-slice', run: null, type: 'gate.result', actor: 'zelto', payload: { sliceId: 'demo-slice', passed: true, results: [{ command: 'acceptance', passed: true, exitCode: 0, stdout: '# pass 5\n# fail 0\n# todo 0\n# skipped 0\n' }], acceptance: { status: 'passed', path: 'tests/acceptance/demo-slice/', command: 'node --test tests/acceptance/demo-slice/' } } },
  // 越界记录放在**门禁通过之后** ——
  //
  // 「陈旧结论消解」（ADR-072，2026-11-16 加入）判据：
  // 最新一条 passed=true 的 gate.result **晚于**最新一条 policy.violation
  // → 越界已被「扩写集/重跑门禁」解决 → violations 清空。
  //
  // 原夹具把 violation 放在 gate.result **之前**（runSeq 3 / ts .002，
  // gate.result 是 runSeq 4 / ts .003）—— 那正是「越界已被解决」的样子，
  // 于是 violations 被清空，「改动在写集内」判过。
  //
  // 但这个夹具的**意图**是「有一处越界写入」—— 所以越界必须是**最新**的结论。
  // 把 violation 挪到门禁之后，夹具才真的表达它的意图。
  { ts: '2026-01-01T00:00:00.004Z', runSeq: 5, slice: 'demo-slice', run: null, type: 'policy.violation', actor: 'zelto', payload: { sliceId: 'demo-slice', kind: 'write-outside-write-set', violations: ['src/out-of-writeset.ts'] } },
];

// approve-slice：给 `--approve` 回归用的独立切片 —— 不跟 demo-slice 抢事件流，
// 免得只读性快照（见下方用例）被签字动作污染。
//
// ── 追溯与验收记录为什么必须有 ──────────────────────────────────────────
//
// `--approve` 现在要过**签字前确认闸门**（D-48，2026-11-17 接进）。
// 四项确认：追溯链未断 / 验收真跑过本片 / 改动在写集内 / 产物真落地。
//
// 闸门是**对的** —— 它拦的是「什么都没验证过就签字」。
// 所以这个夹具必须**长得像一片真的通过了闸门的切片**，
// 否则 `--approve` 被拦是**闸门正常工作**，不是被测功能坏了。
//
// （这个夹具写于 2026-11-14，闸门是 11-17 才接进的 ——
//  夹具落后于产品，闸门一上线它就必然红。
//  「测试夹具落后于产品」与「产品有缺陷」要分清：
//  这里**产品是对的**，该改的是夹具。）
const APPROVE_SLICE = {
  id: 'approve-slice',
  title: 'Approve slice',
  state: 'completed',
  spec: { path: 'specs/slices/approve-slice.md', frozenHash: 'sha256:def', frozenAt: '2026-01-01T00:00:00.000Z' },
  acceptance: { dir: 'tests/acceptance/approve-slice/', frozenHash: null, oracleSrc: null },
  baseCommit: null,
  drift: { detected: false, reason: null, at: null },
  // 追溯三条都要非空 —— 否则「追溯链未断」这项必然不过
  trace: { requirements: ['req-approve-1'], contracts: ['contract-approve-1'], tests: ['test-approve-1'] },
  traceWaiver: null,
  baseline: false,
  writes: [],
  runs: [],
  clarifyRounds: 0,
  stall: { class: null, autoResolved: 0, gateRetries: 0 },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

// approve-slice 的事件流 —— 只放让四项确认过得去的最小集：
// 一条 gate.result（带 acceptance 记录）。
// 「产物真落地」默认被签字路径豁免（产物要合并后才进主干，属合并阶段的确认），
// 所以这里不需要产物证据。
const APPROVE_EVENTS = [
  { ts: '2026-01-01T00:00:01.000Z', runSeq: 1, slice: 'approve-slice', run: null, type: 'gate.result', actor: 'zelto', payload: { sliceId: 'approve-slice', passed: true, results: [{ command: 'acceptance', passed: true, exitCode: 0, stdout: '# pass 3\n# fail 0\n' }], acceptance: { status: 'passed', path: 'tests/acceptance/approve-slice/', command: 'node --test tests/acceptance/approve-slice/' } } },
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
  sandbox = mkdtempSync(join(tmpdir(), 'zelto-sign-review-'));
  mkdirSync(join(sandbox, '.zelto', 'slices'), { recursive: true });
  mkdirSync(join(sandbox, '.zelto', 'events'), { recursive: true });
  writeSlice(DEMO_SLICE);
  writeEvents('demo-slice', DEMO_EVENTS);
  writeSlice(APPROVE_SLICE);
  writeEvents('approve-slice', APPROVE_EVENTS);
});

after(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

// 跑 CLI 子进程（管道 stdio → 非 TTY），返回 { status, stdout, stderr }。
// timeoutMs 不传 = 不做超时保护。
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

// ─── 1. collectSignReviewFacts ───────────────────────────────────────────────

test('collect-facts.ts 的 collectSignReviewFacts 读切片/事件/git，返回 trace/gate/diff/artifact 四段且不抛错', async () => {
  const collectFactsPath = resolve(__dirname, '..', '..', '..', 'dist', 'cli', 'sign-review', 'collect-facts.js');
  const mod = await import(pathToFileURL(collectFactsPath).href);
  assert.equal(typeof mod.collectSignReviewFacts, 'function', 'collect-facts.ts 必须导出 collectSignReviewFacts');

  const previousCwd = process.cwd();
  try {
    // 沙箱是 CLI 事实收集的唯一 cwd —— 模块里的 store/events 都按 cwd 解析。
    process.chdir(sandbox);
    const facts = await mod.collectSignReviewFacts('demo-slice');

    // 四段都齐、且不抛错（上面能走到这里就已经不抛了）
    assert.equal(facts.sliceId, 'demo-slice');
    assert.equal(facts.sliceState, 'completed');
    assert.deepEqual(facts.trace.requirements, ['req-1794561287258']);
    assert.deepEqual(facts.trace.contracts, ['contract-1']);
    assert.deepEqual(facts.trace.tests, ['test-1']);

    // gate 段：从 gate.result 事件取 acceptance 是否跑过 + pass/total
    assert.equal(facts.gate.acceptanceRan, true);
    assert.equal(facts.gate.acceptancePassed, true);
    assert.equal(facts.gate.passCount, 5);
    assert.equal(facts.gate.totalCount, 5);

    // diff 段：沙箱不是 git 仓库 → 查不到按 0 处理（风险：git 失败不抛错）
    assert.equal(typeof facts.diff.filesChanged, 'number');
    assert.equal(typeof facts.diff.addedLines, 'number');
    assert.equal(typeof facts.diff.deletedLines, 'number');
    assert.equal(facts.diff.filesChanged, 0);
    assert.equal(facts.diff.addedLines, 0);
    assert.equal(facts.diff.deletedLines, 0);

    // cost / stall / writeSetAudit：事件过滤逐类生效
    assert.equal(facts.cost.totalUsd, 0.0012);
    assert.equal(facts.stall.stalled, true);
    assert.equal(facts.stall.stallClass, 'human_halt');
    assert.deepEqual(facts.writeSetAudit.violations, ['src/out-of-writeset.ts']);

    // artifact 段：非 git 仓库 HEAD 读不到 → 退为 unknown（风险段要求）
    assert.equal(facts.artifact.status, 'unknown');

    // 编译（tsc）由门禁自己的 build / build-tests 步骤覆盖 ——
    // 这里能 import 到编译产物本身就已证明 tsc 成功。
  } finally {
    process.chdir(previousCwd);
  }
});

// ─── 2. renderSignReview ─────────────────────────────────────────────────────

test('render.ts 的 renderSignReview 是纯函数：六段 + 签字≠合并行，单屏不超 24 行', async () => {
  const renderPath = resolve(__dirname, '..', '..', '..', 'dist', 'cli', 'sign-review', 'render.js');
  const { renderSignReview } = await import(pathToFileURL(renderPath).href);
  assert.equal(typeof renderSignReview, 'function');

  const checks = [
    { label: '追溯链未断', ok: true, evidence: '需求/契约/测试三条追溯均非空', adrRef: 'ADR-060/032' },
    { label: '验收真跑过本片', ok: true, evidence: 'acceptance 通过（5/5）', adrRef: 'ADR-033/051' },
    { label: '改动在写集内', ok: true, evidence: '写集审计无越界写入', adrRef: 'ADR-014' },
    { label: '产物真落地', ok: true, evidence: '产物已在主干找到', adrRef: 'ADR-059/061' },
  ];
  const facts = {
    sliceId: 'demo-slice',
    sliceState: 'completed',
    trace: { requirements: ['req-1'], contracts: ['ctr-1'], tests: ['test-1'] },
    gate: { acceptanceRan: true, acceptancePassed: true, passCount: 5, totalCount: 5 },
    diff: {
      baseRef: 'abc1234',
      baseNote: '切片冻结时的基点 abc1234',
      filesChanged: 1,
      addedLines: 5,
      deletedLines: 2,
      files: [],
    },
    cost: { totalUsd: 1.23 },
    stall: { stalled: false, stallClass: null },
    writeSetAudit: { violations: [] },
    artifact: { status: 'in-trunk', path: 'src/demo.ts', hash: null, note: null },
  };

  // 默认 80x24 视口；不做 IO（直接调用、只吃入参）
  const output = renderSignReview(checks, facts);

  // 六段标题
  assert.ok(output.includes('追溯链'), '缺「追溯链」段');
  assert.ok(output.includes('验收（门禁②）'), '缺「验收」段');
  assert.ok(output.includes('改动'), '缺「改动」段');
  assert.ok(output.includes('成本'), '缺「成本」段');
  assert.ok(output.includes('停机'), '缺「停机」段');
  assert.ok(output.includes('签字前请确认四件事'), '缺「四项确认项」段');

  // 签字 ≠ 合并提示行（ADR-018 锚点）
  assert.ok(output.includes('签字不等于合并'), '缺 ADR-018 的「签字≠合并」提示行');

  // 单屏：默认视口下行数不超过 24
  const lineCount = output.split('\n').length;
  assert.ok(lineCount <= 24, `默认视口下应一屏铺开（≤24 行），实际 ${lineCount} 行`);

  // 四项确认项各渲染成一行
  for (const check of checks) {
    assert.ok(output.includes(check.label), `缺确认项「${check.label}」`);
  }
});

// ─── 3. runSignReview 编排 + --review 分流 + --approve 回归 ───────────────────

test('sign-review.ts 编排：sign --review 输出六段退出 0；--approve 路径回归不受影响', async () => {
  const review = runCLI(['sign', 'demo-slice', '--review'], { cwd: sandbox });
  assert.equal(review.error, undefined, `CLI 启动失败：${review.error}`);
  assert.equal(review.status, 0, `--review 应退出 0，实际 ${review.status}：\n${review.stdout}${review.stderr}`);

  for (const section of ['追溯链', '验收（门禁②）', '改动', '成本', '停机', '签字前请确认四件事']) {
    assert.ok(review.stdout.includes(section), `--review 输出缺「${section}」段`);
  }

  // --approve 路径回归：原有行为不变 —— 自动发起再批准，输出 Approved
  const approve = runCLI(['sign', 'approve-slice', '--approve'], { cwd: sandbox });
  assert.equal(approve.error, undefined, `CLI 启动失败：${approve.error}`);
  assert.equal(approve.status, 0, `--approve 应退出 0，实际 ${approve.status}：\n${approve.stdout}${approve.stderr}`);
  assert.ok(approve.stdout.includes('Approved'), `--approve 应输出 Approved，实际：${approve.stdout}`);
});

// ─── 4. 非 TTY 不挂死 ────────────────────────────────────────────────────────

test('非 TTY 不挂死：管道/重定向下只打印、不提示确认', () => {
  // spawnSync + 8s 超时：stdin/stdout/stderr 全走管道（非 TTY）。
  // 若实现里去等人输入，进程会卡到超时被 kill → res.error / res.signal 非空 → 断言失败。
  const res = runCLI(['sign', 'demo-slice', '--review'], { cwd: sandbox, timeoutMs: 8000 });
  assert.equal(res.error, undefined, `进程卡死或启动失败（超时会被 kill 并置 error）：${res.error}`);
  assert.equal(res.signal, null, `进程被信号终止（疑似挂死等待输入）：${res.signal}`);
  assert.equal(res.status, 0, `非 TTY 下 --review 应直接退出 0，实际 ${res.status}：\n${res.stdout}${res.stderr}`);
  assert.ok(res.stdout.includes('签字前请确认四件事'), '非 TTY 下也应打印复查内容');
});

// ─── 5. 只读性 ───────────────────────────────────────────────────────────────

test('只读性：--review 不写 .zelto/slices 与 .zelto/events 下任何文件、不追加任何事件', () => {
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

  const res = runCLI(['sign', 'demo-slice', '--review'], { cwd: sandbox });
  assert.equal(res.status, 0, `--review 应退出 0，实际 ${res.status}：\n${res.stdout}${res.stderr}`);

  assert.deepEqual(snapshotDir(slicesDir), beforeSlices, '.zelto/slices 在 --review 后不应有任何新增/修改');
  assert.deepEqual(snapshotDir(eventsDir), beforeEvents, '.zelto/events 在 --review 后不应有任何新增/追加');
});

// ─── 6. --json 结构化输出 ────────────────────────────────────────────────────

test('--json 输出结构化 SignReview（facts + checks），可被 JSON.parse 解析', () => {
  const res = runCLI(['sign', 'demo-slice', '--review', '--json'], { cwd: sandbox });
  assert.equal(res.error, undefined, `CLI 启动失败：${res.error}`);
  assert.equal(res.status, 0, `--json 应退出 0，实际 ${res.status}：\n${res.stdout}${res.stderr}`);

  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(res.stdout); }, '--json 输出应能被 JSON.parse 解析');

  assert.ok(parsed.facts, '--json 应含 facts 段');
  assert.equal(parsed.facts.sliceId, 'demo-slice');
  assert.ok(Array.isArray(parsed.checks), '--json 应含 checks 段');
  assert.equal(parsed.checks.length, 4, '应有四项签字前确认项');

  // 判定来自 core 层纯函数 —— 与终端文本同一份结构（ADR-070 §5.5）
  assert.equal(parsed.checks[0].label, '追溯链未断');
  assert.equal(parsed.checks[0].ok, true);
  assert.equal(parsed.checks[2].label, '改动在写集内');
  assert.equal(parsed.checks[2].ok, false); // 夹具里有 1 处越界写入
  assert.equal(parsed.facts.artifact.status, 'unknown'); // 非 git 沙箱 → unknown
});
