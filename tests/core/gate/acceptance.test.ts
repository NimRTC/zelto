// 切片级验收的单元测试（ADR-033）
//
// 门禁②原本只跑全项目命令（pnpm test / pnpm lint）：只要别的测试还绿，
// 半成品也能过门禁，于是「签字 = 门禁通过」并不等于「这片东西真的被验证过」。
//
// 本文件锁住五件事：
//   1. 验收目标怎么定位（源目录 / 编译产物 / 找不到 —— 三种「找不到」要分开说）；
//   2. 目录目标必须展开成具体文件（node --test 不吃目录）；
//   3. 命令模板怎么填（{acceptance} 占位符 / 末尾追加）；
//   4. 三种结论的边界：passed / failed / skipped；
//   5. **假绿回归**：门禁自己跑在 node --test 里时，验收命令不得继承
//      NODE_TEST_CONTEXT，否则子进程会跳过所有用例直接 exit 0。
//
// C3: 判定确定 —— 同样的输入永远得到同样的结论。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildAcceptanceCommand,
  classifyMissingTarget,
  collectTestFiles,
  displayPath,
  isTestFileName,
  missingTargetOutcome,
  resolveAcceptance,
} from '../../../src/core/gate/acceptance.js';
import { GateExecutor } from '../../../src/core/gate/executor.js';
import { SliceStore } from '../../../src/core/slice/store.js';
import { EventStream, type EventEnvelope } from '../../../src/core/events/stream.js';
import { parseConfigYaml } from '../../../src/cli/commands/shared.js';
import type { GateConfig } from '../../../src/core/gate/types.js';

const TEST_DIR = join(tmpdir(), `zelto-gate-acceptance-${Date.now()}`);
const SLICES_DIR = join(TEST_DIR, 'slices');
const EVENTS_DIR = join(TEST_DIR, 'events');

describe('isTestFileName', () => {
  it('认得 node 测试运行器的默认命名', () => {
    assert.equal(isTestFileName('test.js'), true);
    assert.equal(isTestFileName('test-foo.js'), true);
    assert.equal(isTestFileName('foo.test.js'), true);
    assert.equal(isTestFileName('foo-test.js'), true);
    assert.equal(isTestFileName('foo_test.js'), true);
    assert.equal(isTestFileName('case.test.ts'), true);
  });

  it('不把普通源文件当测试文件', () => {
    assert.equal(isTestFileName('index.js'), false);
    assert.equal(isTestFileName('helper.ts'), false);
    assert.equal(isTestFileName('readme.md'), false);
  });
});

describe('collectTestFiles', () => {
  before(async () => {
    await mkdir(join(TEST_DIR, 'src', 'acceptance', 'nested'), { recursive: true });
    await writeFile(join(TEST_DIR, 'src', 'acceptance', 'a.test.js'), '// a\n');
    await writeFile(join(TEST_DIR, 'src', 'acceptance', 'nested', 'b.test.js'), '// b\n');
    await writeFile(join(TEST_DIR, 'src', 'acceptance', 'helper.js'), '// helper\n');
  });

  it('只收测试文件，且按路径排序（同样的输入 → 同样的命令）', () => {
    const files = collectTestFiles(join(TEST_DIR, 'src', 'acceptance'), TEST_DIR);
    assert.deepEqual(files, ['src/acceptance/a.test.js', 'src/acceptance/nested/b.test.js']);
  });
});

