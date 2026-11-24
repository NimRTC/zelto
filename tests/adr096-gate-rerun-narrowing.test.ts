// ADR-096：门禁失败重跑按失败用例收窄
//
// 三个已实测确认的缺陷（本文件的测试就是它们的回归防线）：
//
//   缺陷一：`isCtestCommand` 认不出被 `cmd /c` 包起来的 ctest ——
//     `cmd /c "ctest ..."` 判为 false。收窄逻辑恰好在它被开发出来的
//     那个项目（nimrtc-v14）上不工作。
//
//   缺陷二：`-R` 的正则里 `|` 在 Windows cmd 下是**管道符** ——
//     `cmd /c "ctest -R "^(?:A|B)$" ..."` 直接把命令打崩（exit 255）。
//
//   缺陷三：`--tests-from-file` 没匹配到用例时退出码是 **0**
//     （stderr 打印 `No tests were found!!!`）—— 假绿陷阱。
//
// C3：被测逻辑全是纯字符串计算，判定确定。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  isCtestCommand,
  narrowCtestCommandByFile,
  narrowCommandsToFailedTestsByFile,
  verifyNarrowedTestsRan,
  buildCtestRerunFilter,
  narrowCtestCommand,
} from '../src/core/gate/diagnostics.js';
import { GateExecutor } from '../src/core/gate/executor.js';
import { runGate } from '../src/core/lifecycle/gate.js';
import { SliceStore } from '../src/core/slice/store.js';
import { EventStream } from '../src/core/events/stream.js';
import type { GateConfig } from '../src/core/gate/types.js';
import { createCtestFixture, type CtestFixture } from './helpers/ctest-fixture.js';

describe('ADR-096 · isCtestCommand 认得出被 cmd /c 包起来的 ctest', () => {
  it('识破 nimrtc-v14 的真实命令形态', () => {
    // 这条命令来自 nimrtc-v14 的 .zelto/config.yaml —— 旧实现对它判 false。
    const cmd = 'cmd /c "ctest --test-dir build --output-on-failure -C Debug --timeout 120"';
    assert.equal(isCtestCommand(cmd), true, 'cmd /c "ctest ..." 必须被认出来');
  });

  it('识破裸 ctest 与 cmd /c ctest', () => {
    assert.equal(isCtestCommand('ctest --test-dir build'), true);
    assert.equal(isCtestCommand('cmd /c ctest --test-dir build'), true);
  });

  it('不把 cmake --build / 非 ctest 命令误判成 ctest', () => {
    assert.equal(isCtestCommand('cmd /c "cmake --build build --config Debug"'), false);
    assert.equal(isCtestCommand('npm test'), false);
    assert.equal(isCtestCommand('echo ctester'), false);
  });

  it('路径形态的 ctest 工具要认得出', () => {
    // 真实场景：ctest 在 PATH 里的绝对路径上
    assert.equal(isCtestCommand('C:/cmake/bin/ctest.exe --test-dir build'), true);
    assert.equal(isCtestCommand('/usr/bin/ctest --test-dir build'), true);
    assert.equal(isCtestCommand('"C:/Program Files/CMake/bin/ctest.exe" -C Debug'), true);
  });

  it('路径里的 ctest **脚本**不是 ctest 工具（宁可不收窄）', () => {
    // 扩展名不是可执行形态 → 是别的工具的脚本，不该收窄
    assert.equal(isCtestCommand('node "/tmp/x/ctest.cjs"'), false);
    assert.equal(isCtestCommand('node "C:/tmp/ctest.js"'), false);
    // 目录名里含 ctest 也不该认
    assert.equal(isCtestCommand('/opt/ctest-tools/run'), false);
  });
});

