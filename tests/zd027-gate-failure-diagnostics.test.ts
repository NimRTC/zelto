// 门禁失败精准证据提取（core/gate/diagnostics.ts，ZD-027）
//
// 实战病灶（nimrtc-v14，2026-11-23）：
//   门禁 `test` exit=8，但 gate.result 里只存了 stdout 头 500 字符 ——
//   恰好是**前面通过了**的用例。真正失败的用例在中间段被截掉，
//   只剩一句 `Errors while running CTest`。agent 拿不到「错哪个」。
//
// 本模块把原始输出抽成 { test, message, location }[]，覆盖主流运行器。
// C3：纯字符串计算，判定确定。抽不出时空清单 —— 空不等于通过。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { GateExecutor } from '../src/core/gate/executor.js';
import { SliceStore } from '../src/core/slice/store.js';
import { EventStream } from '../src/core/events/stream.js';
import type { GateConfig } from '../src/core/gate/types.js';
import { createCtestFixture, type CtestFixture } from './helpers/ctest-fixture.js';

import {
  extractGateFailures,
  DIAGNOSTICS_LIMITS,
  buildCtestRerunFilter,
  isCtestCommand,
  narrowCtestCommand,
  narrowCommandsToFailedTests,
} from '../src/core/gate/diagnostics.js';

describe('extractGateFailures — CTest', () => {
  // 复刻 nimrtc-v14 的真实形态：前面一堆 Passed，中间一条 ***Failed，
  // 末尾有 The following tests FAILED 清单 + 夹带的 gtest 断言。
  const ctestOutput = [
    'Test project D:/MyOpen/nimrtc-v14/.zelto/worktrees/v1-device-policy/build',
    '          Start    1: BwePluginSeam.RegisterDefaultPluginsRegistersAimd',
    '   1/2333 Test    #1: BwePluginSeam.RegisterDefaultPluginsRegistersAimd ... Passed    0.01 sec',
    '          Start 1234: VideoCapture.SwitchDevice',
    '   2/2333 Test #1234: VideoCapture.SwitchDevice .........................***Failed    0.42 sec',
    '1234: [----------] 1 test from VideoCapture',
    '1234: [ RUN      ] VideoCapture.SwitchDevice',
    '1234: /src/test/video_capture_test.cpp:88: Failure',
    '1234: Expected equality of these values:',
    '1234:   expected_frame_count',
    '1234:     Which is: 0',
    '1234:   captured_count',
    '1234:     Which is: 3',
    '',
    'The following tests FAILED:',
    '        1234 - VideoCapture.SwitchDevice (Failed)',
    'Errors while running CTest',
    '100% tests passed, 1 tests failed out of 2333',
    'Errors while running CTest',
  ].join('\n');

  it('抽出失败用例名（来自 The following tests FAILED 清单）', () => {
    const r = extractGateFailures(ctestOutput);
    assert.equal(r.runner, 'ctest');
    assert.equal(r.failures.length, 1);
    assert.equal(r.failures[0].test, 'VideoCapture.SwitchDevice');
  });

  it('抽出断言尾部（Which is / expected），而不是只有一句 Errors while running', () => {
    const r = extractGateFailures(ctestOutput);
    assert.ok(r.failures[0].message.includes('expected_frame_count'), r.failures[0].message);
    assert.ok(r.failures[0].message.includes('Which is: 0'));
    assert.ok(r.failures[0].message.includes('Which is: 3'));
  });

  it('解析出运行器声明的失败总数', () => {
    const r = extractGateFailures(ctestOutput);
    assert.equal(r.reportedFailureCount, 1);
  });

  it('没有 The following tests FAILED 清单时，从 ***Failed 标记行兜底', () => {
    const out = [
      '   2/3 Test #7: Audio.TurnTaken .........................***Failed    0.10 sec',
      '   3/3 Test #8: Audio.Other .............................   Passed    0.01 sec',
    ].join('\n');
    const r = extractGateFailures(out);
    assert.equal(r.runner, 'ctest');
    assert.ok(r.failures.some((f) => f.test === 'Audio.TurnTaken'));
  });

  it('全过（0 failed）时抽不出任何失败用例', () => {
    const out = [
      '   1/2 Test #1: A ... Passed 0.01 sec',
      '   2/2 Test #2: B ... Passed 0.01 sec',
      '100% tests passed, 0 tests failed out of 2',
    ].join('\n');
    const r = extractGateFailures(out);
    assert.equal(r.failures.length, 0);
    assert.equal(r.reportedFailureCount, 0);
  });
});

