// 验收测试 —— `zelto sign --review` 第三轮修复（切片 v3-sign-review-acceptance-spec）
//
// 修复 collectGateFacts 回退路径漏识别 Node spec 报告器输出的问题（v2 修复后残留）：
//   - v2 回退只认 TAP 汇总行（`# pass N`，parseTestRunnerStats 唯一能解析的形态）。
//   - 真实 gate.result 事件里 results[].stdout 是门禁存的**前 500 字符**
//     （executor 把 stdout 截到 500），内容是 Node spec 报告器形态
//     （`✔ … / ℹ tests 6 / ℹ pass 6 / ℹ fail 0 …`）—— 没有一行 `# pass`，
//     回退找不到 pass>0，验收项保持 FAIL。
//   - v3 让 parseTestRunnerStats 同时认 `#` 与 `ℹ` 前缀（语义等价，
//     `ℹ`/`#` 前缀等价，其余语义与 parseTestRunnerStats 一致）。
//
// 本文件是 CommonJS（.cjs），直接由 node --test 执行：
//   node --test tests/acceptance/v3-sign-review-acceptance-spec/acceptance.test.cjs
//
// 被测的是 dist/dist-test 产物（先跑 pnpm build / pnpm test）。collect-facts
// 是 CLI 层（唯一允许读 .zelto / 跑 git 的模块），evaluate 是 core 层纯函数。
// 全部用例是真断言，无 todo / skip —— 门禁②会识别「没有一条用例真正跑起来」
// 的验收文件并判 failed。
//
// 夹具与 v1-sign-review-cli / v1-sign-review-core 的**真实事件流**对齐：
// 越界事件与 gate.result 事件从真实 events.jsonl 摘录（时间戳、命令名、
// acceptance 状态原样保留）；acceptance-cli / acceptance-core 的 stdout 保留
// 真实 spec 报告器形态（`✔ / ℹ`），**不再归一成 TAP** —— 这正是本片要修的
// 回退识别问题。
//
// 沙箱是临时 git 仓库：写集文件已提交进 HEAD —— 产物证据可判 in-trunk，
// 验收标准 2 的「第四项保持 ok」才有依据。
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
const { join, resolve, dirname, sep } = require('node:path');
const { pathToFileURL } = require('node:url');
const { tmpdir } = require('node:os');

// dist CLI 入口 / 工作区根 —— 相对本文件（tests/acceptance/v3-sign-review-acceptance-spec/）
// 向上三级到仓库根，再进 dist/。
const CLI_SCRIPT = resolve(__dirname, '..', '..', '..', 'dist', 'cli', 'index.js');
const ROOT = resolve(__dirname, '..', '..', '..');

// acceptance 纯函数（parseTestRunnerStats）：dist-test/（pnpm test 重建）优先，
// dist/（pnpm build）兜底。
const ACCEPTANCE_MODULE = [
  join(ROOT, 'dist-test', 'src', 'core', 'gate', 'acceptance.js'),
  join(ROOT, 'dist', 'core', 'gate', 'acceptance.js'),
].find((p) => existsSync(p));
if (!ACCEPTANCE_MODULE) {
  throw new Error('找不到 acceptance 编译产物（dist-test/ 或 dist/）—— 请先运行 `pnpm test` 或 `pnpm build`');
}
const { parseTestRunnerStats } = require(ACCEPTANCE_MODULE);

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
// 真实 spec 报告器形态的 stdout（Node spec reporter，gate.result 里被截到前
// 500 字符）—— 没有 `# pass` 行，只有 `✔` 测试行与 `ℹ` 汇总行。
const CLI_ACC_STDOUT = [
  '✔ 命令注册与四段输出 (2.1ms)',
  '✔ --review 六段渲染 (1.3ms)',
  '✔ --approve 只改状态不合并 (0.9ms)',
  '✔ 非 TTY 不挂死 (1.6ms)',
  '✔ 只读性快照不变 (2.2ms)',
  '✔ --json 可 parse (1.4ms)',
  'ℹ tests 6',
  'ℹ suites 0',
  'ℹ pass 6',
  'ℹ fail 0',
  'ℹ cancelled 0',
  'ℹ skipped 0',
  'ℹ todo 0',
  'ℹ ',
  '',
].join('\n');