describe('ADR-096 · 收窄用 --tests-from-file（避开 Windows 正则陷阱）', () => {
  it('在 cmd /c "ctest ..." 内部插入 --tests-from-file', () => {
    const cmd = 'cmd /c "ctest --test-dir build --output-on-failure -C Debug"';
    const out = narrowCtestCommandByFile(cmd, '.zelto-gate-tests-v1.txt');
    assert.ok(out);
    assert.ok(
      out.includes('--tests-from-file .zelto-gate-tests-v1.txt'),
      `参数必须插进引号内，实际：${out}`,
    );
    // 原命令的其余部分必须原样保留
    assert.ok(out.includes('--test-dir build'));
    assert.ok(out.includes('--output-on-failure'));
  });

  it('裸 ctest 也能插入', () => {
    const out = narrowCtestCommandByFile('ctest --test-dir build', 'm.txt');
    assert.ok(out);
    assert.ok(out.includes('--tests-from-file m.txt'));
  });

  // ── 引号边界（2026-11-25，Linux CI 红了才暴露出来）────────────────────
  //
  // 路径形态带引号时，插入点必须落在引号**外面**。
  //
  // POSIX shell 里引号是 shell 的 —— 引号内是**一个 token**。
  // 插在引号内会得到：
  //
  //   "/tmp/x/ctest.sh --tests-from-file m.txt" --test-dir build
  //
  // 整个「路径+参数」成了**文件名** —— 命令跑不起来，
  // 门禁报的是一个与被测代码毫不相干的错。
  //
  // Windows 上 `cmd /c "..."` 的引号由 cmd 自己配对，参数落在引号内也照样是
  // 独立参数 —— 所以**同样的形态在两个平台上结果不同**，
  // 而插入点必须让两边都对。
  //
  // 这条用例在 Windows 上也跑（断言与平台无关）——
  // 本地全绿、只有 Linux CI 红，说明这个洞**没有平台无关的回归护栏**。
  // 补上它，下次再动插入点时本地就会红。
  it('路径带引号时，参数插在引号**外面**（POSIX shell 语义）', () => {
    const cmd = '"/tmp/gate/ctest.sh" --test-dir build --output-on-failure -C Debug';
    const out = narrowCtestCommandByFile(cmd, '.zelto-gate-tests-v1.txt');
    assert.ok(out);

    // 参数必须在闭合引号**之后** —— 不能落进引号内。
    const closeQuote = out.indexOf('"', out.indexOf('ctest.sh'));
    const argIdx = out.indexOf('--tests-from-file');
    assert.ok(closeQuote >= 0, `命令里应有闭合引号：${out}`);
    assert.ok(
      argIdx > closeQuote,
      `参数必须落在引号外（POSIX 引号内是一个 token），实际：${out}`,
    );

    // 路径本身必须完好 —— 不能被参数插坏。
    assert.ok(out.startsWith('"/tmp/gate/ctest.sh" '), `路径引号必须配对，实际：${out}`);
    // 原参数原样保留。
    assert.ok(out.includes('--test-dir build'));
    assert.ok(out.includes('--output-on-failure'));
    assert.ok(out.includes('-C Debug'));
  });

  it('单引号路径同样处理', () => {
    const cmd = "'/tmp/gate/ctest.sh' --test-dir build";
    const out = narrowCtestCommandByFile(cmd, 'm.txt');
    assert.ok(out);
    const closeQuote = out.indexOf("'", out.indexOf('ctest.sh'));
    assert.ok(
      out.indexOf('--tests-from-file') > closeQuote,
      `参数必须落在单引号外，实际：${out}`,
    );
  });

  it('人已经写了过滤参数 → 不叠加', () => {
    for (const cmd of [
      'ctest -R foo',
      'ctest --tests-regex foo',
      'ctest --tests-from-file other.txt',
    ]) {
      assert.equal(narrowCtestCommandByFile(cmd, 'm.txt'), null, `不该叠加：${cmd}`);
    }
  });

  it('不是 ctest 命令 → 不收窄', () => {
    assert.equal(narrowCtestCommandByFile('npm test', 'm.txt'), null);
  });

  it('旧的 -R 形态仍然可用（POSIX 兼容）', () => {
    const out = narrowCtestCommand('ctest --test-dir build', '^(?:A|B)$');
    assert.ok(out);
    assert.ok(out.includes('-R "^(?:A|B)$"'));
  });

  it('buildCtestRerunFilter 转义正则元字符', () => {
    const f = buildCtestRerunFilter(['Suite.Test', 'A(B)']);
    assert.equal(f, '^(?:Suite\\.Test|A\\(B\\))$');
  });
});

describe('ADR-096 · 收窄后必须自证「跑到了用例」（堵假绿）', () => {
  it('ctest 说没找到用例 → 判为没跑到', () => {
    const r = verifyNarrowedTestsRan('No tests were found!!!\n', ['Some.Test']);
    assert.equal(r.ran, false);
    assert.ok(r.reason);
  });

  it('输出里看不到被筛选用例 → 判为没跑到', () => {
    const r = verifyNarrowedTestsRan('some unrelated output\n', ['Some.Test']);
    assert.equal(r.ran, false);
    assert.ok(r.reason);
  });

  it('空清单 → 判为没跑到', () => {
    const r = verifyNarrowedTestsRan('anything', []);
    assert.equal(r.ran, false);
  });

  it('输出里出现被筛选用例名 → 判为跑到了', () => {
    const out = [
      'Test project D:/build',
      '    1/1 Test    #1: Some.Test ......................***Failed    0.42 sec',
      'The following tests FAILED:',
      '        1 - Some.Test (Failed)',
    ].join('\n');
    const r = verifyNarrowedTestsRan(out, ['Some.Test']);
    assert.equal(r.ran, true);
  });

  it('多个用例里命中一个也算跑到', () => {
    const out = 'Test    #2: Second.Test ....***Failed';
    const r = verifyNarrowedTestsRan(out, ['First.Test', 'Second.Test']);
    assert.equal(r.ran, true);
  });
});