describe('resolveAcceptance', () => {
  before(async () => {
    await mkdir(join(TEST_DIR, 'tests', 'acceptance', 'slice-a'), { recursive: true });
    await writeFile(join(TEST_DIR, 'tests', 'acceptance', 'slice-a', 'case.test.ts'), '// ts\n');
    await mkdir(join(TEST_DIR, 'dist-test', 'tests', 'acceptance', 'slice-a'), { recursive: true });
    await mkdir(join(TEST_DIR, 'tests', 'acceptance', 'slice-b'), { recursive: true });
    await writeFile(join(TEST_DIR, 'tests', 'acceptance', 'slice-b', 'case.test.ts'), '// ts\n');
    await mkdir(join(TEST_DIR, 'dist-test', 'tests', 'acceptance', 'slice-b'), { recursive: true });
    await writeFile(join(TEST_DIR, 'dist-test', 'tests', 'acceptance', 'slice-b', 'case.test.js'), '// js\n');
    await mkdir(join(TEST_DIR, 'tests', 'acceptance', 'slice-empty'), { recursive: true });
  });

  it('目录形态：没有编译产物时用源路径', () => {
    const res = resolveAcceptance('tests/acceptance/slice-a/', TEST_DIR, 'dist-test');
    assert.equal(res.reason, null);
    assert.ok(res.target);
    assert.equal(res.target.path, 'tests/acceptance/slice-a');
    assert.equal(res.target.source, 'source');
  });

  it('目录形态：结尾斜杠与不带斜杠是同一个东西', () => {
    const withSlash = resolveAcceptance('tests/acceptance/slice-a/', TEST_DIR, 'dist-test');
    const without = resolveAcceptance('tests/acceptance/slice-a', TEST_DIR, 'dist-test');
    assert.equal(withSlash.target?.path, without.target?.path);
  });

  it('文件形态：.ts 源文件对应 .js 编译产物', () => {
    const res = resolveAcceptance('tests/acceptance/slice-b/case.test.ts', TEST_DIR, 'dist-test');
    assert.equal(res.reason, null);
    assert.ok(res.target);
    assert.equal(res.target.path, 'dist-test/tests/acceptance/slice-b/case.test.js');
    assert.equal(res.target.source, 'compiled');
    assert.deepEqual(res.target.files, ['dist-test/tests/acceptance/slice-b/case.test.js']);
  });

  it('目录形态：编译产物里有测试文件时优先跑编译产物', () => {
    const res = resolveAcceptance('tests/acceptance/slice-b', TEST_DIR, 'dist-test');
    assert.equal(res.reason, null);
    assert.ok(res.target);
    assert.equal(res.target.source, 'compiled');
    assert.deepEqual(res.target.files, ['dist-test/tests/acceptance/slice-b/case.test.js']);
  });

  it('目标不存在：说清是「不存在」', () => {
    const res = resolveAcceptance('tests/acceptance/nope', TEST_DIR, 'dist-test');
    assert.equal(res.target, null);
    assert.ok(res.reason?.includes('验收目标不存在'));
  });

  it('目录在但没有测试文件：说清是「目录里没有测试文件」（两种病不能报成一种）', () => {
    const res = resolveAcceptance('tests/acceptance/slice-empty', TEST_DIR, 'dist-test');
    assert.equal(res.target, null);
    assert.ok(res.reason?.includes('没有测试文件'));
  });

  it('空路径 / 纯空白都算「没登记验收目标」', () => {
    assert.equal(resolveAcceptance(undefined, TEST_DIR, 'dist-test').reason, '本片没有登记验收目标');
    assert.equal(resolveAcceptance('   ', TEST_DIR, 'dist-test').reason, '本片没有登记验收目标');
    assert.equal(resolveAcceptance('', TEST_DIR, 'dist-test').reason, '本片没有登记验收目标');
  });
});

describe('buildAcceptanceCommand', () => {
  it('模板里有 {acceptance} 就替换成文件列表', () => {
    assert.equal(
      buildAcceptanceCommand('node --test {acceptance}', ['dist-test/tests/acceptance/x/a.test.js']),
      'node --test dist-test/tests/acceptance/x/a.test.js',
    );
  });

  it('模板里没有占位符就把文件列表追加到末尾', () => {
    assert.equal(
      buildAcceptanceCommand('pnpm vitest run', ['tests/acceptance/x/a.test.js']),
      'pnpm vitest run tests/acceptance/x/a.test.js',
    );
  });

  it('占位符出现多次时全部替换', () => {
    assert.equal(
      buildAcceptanceCommand('node --test {acceptance} -- {acceptance}', ['p.test.js']),
      'node --test p.test.js -- p.test.js',
    );
  });

  it('路径带空格时加引号（走 shell，不加会被拆成两个参数）', () => {
    assert.equal(
      buildAcceptanceCommand('node --test {acceptance}', ['a dir/my test.test.js']),
      'node --test "a dir/my test.test.js"',
    );
  });
});

describe('classifyMissingTarget', () => {
  it('required=true 时没有目标是 failed（fail closed）', () => {
    assert.equal(classifyMissingTarget(true), 'failed');
  });

  it('required=false 时没有目标是 skipped', () => {
    assert.equal(classifyMissingTarget(false), 'skipped');
  });
});

describe('missingTargetOutcome', () => {
  it('组装出 failed 的结论，并带上原因', () => {
    const outcome = missingTargetOutcome(true, '验收目标不存在：tests/acceptance/x');
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.path, null);
    assert.equal(outcome.reason, '验收目标不存在：tests/acceptance/x');
    assert.equal(outcome.exitCode, null);
  });
});