describe('extractGateFailures — node --test TAP', () => {
  const tapOutput = [
    'TAP version 13',
    'ok 1 - first test',
    'not ok 2 - second test',
    '  ---',
    '  duration_ms: 1.2',
    '  type: \'test\'',
    '  location: \'/home/u/proj/tests/foo.test.js:12:3\'',
    '  failureType: \'testCodeFailure\'',
    '  error: \'expected 2 but got 1\'',
    '  code: \'ERR_ASSERTION\'',
    '  ...',
    '# tests 2',
    '# pass 1',
    '# fail 1',
  ].join('\n');

  it('抽出 not ok 用例与 error 文本', () => {
    const r = extractGateFailures(tapOutput);
    assert.equal(r.runner, 'node-tap');
    assert.equal(r.failures.length, 1);
    assert.equal(r.failures[0].test, 'second test');
    assert.ok(r.failures[0].message.includes('expected 2 but got 1'), r.failures[0].message);
    assert.equal(r.failures[0].location, '/home/u/proj/tests/foo.test.js:12:3');
    assert.equal(r.reportedFailureCount, 1);
  });
});

describe('extractGateFailures — node --test spec reporter', () => {
  const specOutput = [
    '▶ suite',
    '  ✔ ok child (0.5ms)',
    '  ✖ bad child (1.2ms)',
    '    AssertionError [ERR_ASSERTION]: expected 2 but got 1',
    '        at TestContext.<anonymous> (file:///p/tests/foo.test.js:12:3)',
    'ℹ tests 2',
    'ℹ pass 1',
    'ℹ fail 1',
  ].join('\n');

  it('抽出 ✖ 用例与 AssertionError 消息', () => {
    const r = extractGateFailures(specOutput);
    assert.equal(r.runner, 'node-spec');
    assert.equal(r.failures.length, 1);
    assert.equal(r.failures[0].test, 'bad child');
    assert.ok(r.failures[0].message.includes('expected 2 but got 1'), r.failures[0].message);
    assert.equal(r.reportedFailureCount, 1);
  });
});

describe('extractGateFailures — gtest（裸跑）', () => {
  const gtestOutput = [
    '[ RUN      ] VideoCapture.SwitchDevice',
    '/src/test/video_capture_test.cpp:88: Failure',
    'Expected equality of these values:',
    '  expected: 2',
    '    actual: 1',
    '[  FAILED  ] VideoCapture.SwitchDevice (0 ms)',
    '[  PASSED  ] 3 tests.',
    '[  FAILED  ] 1 test, listed below:',
    '[  FAILED  ] VideoCapture.SwitchDevice',
  ].join('\n');

  it('抽出 [ RUN ]...段里失败的用例与断言', () => {
    const r = extractGateFailures(gtestOutput);
    assert.equal(r.runner, 'gtest');
    assert.equal(r.failures.length, 1);
    assert.equal(r.failures[0].test, 'VideoCapture.SwitchDevice');
    assert.ok(r.failures[0].message.includes('expected: 2'), r.failures[0].message);
    assert.ok(
      (r.failures[0].location ?? '').includes('video_capture_test.cpp:88'),
      r.failures[0].location ?? '(no location)',
    );
  });
});