describe('ADR-096 · narrowCommandsToFailedTestsByFile', () => {
  it('只收窄同名命令，各自用自己的清单文件', () => {
    const commands = [
      { name: 'build', run: 'cmake --build build' },
      { name: 'test', run: 'cmd /c "ctest --test-dir build"' },
    ];
    const failedByName = new Map([['test', ['A.B', 'C.D']]]);
    const manifestFiles = new Map([['test', 'm-test.txt']]);

    const r = narrowCommandsToFailedTestsByFile(commands, failedByName, manifestFiles);
    assert.ok(r);
    assert.equal(r.commands[0].run, 'cmake --build build', 'build 不该被改');
    assert.ok(r.commands[1].run.includes('--tests-from-file m-test.txt'));
    assert.deepEqual(r.narrowed.get('test'), ['A.B', 'C.D']);
  });

  it('没有历史失败 → null（退回全量）', () => {
    const r = narrowCommandsToFailedTestsByFile(
      [{ name: 'test', run: 'ctest' }],
      new Map(),
      new Map(),
    );
    assert.equal(r, null);
  });

  it('命令带了过滤参数 → 一条都没收窄 → null', () => {
    const r = narrowCommandsToFailedTestsByFile(
      [{ name: 'test', run: 'ctest -R foo' }],
      new Map([['test', ['A.B']]]),
      new Map([['test', 'm.txt']]),
    );
    assert.equal(r, null);
  });
});