describe('displayPath', () => {
  it('相对路径原样返回', () => {
    assert.equal(displayPath('tests/acceptance/x', TEST_DIR), 'tests/acceptance/x');
  });

  it('绝对路径换算成相对路径', () => {
    assert.equal(displayPath(join(TEST_DIR, 'tests', 'acceptance', 'x'), TEST_DIR), 'tests/acceptance/x');
  });

  it('不在目录下的绝对路径原样返回', () => {
    assert.equal(displayPath('C:\\elsewhere\\x', TEST_DIR), 'C:\\elsewhere\\x');
  });
});

describe('parseConfigYaml — 切片级验收段', () => {
  it('解析出 acceptance 段', () => {
    const config = parseConfigYaml(`
gate:
  commands:
    - name: test
      run: pnpm test
  acceptance:
    command: "node --test {acceptance}"
    required: false
    timeoutSec: 90
    buildDir: dist-out
  timeoutSec: 120
  retry:
    max: 2
`);
    assert.ok(config);
    assert.ok(config.gate.acceptance);
    assert.equal(config.gate.acceptance.command, 'node --test {acceptance}');
    assert.equal(config.gate.acceptance.required, false);
    assert.equal(config.gate.acceptance.timeoutSec, 90);
    assert.equal(config.gate.acceptance.buildDir, 'dist-out');
  });

  it('没写 acceptance 段时为 undefined（不配就退回默认行为）', () => {
    const config = parseConfigYaml(`
gate:
  commands:
    - name: test
      run: pnpm test
`);
    assert.ok(config);
    assert.equal(config.gate.acceptance, undefined);
  });

  it('写了 acceptance 段但没写 command：等于没配（不拿空命令去跑门禁）', () => {
    const config = parseConfigYaml(`
gate:
  commands:
    - name: test
      run: pnpm test
  acceptance:
    required: true
`);
    assert.ok(config);
    assert.equal(config.gate.acceptance, undefined);
  });

  it('acceptance 段在 profiles 之后也不会被当成 profile 名吃掉', () => {
    const config = parseConfigYaml(`
gate:
  commands:
    - name: test
      run: pnpm test
  profiles:
    docs:
      - name: lint
        run: pnpm lint
  acceptance:
    command: "node --test {acceptance}"
`);
    assert.ok(config);
    assert.ok(config.gate.acceptance, 'acceptance 段必须被解析出来');
    assert.equal(config.gate.acceptance.command, 'node --test {acceptance}');
    assert.ok(config.gate.profiles?.docs, 'profiles 不能被破坏');
  });

  it('acceptance 段之后的 gate 顶层键不被误吞', () => {
    const config = parseConfigYaml(`
gate:
  commands:
    - name: test
      run: pnpm test
  acceptance:
    command: "node --test {acceptance}"
  timeoutSec: 300
`);
    assert.ok(config);
    assert.equal(config.gate.timeoutSec, 300);
    assert.equal(config.gate.acceptance?.timeoutSec, undefined);
  });
});