describe('extractGateFailures — jest', () => {
  const jestOutput = [
    '  ● suite name › test name',
    '',
    '    expect(received).toBe(expected)',
    '',
    '    Expected: 2',
    '    Received: 1',
    '',
    '      at Object.<anonymous> (src/foo.test.js:12:3)',
    '',
    'Tests:       1 failed, 1 total',
  ].join('\n');

  it('抽出 ● 用例名与 expect 消息', () => {
    const r = extractGateFailures(jestOutput);
    assert.equal(r.runner, 'jest');
    assert.equal(r.failures.length, 1);
    assert.equal(r.failures[0].test, 'suite name › test name');
    assert.ok(r.failures[0].message.includes('Expected: 2'), r.failures[0].message);
    assert.equal(r.reportedFailureCount, 1);
  });
});

describe('extractGateFailures — vitest', () => {
  const vitestOutput = [
    ' FAIL  src/foo.test.ts > suite > test name',
    'AssertionError: expected 2 to be 1',
    '',
    ' Test Files  1 failed (1)',
    '      Tests  1 failed | 1 passed (2)',
  ].join('\n');

  it('抽出 FAIL 用例名与断言', () => {
    const r = extractGateFailures(vitestOutput);
    assert.equal(r.runner, 'vitest');
    assert.equal(r.failures.length, 1);
    assert.equal(r.failures[0].test, 'suite > test name');
    assert.ok(r.failures[0].message.includes('expected 2 to be 1'), r.failures[0].message);
    assert.equal(r.reportedFailureCount, 1);
  });
});

describe('extractGateFailures — 边界', () => {
  it('空输出 → 空清单，runner 为 unknown（不编造）', () => {
    const r = extractGateFailures('');
    assert.equal(r.runner, 'unknown');
    assert.deepEqual(r.failures, []);
    assert.equal(r.reportedFailureCount, null);
  });

  it('认不出的输出 → 空清单，不报假失败', () => {
    const r = extractGateFailures('some random build log\nno tests here\n');
    assert.deepEqual(r.failures, []);
  });

  it('超长断言消息会截断到上限并标注', () => {
    const longMsg = 'E'.repeat(DIAGNOSTICS_LIMITS.MAX_MESSAGE_CHARS + 100);
    const tap = [
      'not ok 1 - big',
      '  ---',
      `  error: '${longMsg}'`,
      '  ...',
    ].join('\n');
    const r = extractGateFailures(tap);
    assert.equal(r.failures.length, 1);
    assert.ok(r.failures[0].message.length <= DIAGNOSTICS_LIMITS.MAX_MESSAGE_CHARS + 20);
    assert.ok(r.failures[0].message.includes('truncated'));
  });

  it('抽出的条数不超过上限', () => {
    const lines = ['TAP version 13'];
    for (let i = 0; i < DIAGNOSTICS_LIMITS.MAX_FAILURES + 20; i++) {
      lines.push(`not ok ${i + 1} - t${i}`);
      lines.push('  ---');
      lines.push(`  error: 'boom ${i}'`);
      lines.push('  ...');
    }
    const r = extractGateFailures(lines.join('\n'));
    assert.equal(r.failures.length, DIAGNOSTICS_LIMITS.MAX_FAILURES);
  });
});

describe('buildCtestRerunFilter', () => {
  it('把失败用例名构造成整名精确匹配的正则', () => {
    const f = buildCtestRerunFilter(['VideoCapture.SwitchDevice', 'Audio.TurnTaken']);
    assert.ok(f);
    // 元字符转义：`.` 变成 `\.`，不误匹配
    assert.ok(f.includes('VideoCapture\\.SwitchDevice'));
    assert.ok(f.includes('Audio\\.TurnTaken'));
    assert.ok(f.startsWith('^(?:'));
    assert.ok(f.endsWith(')$'));
  });

  it('没有用例名 → null（退回全量）', () => {
    assert.equal(buildCtestRerunFilter([]), null);
    assert.equal(buildCtestRerunFilter(['', '  ']), null);
  });

  it('整名匹配：Foo 不会顺带匹配 FooBar', () => {
    const f = buildCtestRerunFilter(['Foo']);
    assert.ok(f);
    const re = new RegExp(f);
    assert.ok(re.test('Foo'));
    assert.ok(!re.test('FooBar'), '整名匹配不该命中 FooBar');
  });
});