// cli-slice：镜像 v1-sign-review-cli 的真实事件流。16:50 有一次写集越界
// （violations 原样：evaluate.ts / types.ts 不在写集内），之后写集扩大、
// 门禁重跑，17:30 的最新 gate.result 通过 —— 越界已解决。acceptance 是
// skipped（项目没配 gate.acceptance 段），真正跑过的验收在 results 里的
// acceptance-cli，stdout 是真实 spec 报告器形态（ℹ pass 6）。
const CLI_SLICE = {
  id: 'cli-slice',
  title: 'v1-sign-review-cli mirror',
  state: 'completed',
  spec: { path: 'specs/slices/cli-slice.md', frozenHash: 'sha256:abc', frozenAt: '2026-11-13T09:42:05.812Z' },
  acceptance: { dir: 'tests/acceptance/cli-slice/', frozenHash: null, oracleSrc: null },
  baseCommit: null,
  drift: { detected: false, reason: null, at: null },
  trace: {
    requirements: ['req-1794561287258'],
    contracts: ['contracts/schemas/slice.json'],
    tests: ['tests/acceptance/cli-slice/acceptance.test.cjs'],
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

const CLI_EVENTS = [
  {
    ts: '2026-11-13T16:50:45.722Z',
    runSeq: 201,
    slice: 'cli-slice',
    run: null,
    type: 'policy.violation',
    actor: 'zelto',
    payload: {
      sliceId: 'cli-slice',
      kind: 'write-outside-write-set',
      violations: ['src/core/sign-review/evaluate.ts', 'src/core/sign-review/types.ts'],
      tampered: [],
      changed: ['src/cli/sign-review/collect-facts.ts', 'src/cli/sign-review/render.ts'],
    },
  },
  {
    ts: '2026-11-13T17:30:56.624Z',
    runSeq: 337,
    slice: 'cli-slice',
    run: null,
    type: 'gate.result',
    actor: 'zelto',
    payload: {
      sliceId: 'cli-slice',
      passed: true,
      results: [
        { command: 'build', passed: true, exitCode: 0, durationMs: 1068, stderr: null, stdout: '\n> zelto@0.5.0 build\n> tsc\n\n' },
        { command: 'build-tests', passed: true, exitCode: 0, durationMs: 1654, stderr: null, stdout: null },
        { command: 'acceptance-cli', passed: true, exitCode: 0, durationMs: 1899, stderr: null, stdout: CLI_ACC_STDOUT },
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

// core-slice：镜像 v1-sign-review-core 的真实事件流。core 片本身没有切片级
// 验收记录（acceptance 也是 skipped）；results 里的 acceptance-core 跑过且
// exitCode 0，stdout 是真实 spec 报告器形态（✔ / ℹ pass 5）。
// v2 时 `ℹ` 前缀解析不到 pass>0 → 验收保持 FAIL；v3 起 `ℹ pass 5` 可解析 →
// 该片同样判通过（其验收用例确实真跑了 5 条且全过 —— 与证据一致，不是
// 静默翻转，实现注释已说明）。该片没有任何 policy.violation 事件。
const CORE_ACC_STDOUT = [
  '✔ types.ts 定义并导出 SignReviewFacts 与 SignCheck (3.178ms)',
  '✔ evaluate.ts 导出纯函数 evaluateSignChecks（C3） (1.6894ms)',
  '✔ 四项确认项各有一条 ADR 锚点 (0.3775ms)',
  '✔ 产物证据为 unknown 时不谎报失败 (0.2926ms)',
  '✔ 阴性对照四种失败各一组断言 (0.7778ms)',
  'ℹ tests 5',
  'ℹ suites 0',
  'ℹ pass 5',
  'ℹ fail 0',
  'ℹ skipped 0',
  'ℹ ',
  '',
].join('\n');

const CORE_SLICE = {
  id: 'core-slice',
  title: 'v1-sign-review-core mirror',
  state: 'completed',
  spec: { path: 'specs/slices/core-slice.md', frozenHash: 'sha256:def', frozenAt: '2026-11-13T09:00:00.000Z' },
  acceptance: { dir: 'tests/acceptance/core-slice/', frozenHash: null, oracleSrc: null },
  baseCommit: null,
  drift: { detected: false, reason: null, at: null },
  trace: {
    requirements: ['req-1'],
    contracts: ['contracts/schemas/slice.json'],
    tests: ['tests/acceptance/core-slice/acceptance.test.cjs'],
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

const CORE_EVENTS = [
  {
    ts: '2026-11-13T16:36:28.864Z',
    runSeq: 164,
    slice: 'core-slice',
    run: null,
    type: 'gate.result',
    actor: 'zelto',
    payload: {
      sliceId: 'core-slice',
      passed: true,
      results: [
        { command: 'build', passed: true, exitCode: 0, durationMs: 2559, stderr: null, stdout: '\n> zelto@0.5.0 build\n> tsc\n\n' },
        { command: 'build-tests', passed: true, exitCode: 0, durationMs: 10516, stderr: null, stdout: null },
        { command: 'acceptance-core', passed: true, exitCode: 0, durationMs: 201, stderr: null, stdout: CORE_ACC_STDOUT },
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

function writeSlice(slice) {
  writeFileSync(join(sandbox, '.zelto', 'slices', `${slice.id}.json`), JSON.stringify(slice, null, 2), 'utf-8');
}

function writeEvents(sliceId, events) {
  const dir = join(sandbox, '.zelto', 'events', sliceId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
}

// 写集文件先落盘并提交进 HEAD —— 产物证据判 in-trunk，验收标准 2 的
// 「第四项保持 ok」与 CLI --json 里的产物项才有依据。
function initGitRepo(dir) {
  const git = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf-8' });
  const init = git(['init', '-q']);
  if (init.error || init.status !== 0) throw new Error(`git init 失败：${init.stderr || init.error}`);
  const add = git(['add', '-A']);
  if (add.status !== 0) throw new Error(`git add 失败：${add.stderr}`);
  const commit = git(['-c', 'user.email=zelto-test@local', '-c', 'user.name=zelto-test', 'commit', '-q', '-m', 'fixture']);
  if (commit.status !== 0) throw new Error(`git commit 失败：${commit.stderr}`);
}

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'zelto-sign-review-v3-'));
  // 写集文件（产物证据要在 HEAD 里能找到）
  for (const rel of ['src/cli/sign-review/collect-facts.ts', 'src/core/sign-review/evaluate.ts']) {
    const abs = join(sandbox, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, '// fixture\n', 'utf-8');
  }
  // 切片与事件流
  mkdirSync(join(sandbox, '.zelto', 'slices'), { recursive: true });
  mkdirSync(join(sandbox, '.zelto', 'events'), { recursive: true });
  writeSlice(CLI_SLICE);
  writeEvents('cli-slice', CLI_EVENTS);
  writeSlice(CORE_SLICE);
  writeEvents('core-slice', CORE_EVENTS);
  // 全部提交 → HEAD 含写集文件 → 产物证据 in-trunk；git diff HEAD 为空
  initGitRepo(sandbox);
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

// ─── 验收标准 1：parseTestRunnerStats 同时认 # 与 ℹ 前缀 ────────────────────

test('parseTestRunnerStats 读得出 spec 报告器汇总行（ℹ pass 6），原有 # pass 形态不变', () => {
  const spec = parseTestRunnerStats('✔ a (1ms)\nℹ tests 6\nℹ pass 6\nℹ fail 0\n');
  assert.equal(spec.known, true, 'spec 报告器形态应能读出统计');
  assert.equal(spec.pass, 6, 'ℹ pass 6 应解析出 pass=6');
  assert.equal(spec.fail, 0, 'ℹ fail 0 应解析出 fail=0');
  assert.equal(spec.todo, 0, '没有 ℹ todo 行 → todo 保持 0');
  assert.equal(spec.skipped, 0, '没有 ℹ skipped 行 → skipped 保持 0');

  // 回归：原有 TAP 形态（# pass N）保持不变 —— adr-034 的「读得出 TAP 汇总行」仍过
  const tap = parseTestRunnerStats('# pass 3\n# fail 0\n# todo 1\n# skipped 0\n');
  assert.equal(tap.known, true);
  assert.equal(tap.pass, 3);
  assert.equal(tap.fail, 0);
  assert.equal(tap.todo, 1);
  assert.equal(tap.skipped, 0);
});

test('parseTestRunnerStats 不误认测试行（✔/✖）与其它汇总键（tests/suites/cancelled），认不出仍 known:false', () => {
  // ✔ 开头的是用例结果行，不是汇总行；ℹ tests / ℹ suites / ℹ cancelled 是
  // 其它键，不是 pass/fail/todo/skipped —— 都不该计入统计
  const mixed = parseTestRunnerStats('✔ a (1ms)\n✖ b (2ms)\nℹ tests 6\nℹ suites 0\nℹ pass 6\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n');
  assert.equal(mixed.known, true);
  assert.equal(mixed.pass, 6);
  assert.equal(mixed.fail, 0);
  assert.equal(mixed.skipped, 0);

  // 完全没有可识别的汇总行 → known:false（不猜、不用正则硬凑结论）
  const unreadable = parseTestRunnerStats('随便一段输出\n没有数字\n');
  assert.equal(unreadable.known, false);
  assert.equal(unreadable.pass, 0);
});

// ─── 验收标准 2：v1-sign-review-cli 真实事件流 → 6/6，evaluate 二/三/四 ok ──

test('cli-slice（镜像 v1-sign-review-cli 真实流）：回退识别 spec 报告器 stdout → ran/passed 且 6/6；evaluate 第二、三、四项 ok', async () => {
  const facts = await collectFactsFor('cli-slice');

  // acceptance.status=skipped → 回退扫描 results[] 里名字含 acceptance 的命令
  assert.equal(facts.gate.acceptanceRan, true, '回退应判 acceptanceRan=true');
  assert.equal(facts.gate.acceptancePassed, true, '回退应判 acceptancePassed=true');
  assert.equal(facts.gate.passCount, 6, 'pass 应从 acceptance-cli 的 spec 报告器 stdout 解析出 6');
  assert.equal(facts.gate.totalCount, 6, 'total 应为 pass+fail+todo+skipped = 6');

  // 越界在扩写集/重跑后已通过 gate（17:30 > 16:50）→ violations 清空（v2 已修）
  assert.deepEqual(facts.writeSetAudit.violations, [], '越界在扩写集/重跑后已通过 gate，violations 应为空');

  const checks = evaluateSignChecks(facts);
  assert.equal(checks.length, 4);
  const by = byLabel(checks);
  assert.equal(by['验收真跑过本片'].ok, true, '第二项（验收）应为 ok');
  assert.equal(by['改动在写集内'].ok, true, '第三项（写集）应为 ok（v2 已修）');
  assert.equal(by['产物真落地'].ok, true, '第四项（产物）应为 ok（写集文件已在 HEAD）');
});

// ─── 验收标准 3：v1-sign-review-core 真实事件流 → 结论与证据一致 ─────────────

test('core-slice（镜像 v1-sign-review-core 真实流）：acceptance-core 含 ℹ pass 5 → 可解析出 pass>0，判通过（结论与证据一致，实现注释已说明）', async () => {
  const facts = await collectFactsFor('core-slice');

  // v2 时 `ℹ` 前缀解析不到 pass>0 → 验收保持 FAIL；v3 起可解析 → 该片同样
  // 判通过。这是「结论与证据一致」：其验收用例确实真跑了 5 条且全过，
  // 不是静默翻转 —— collect-facts.ts 的实现注释已说明这一点。
  assert.equal(facts.gate.acceptanceRan, true, 'core 片回退应判 ran=true');
  assert.equal(facts.gate.acceptancePassed, true, 'core 片回退应判 passed=true');
  assert.equal(facts.gate.passCount, 5, 'pass 应从 acceptance-core 的 ℹ pass 5 解析出 5');
  assert.equal(facts.gate.totalCount, 5, 'total 应为 pass+fail+todo+skipped = 5');

  // 无 violation 事件 → 空清单
  assert.deepEqual(facts.writeSetAudit.violations, [], '无 violation 事件的切片仍为空清单');

  const by = byLabel(evaluateSignChecks(facts));
  assert.equal(by['追溯链未断'].ok, true, '追溯 ok（trace 非空）');
  assert.equal(by['验收真跑过本片'].ok, true, '验收项 ok —— core 片同样有可解析的验收证据（ℹ pass 5）');
  assert.equal(by['改动在写集内'].ok, true, '写集项 ok（空清单）');
  assert.equal(by['产物真落地'].ok, true, '产物项 ok（写集文件已在 HEAD）');
});

// ─── 验收标准 4：--json 可 parse；非 TTY 与只读性不变；tsc --noEmit 退出 0 ──

test('sign cli-slice --review --json：可被 JSON.parse，facts.gate 6/6，验收/写集/产物三项 ok', () => {
  const res = runCLI(['sign', 'cli-slice', '--review', '--json'], { cwd: sandbox });
  assert.equal(res.error, undefined, `CLI 启动失败：${res.error}`);
  assert.equal(res.status, 0, `--json 应退出 0，实际 ${res.status}：\n${res.stdout}${res.stderr}`);

  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(res.stdout); }, '--json 输出应能被 JSON.parse 解析');

  assert.ok(parsed.facts, '--json 应含 facts 段');
  assert.equal(parsed.facts.sliceId, 'cli-slice');
  assert.equal(parsed.facts.gate.acceptanceRan, true);
  assert.equal(parsed.facts.gate.acceptancePassed, true);
  assert.equal(parsed.facts.gate.passCount, 6);
  assert.equal(parsed.facts.gate.totalCount, 6);

  assert.ok(Array.isArray(parsed.checks), '--json 应含 checks 段');
  assert.equal(parsed.checks.length, 4, '应有四项签字前确认项');
  const by = byLabel(parsed.checks);
  assert.equal(by['验收真跑过本片'].ok, true, '验收项应为 ok');
  assert.equal(by['改动在写集内'].ok, true, '写集项应为 ok');
  assert.equal(by['产物真落地'].ok, true, '产物项应为 ok（git 沙箱内写集文件在 HEAD）');
});

test('非 TTY 不挂死：管道/重定向下只打印、不提示确认', () => {
  // spawnSync + 8s 超时：stdin/stdout/stderr 全走管道（非 TTY）。
  // 若实现里去等人输入，进程会卡到超时被 kill → res.error / res.signal 非空 → 断言失败。
  const res = runCLI(['sign', 'cli-slice', '--review'], { cwd: sandbox, timeoutMs: 8000 });
  assert.equal(res.error, undefined, `进程卡死或启动失败（超时会被 kill 并置 error）：${res.error}`);
  assert.equal(res.signal, null, `进程被信号终止（疑似挂死等待输入）：${res.signal}`);
  assert.equal(res.status, 0, `非 TTY 下 --review 应直接退出 0，实际 ${res.status}：\n${res.stdout}${res.stderr}`);
  assert.ok(res.stdout.includes('签字前请确认四件事'), '非 TTY 下也应打印复查内容');
  assert.ok(res.stdout.includes('验收（门禁②）'), '输出应含验收段');
});

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

  const res = runCLI(['sign', 'cli-slice', '--review'], { cwd: sandbox });
  assert.equal(res.status, 0, `--review 应退出 0，实际 ${res.status}：\n${res.stdout}${res.stderr}`);

  assert.deepEqual(snapshotDir(slicesDir), beforeSlices, '.zelto/slices 在 --review 后不应有任何新增/修改');
  assert.deepEqual(snapshotDir(eventsDir), beforeEvents, '.zelto/events 在 --review 后不应有任何新增/追加');
});

test('npx tsc --noEmit 退出码 0（类型检查干净）', () => {
  // 用本地 typescript 的 bin（等价于 npx tsc），--noEmit 不写产物。
  // tsconfig.json 只覆盖 src/**，正是生产构建的类型面。
  const tscBin = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  const res = spawnSync(process.execPath, [tscBin, '--noEmit', '-p', join(ROOT, 'tsconfig.json')], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 180000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(res.error, undefined, `tsc 启动失败：${res.error}`);
  assert.equal(res.status, 0, `tsc --noEmit 应退出 0：\n${res.stdout}${res.stderr}`);
});