describe('GateExecutor — 切片级验收', () => {
  let store: SliceStore;
  let events: EventStream;

  const baseConfig = (acceptance?: GateConfig['acceptance']): GateConfig => ({
    commands: [{ name: 'echo', run: 'echo hello' }],
    ...(acceptance ? { acceptance } : {}),
    timeoutSec: 30,
    retry: { max: 1, budgetStepUsd: 0.05 },
  });

  async function makeSlice(id: string): Promise<void> {
    const slice = store.create(id, `Slice ${id}`);
    slice.state = 'frozen';
    slice.spec.frozenHash = 'abc123';
    slice.spec.frozenAt = new Date().toISOString();
    await store.write(slice);
  }

  before(async () => {
    await mkdir(SLICES_DIR, { recursive: true });
    await mkdir(EVENTS_DIR, { recursive: true });
    await mkdir(join(TEST_DIR, 'tests', 'acceptance', 'pass-slice'), { recursive: true });
    await writeFile(
      join(TEST_DIR, 'tests', 'acceptance', 'pass-slice', 'case.test.js'),
      "import { test } from 'node:test';\ntest('ok', () => {});\n",
      'utf-8',
    );
    await mkdir(join(TEST_DIR, 'tests', 'acceptance', 'fail-slice'), { recursive: true });
    await writeFile(
      join(TEST_DIR, 'tests', 'acceptance', 'fail-slice', 'case.test.js'),
      "import { test } from 'node:test';\ntest('boom', () => { throw new Error('boom'); });\n",
      'utf-8',
    );
    store = new SliceStore(SLICES_DIR);
    events = new EventStream(EVENTS_DIR);
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('没配 gate.acceptance 时显式记为 skipped，且不拦门禁', async () => {
    await makeSlice('acc-skipped');
    const executor = new GateExecutor(store, events, baseConfig(), TEST_DIR);
    const report = await executor.execute('acc-skipped');

    assert.equal(report.passed, true);
    assert.ok(report.acceptance);
    assert.equal(report.acceptance.status, 'skipped');
    assert.equal(report.acceptance.path, null);
    assert.ok(report.acceptance.reason && report.acceptance.reason.length > 0);
  });

  it('配了验收但本片没有验收目标：failed，并且门禁不过', async () => {
    await makeSlice('acc-missing');
    const executor = new GateExecutor(
      store,
      events,
      baseConfig({ command: 'node --test {acceptance}', required: true }),
      TEST_DIR,
    );
    const report = await executor.execute('acc-missing');

    assert.equal(report.passed, false);
    assert.ok(report.acceptance);
    assert.equal(report.acceptance.status, 'failed');
    assert.equal(report.acceptance.path, null);
  });

  it('required=false 且本片没有验收目标：skipped，门禁照常过', async () => {
    await makeSlice('acc-optional');
    const executor = new GateExecutor(
      store,
      events,
      baseConfig({ command: 'node --test {acceptance}', required: false }),
      TEST_DIR,
    );
    const report = await executor.execute('acc-optional');

    assert.equal(report.passed, true);
    assert.ok(report.acceptance);
    assert.equal(report.acceptance.status, 'skipped');
  });

  it('验收测试跑通：passed', async () => {
    await makeSlice('pass-slice');
    const executor = new GateExecutor(
      store,
      events,
      baseConfig({ command: 'node --test {acceptance}', required: true }),
      TEST_DIR,
    );
    const report = await executor.execute('pass-slice');

    assert.equal(report.passed, true);
    assert.ok(report.acceptance);
    assert.equal(report.acceptance.status, 'passed');
    assert.equal(report.acceptance.path, 'tests/acceptance/pass-slice');
    assert.ok(report.acceptance.command);
    assert.deepEqual(report.acceptance.files, ['tests/acceptance/pass-slice/case.test.js']);
    assert.ok((report.acceptance.durationMs ?? 0) >= 0);
  });

  it('验收测试跑挂：failed，门禁不过', async () => {
    await makeSlice('fail-slice');
    const executor = new GateExecutor(
      store,
      events,
      baseConfig({ command: 'node --test {acceptance}', required: true }),
      TEST_DIR,
    );
    const report = await executor.execute('fail-slice');

    assert.equal(report.passed, false);
    assert.ok(report.acceptance);
    assert.equal(report.acceptance.status, 'failed');
    assert.ok(report.acceptance.reason && report.acceptance.reason.length > 0);
  });

  // ── 假绿回归 ─────────────────────────────────────────────────────────
  // 这段测试本身跑在 node --test 里，父进程带着 NODE_TEST_CONTEXT=child-v8。
  // 门禁派生的验收命令若继承它，子进程会跳过所有用例直接 exit 0 ——
  // 于是「一个测试都没跑」被当成「测试全过」。这里锁死它不许复发。
  it('验收命令不继承 NODE_TEST_CONTEXT（防止假绿）', async () => {
    assert.equal(
      process.env.NODE_TEST_CONTEXT,
      'child-v8',
      '前置条件：本测试应在 node --test 的子进程里运行',
    );

    await makeSlice('fail-slice');
    const executor = new GateExecutor(
      store,
      events,
      baseConfig({ command: 'node --test {acceptance}', required: true }),
      TEST_DIR,
    );
    const report = await executor.execute('fail-slice');

    assert.equal(report.acceptance?.status, 'failed', '验收必须真的跑过测试并看到失败');
    assert.equal(report.passed, false);
  });

  it('验收结论写进事件流（事后查得到这片验没验）', async () => {
    const evts = await events.read('pass-slice');
    const gateResults = evts.filter((e: EventEnvelope) => e.type === 'gate.result');
    assert.ok(gateResults.length > 0);
    const withAcceptance = gateResults.find((e: EventEnvelope) => e.payload && 'acceptance' in e.payload);
    assert.ok(withAcceptance, 'gate.result 事件里应当带上验收结论');
  });
});