describe('isCtestCommand / narrowCtestCommand', () => {
  it('识别 ctest 命令', () => {
    assert.ok(isCtestCommand('ctest'));
    assert.ok(isCtestCommand('cd build && ctest --output-on-failure'));
    assert.ok(!isCtestCommand('npm test'));
    assert.ok(!isCtestCommand('cmake --build build'));
    assert.ok(!isCtestCommand('ctester --foo'), 'ctester 不是 ctest');
  });

  it('把裸 ctest 收窄成 -R 过滤', () => {
    const out = narrowCtestCommand('ctest --output-on-failure', buildCtestRerunFilter(['A.B']));
    assert.equal(out, 'ctest -R "^(?:A\\.B)$" --output-on-failure');
  });

  it('命令链里的 ctest 也能收窄', () => {
    const out = narrowCtestCommand('cd build && ctest', buildCtestRerunFilter(['A']));
    assert.equal(out, 'cd build && ctest -R "^(?:A)$"');
  });

  it('非 ctest 命令 → null（不收窄）', () => {
    assert.equal(narrowCtestCommand('npm test', buildCtestRerunFilter(['A'])), null);
  });

  it('已带 -R / --tests-regex 的命令不叠加', () => {
    assert.equal(narrowCtestCommand('ctest -R foo', buildCtestRerunFilter(['A'])), null);
    assert.equal(narrowCtestCommand('ctest --tests-regex foo', buildCtestRerunFilter(['A'])), null);
  });

  it('filter 为 null → null', () => {
    assert.equal(narrowCtestCommand('ctest', null), null);
  });
});

describe('narrowCommandsToFailedTests（--rerun-failed 的纯逻辑）', () => {
  const cmds = [
    { name: 'build', run: 'cmake --build build' },
    { name: 'test', run: 'cd build && ctest --output-on-failure' },
    { name: 'lint', run: 'npm run lint' },
  ];

  it('只收窄与失败命令同名的 ctest 命令，其它命令原样', () => {
    const r = narrowCommandsToFailedTests(cmds, new Map([['test', ['Foo.B', 'Bar.C']]]));
    assert.ok(r);
    const byName = Object.fromEntries(r.commands.map((c) => [c.name, c.run]));
    assert.equal(byName.build, 'cmake --build build');
    assert.equal(byName.lint, 'npm run lint');
    assert.ok(byName.test.includes('ctest -R "^(?:Foo\\.B|Bar\\.C)$"'), byName.test);
    assert.ok(r.filter.includes('Foo\\.B'));
  });

  it('没有失败信息 → null（退回全量）', () => {
    assert.equal(narrowCommandsToFailedTests(cmds, new Map()), null);
  });

  it('失败命令名对不上现有命令 → null', () => {
    assert.equal(narrowCommandsToFailedTests(cmds, new Map([['unknown', ['A']]])), null);
  });

  it('失败命令不是 ctest（比如 npm test）→ 不收窄', () => {
    const r = narrowCommandsToFailedTests(cmds, new Map([['lint', ['A']]]));
    assert.equal(r, null);
  });
});