describe('ADR-096 · 清单文件实写实读（端到端）', () => {
  let dir: string;

  before(async () => {
    dir = join(tmpdir(), `zelto-adr096-${Date.now()}`);
    await mkdir(dir, { recursive: true });
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('清单文件内容就是精确用例名，一行一个', async () => {
    const file = join(dir, '.zelto-gate-tests-v1.txt');
    await writeFile(file, 'VideoCapture.SwitchDevice\nAudio.TurnTaken\n', 'utf8');
    const content = await readFile(file, 'utf8');
    const names = content.split('\n').map((l) => l.trim()).filter(Boolean);
    assert.deepEqual(names, ['VideoCapture.SwitchDevice', 'Audio.TurnTaken']);
  });

  it('清单文件放在工作目录里（相对路径，避开 Windows 绝对路径的空格）', async () => {
    const file = join(dir, '.zelto-gate-tests-v2.txt');
    await writeFile(file, 'X.Y\n', 'utf8');
    const names = (await readdir(dir)).filter((f) => f.startsWith('.zelto-gate-tests-'));
    assert.ok(names.includes('.zelto-gate-tests-v2.txt'));
  });
});

// ─── 端到端：--rerun-failed 的收窄（用 nimrtc 的真实命令形态）─────────────
//
// 为什么要端到端：单元测试验证的是纯函数，而「收窄后的命令在
// `cmd /c "..."` 里能不能真跑」只有真跑一遍才知道。
//
// 这里复刻 nimrtc-v14 的真实命令形态：
//   cmd /c "ctest --test-dir build --output-on-failure -C Debug"
//
// **跨平台**：Windows 上是 `cmd /c "..."`，POSIX 上是直接执行 `ctest.sh` ——
// `cmd` 在 Linux 上不存在，硬套 Windows 形态会让这条用例在 Linux CI 上
// 永远走不到断言（命令跑不起来 → runner 认不出 ctest → 判 'unknown'）。
// 详见 tests/helpers/ctest-fixture.ts 的说明。
describe('ADR-096 · --rerun-failed 端到端收窄', () => {
  const DIR = join(tmpdir(), `zelto-adr096-e2e-${Date.now()}`);
  const SLICES = join(DIR, '.zelto', 'slices');
  const EVENTS = join(DIR, '.zelto', 'events');
  const WORKER = join(DIR, 'worker.cjs');
  // ctest 的替身：按平台给出真实的可执行形态与命令形态。
  let fixture: CtestFixture;
  let REAL_CMD: string;

  before(async () => {
    await mkdir(SLICES, { recursive: true });
    await mkdir(EVENTS, { recursive: true });
    await writeFile(
      WORKER,
      [
        "const fs = require('fs');",
        'const args = process.argv.slice(2);',
        "const idx = args.indexOf('--tests-from-file');",
        "let names = ['Foo.A', 'Foo.B'];",
        'if (idx >= 0 && args[idx + 1]) {',
        "  names = fs.readFileSync(args[idx + 1], 'utf8').split('\\n').map(s => s.trim()).filter(Boolean);",
        '}',
        'const failed = names[names.length - 1];',
        "const lines = ['Test project /x'];",
        'for (const n of names) {',
        "  lines.push('   1/' + names.length + ' Test    #1: ' + n + ' ... Passed 0.01 sec');",
        '}',
        "lines.push('   2/' + names.length + ' Test    #2: ' + failed + ' ...***Failed 0.02 sec');",
        "lines.push('The following tests FAILED:');",
        "lines.push('        2 - ' + failed + ' (Failed)');",
        "console.log(lines.join('\\n'));",
        'process.exit(8);',
        '',
      ].join('\n'),
      'utf-8',
    );
    fixture = createCtestFixture(
      DIR,
      'worker.cjs',
      '--test-dir build --output-on-failure -C Debug',
    );
    REAL_CMD = fixture.command;
  });

  after(async () => {
    await rm(DIR, { recursive: true, force: true });
  });

  it('第一轮全量失败 → 第二轮命令被收窄（--tests-from-file 插进 cmd /c 引号内）', async () => {
    const store = new SliceStore(SLICES);
    const events = new EventStream(EVENTS);

    const slice = store.create('e2e-096', 'e2e');
    slice.state = 'frozen';
    slice.spec.frozenHash = 'h';
    slice.spec.frozenAt = new Date().toISOString();
    await store.write(slice);

    // 第一轮：全量，失败
    const cfg: GateConfig = {
      commands: [{ name: 'test', run: REAL_CMD }],
      timeoutSec: 30,
      retry: { max: 0, budgetStepUsd: 0.05 },
    };
    const exec = new GateExecutor(store, events, cfg, DIR);
    const r1 = await exec.execute('e2e-096');
    assert.equal(r1.passed, false);
    assert.equal(r1.results[0].runner, 'ctest', '应认出 ctest 运行器');
    assert.deepEqual(r1.results[0].failures?.map((f) => f.test), ['Foo.B']);

    // 第二轮：--rerun-failed --dry-run，看命令被改成什么样
    const ctx = {
      store,
      events,
      actor: 'cli',
      via: 'cli',
      repoRoot: DIR,
    };
    const out = await runGate(
      ctx,
      'e2e-096',
      {
        commands: [{ name: 'test', run: REAL_CMD }],
        timeoutSec: 30,
        retryMax: 0,
        gateRoot: DIR,
        requestSign: false,
      },
      { rerunFailed: true, dryRun: true },
    );

    const cmds = out.facts?.commands as Array<{ name: string; run: string }>;
    assert.ok(cmds && cmds.length === 1);
    const run2 = cmds[0].run;
    // 收窄参数必须插在**正确的位置** —— 各平台的「正确位置」不同，
    // 但判据的严格程度相同（见 helpers/ctest-fixture.ts）。
    fixture.assertNarrowedInPlace(run2);
  });

  it('dry-run 之后不留残留清单文件', async () => {
    const store = new SliceStore(SLICES);
    const events = new EventStream(EVENTS);

    const slice = store.create('e2e-096b', 'e2e');
    slice.state = 'frozen';
    slice.spec.frozenHash = 'h';
    slice.spec.frozenAt = new Date().toISOString();
    await store.write(slice);

    const cfg: GateConfig = {
      commands: [{ name: 'test', run: REAL_CMD }],
      timeoutSec: 30,
      retry: { max: 0, budgetStepUsd: 0.05 },
    };
    await new GateExecutor(store, events, cfg, DIR).execute('e2e-096b');

    await runGate(
      { store, events, actor: 'cli', via: 'cli', repoRoot: DIR },
      'e2e-096b',
      {
        commands: [{ name: 'test', run: REAL_CMD }],
        timeoutSec: 30,
        retryMax: 0,
        gateRoot: DIR,
        requestSign: false,
      },
      { rerunFailed: true, dryRun: true },
    );

    const left = (await readdir(DIR)).filter((f) => f.startsWith('.zelto-gate-tests-'));
    assert.deepEqual(left, [], `不该留残留清单文件，实际：${left.join(', ')}`);
  });
});