describe('GateExecutor — 失败诊断落进 gate.result（ZD-027）', () => {
  const DIR = join(tmpdir(), `zelto-zd027-gate-${Date.now()}`);
  const SLICES = join(DIR, 'slices');
  const EVENTS = join(DIR, 'events');
  // fixture 脚本：打印一段真实形态的 CTest 输出后退出 8（复刻 nimrtc-v14）。
  // 写成独立 .cjs 而不是 `node -e "…"` —— 后者经 shell 转义后换行会损坏。
  const FIXTURE = join(DIR, 'emit-ctest-fail.cjs');

  before(async () => {
    await mkdir(SLICES, { recursive: true });
    await mkdir(EVENTS, { recursive: true });
    await writeFile(
      FIXTURE,
      [
        'const out = [',
        "  'Test project /x/build',",
        "  '          Start    1: Foo.A',",
        "  '   1/3 Test    #1: Foo.A ... Passed 0.01 sec',",
        "  '          Start    2: Foo.B',",
        "  '   2/3 Test    #2: Foo.B ...***Failed 0.02 sec',",
        "  '2: [ RUN      ] Foo.B',",
        "  '2: /src/foo_test.cpp:12: Failure',",
        "  '2: Expected equality of these values:',",
        "  '2:   a',",
        "  '2:     Which is: 1',",
        "  '2:   b',",
        "  '2:     Which is: 2',",
        "  'The following tests FAILED:',",
        "  '        2 - Foo.B (Failed)',",
        "  '100% tests passed, 1 tests failed out of 3',",
        "].join('\\n');",
        'console.log(out);',
        'process.exit(8);',
        '',
      ].join('\n'),
      'utf-8',
    );
  });

  after(async () => {
    await rm(DIR, { recursive: true, force: true });
  });

  it('门禁命令失败时 gate.result 事件带失败用例清单与断言（而非只有头 500 字符）', async () => {
    const store = new SliceStore(SLICES);
    const events = new EventStream(EVENTS);

    const cfg: GateConfig = {
      commands: [{ name: 'test', run: `node "${FIXTURE}"` }],
      timeoutSec: 30,
      retry: { max: 0, budgetStepUsd: 0.05 },
    };
    const exec = new GateExecutor(store, events, cfg, DIR);

    const slice = store.create('zd027-gate-1', 'zd027');
    slice.state = 'frozen';
    slice.spec.frozenHash = 'h';
    slice.spec.frozenAt = new Date().toISOString();
    await store.write(slice);

    const report = await exec.execute('zd027-gate-1');
    assert.equal(report.passed, false);

    // 结果对象上直接带诊断
    const r0 = report.results[0];
    assert.equal(r0.passed, false);
    assert.ok(Array.isArray(r0.failures) && r0.failures.length === 1, '应抽出 1 个失败用例');
    assert.equal(r0.failures?.[0].test, 'Foo.B');
    assert.equal(r0.runner, 'ctest');
    assert.ok(r0.failures?.[0].message.includes('Which is: 1'), r0.failures?.[0].message);

    // 事件里也带上了（追溯链的证据）
    const evts = await events.read('zd027-gate-1');
    const gr = evts.find((e) => e.type === 'gate.result');
    assert.ok(gr);
    const stored = (gr?.payload?.results as Array<Record<string, unknown>>)[0];
    const storedFailures = stored.failures as Array<{ test?: string }>;
    assert.ok(Array.isArray(storedFailures) && storedFailures.length === 1);
    assert.equal(storedFailures[0].test, 'Foo.B');
  });
});

// ─── ADR-096：门禁**内部重试**自动收窄到失败用例 ────────────────────────
//
// 病灶（nimrtc-v14 实测）：6 次 gate.retry 全部是**全量重跑**。
// `v1-device-policy` 一片光 test 就花了 1254.6s（5 次全量），
// 其中 3 次是纯浪费 —— 失败是确定性的，重跑 2333 个用例只为了
// 再确认同一个失败。每次约 270s，合计约 810s。
//
// 修法：重试时把 ctest 命令收窄成 `--tests-from-file <清单>`，
// 只跑上一轮失败的那几个用例。第一轮已全量跑过，覆盖没丢。
describe('GateExecutor — 内部重试自动收窄（ADR-096）', () => {
  const DIR = join(tmpdir(), `zelto-adr096-gate-${Date.now()}`);
  const SLICES = join(DIR, 'slices');
  const EVENTS = join(DIR, 'events');
  // fixture：模拟一个「ctest 替身」——
  //   第一轮（没有 --tests-from-file）：打印失败清单，退出 8；
  //   第二轮（带 --tests-from-file）：只跑清单里的用例，仍失败。
  // 它把每一轮的实际命令行写进 run.log，测试据此断言「第二轮确实收窄了」。
  //
  // **为什么分两个文件**：工具文件（`ctest.cmd` / `ctest.sh`）是
  // 「ctest 可执行文件」的替身（`.cmd` 是 Windows 上真实的可执行形态，
  // `.sh` 是 POSIX 上的），`ctest-worker.cjs` 是它背后的实现。
  //
  // 收窄逻辑认的是**词元** `ctest` + 可执行扩展名 ——
  // 所以 `ctest.cmd` / `ctest.sh` 认得出，
  // `ctest-worker.cjs`（扩展名 `.cjs`）认不出。
  //
  // **跨平台**：Windows 上是 `cmd /c "..."`，POSIX 上直接执行 `ctest.sh` ——
  // `cmd` 在 Linux 上不存在，硬套 Windows 形态会让这条用例在 Linux CI 上
  // 永远走不到断言。详见 tests/helpers/ctest-fixture.ts。
  const WORKER = join(DIR, 'ctest-worker.cjs');
  const RUN_LOG = join(DIR, 'run.log');
  let fixture: CtestFixture;
  let FIXTURE: string;

  before(async () => {
    await mkdir(SLICES, { recursive: true });
    await mkdir(EVENTS, { recursive: true });
    await writeFile(
      WORKER,
      [
        "const fs = require('fs');",
        `const LOG = ${JSON.stringify(RUN_LOG)};`,
        'const args = process.argv.slice(2);',
        // 清单文件参数
        //
        // **必须先确认 flag 真的在**：`indexOf` 找不到时返回 -1，
        // `+ 1` 就变成 0 → `args[0]`（`--test-dir`）被当成清单路径
        // → 第一轮（本来就该跑全量）直接 ENOENT 崩掉。
        //
        // 第一轮的输出必须长得像 ctest 的失败输出 —— 否则收窄逻辑
        // 认不出「这是 ctest 失败」，窄化压根不触发，用例走不到断言。
        "const mfIdx = args.indexOf('--tests-from-file');",
        'const mf = mfIdx >= 0 ? args[mfIdx + 1] : null;',
        'let names;',
        'if (mf) {',
        "  names = fs.readFileSync(mf, 'utf8').split('\\n').map(s => s.trim()).filter(Boolean);",
        '} else {',
        "  names = ['Foo.A', 'Foo.B', 'Foo.C'];",
        '}',
        // 记录本轮**实际跑了哪些用例**（清单会被 executor 跑完删掉，
        // 所以必须在跑的时候记下来）。
        'fs.appendFileSync(LOG, JSON.stringify({ args, ran: names }) + "\\n");',
        'const failed = names[names.length - 1];',
        'const lines = [',
        "  'Test project /x/build',",
        '];',
        'for (const n of names) {',
        "  lines.push('   1/' + names.length + ' Test    #1: ' + n + ' ... Passed 0.01 sec');",
        '}',
        "lines.push('   2/' + names.length + ' Test    #2: ' + failed + ' ...***Failed 0.02 sec');",
        "lines.push('2: [ RUN      ] ' + failed);",
        "lines.push('2: /src/foo_test.cpp:12: Failure');",
        "lines.push('The following tests FAILED:');",
        "lines.push('        2 - ' + failed + ' (Failed)');",
        "lines.push('100% tests passed, 1 tests failed out of ' + names.length);",
        'console.log(lines.join("\\n"));',
        'process.exit(8);',
        '',
      ].join('\n'),
      'utf-8',
    );
    // ctest 替身（工具文件 + 背后的实现文件），按平台适配。
    fixture = createCtestFixture(
      DIR,
      'ctest-worker.cjs',
      '--test-dir build --output-on-failure -C Debug',
    );
    FIXTURE = fixture.command;
  });
  after(async () => {
    await rm(DIR, { recursive: true, force: true });
  });

  it('重试时命令被收窄成 --tests-from-file，只跑上一轮失败的用例', async () => {
    const store = new SliceStore(SLICES);
    const events = new EventStream(EVENTS);

    const cfg: GateConfig = {
      commands: [{ name: 'test', run: FIXTURE }],
      timeoutSec: 30,
      retry: { max: 1, budgetStepUsd: 0.05 },
    };
    const exec = new GateExecutor(store, events, cfg, DIR);

    const slice = store.create('adr096-retry-1', 'adr096');
    slice.state = 'frozen';
    slice.spec.frozenHash = 'h';
    slice.spec.frozenAt = new Date().toISOString();
    await store.write(slice);

    await exec.execute('adr096-retry-1');

    // 跑了两轮（第一轮 + 一次重试）
    const runs = (await readFile(RUN_LOG, 'utf8'))
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { args: string[]; ran: string[] });

    assert.equal(runs.length, 2, '应该跑了两轮');
    assert.equal(runs[0].args.includes('--tests-from-file'), false, '第一轮是全量');
    assert.equal(runs[1].args.includes('--tests-from-file'), true, '重试必须收窄');

    // 重试时**只跑了**上一轮失败的那一个用例（不是全部 3 个）
    assert.deepEqual(runs[0].ran, ['Foo.A', 'Foo.B', 'Foo.C'], '第一轮应跑全量');
    assert.deepEqual(runs[1].ran, ['Foo.C'], '重试应只跑上一轮失败的用例');
  });

  it('gate.retry 事件留痕：记下这次重试收窄到哪些用例', async () => {
    const store = new SliceStore(SLICES);
    const events = new EventStream(EVENTS);

    const cfg: GateConfig = {
      commands: [{ name: 'test', run: FIXTURE }],
      timeoutSec: 30,
      retry: { max: 1, budgetStepUsd: 0.05 },
    };
    const exec = new GateExecutor(store, events, cfg, DIR);

    const slice = store.create('adr096-retry-2', 'adr096');
    slice.state = 'frozen';
    slice.spec.frozenHash = 'h';
    slice.spec.frozenAt = new Date().toISOString();
    await store.write(slice);

    await exec.execute('adr096-retry-2');

    const evts = await events.read('adr096-retry-2');
    const retry = evts.find((e) => e.type === 'gate.retry');
    assert.ok(retry, '应有 gate.retry 事件');
    const narrowed = retry?.payload?.narrowedToTests as string[] | undefined;
    assert.ok(Array.isArray(narrowed), '事件里应记下收窄到的用例');
    assert.deepEqual(narrowed, ['Foo.C']);
  });

  it('清单文件跑完就删（不留垃圾）', async () => {
    const store = new SliceStore(SLICES);
    const events = new EventStream(EVENTS);

    const cfg: GateConfig = {
      commands: [{ name: 'test', run: FIXTURE }],
      timeoutSec: 30,
      retry: { max: 1, budgetStepUsd: 0.05 },
    };
    const exec = new GateExecutor(store, events, cfg, DIR);

    const slice = store.create('adr096-retry-3', 'adr096');
    slice.state = 'frozen';
    slice.spec.frozenHash = 'h';
    slice.spec.frozenAt = new Date().toISOString();
    await store.write(slice);

    await exec.execute('adr096-retry-3');

    const left = (await readdir(DIR)).filter((f) => f.startsWith('.zelto-gate-tests-'));
    assert.deepEqual(left, [], `清单文件应被删掉，实际还剩：${left.join(', ')}`);
  });
});
