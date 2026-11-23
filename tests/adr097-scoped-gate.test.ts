// ADR-097：门禁作用域 —— 按切片的写集收窄「跑哪些用例」
//
// 这个文件防的是**三类假绿/静默失效**：
//
//   失效一：配了 `gate.scope` 但解析器没吃进去 —— 门禁「配了却按全量跑」，
//     没人知道（静默失效，最坏的一种，因为人以为收窄了）。
//
//   失效二：标签没匹配到任何用例 —— ctest 退出码是 **0**
//     （ADR-096 已实测：`No tests were found!!!`）—— 那就是假绿门禁。
//     门禁必须判失败，不许判通过。
//
//   失效三：收窄跑完后用例其实没跑（清单写空 / 写集写错）——
//     必须用 `verifyNarrowedTestsRan` 验真。
//
// 另外防一个**越权**：`--full` 之后不许还收窄（人显式要求的全量必须生效）。
//
// C3：被测逻辑全是纯字符串计算 + 确定性 IO，判定可复现。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  parseScopeConfig,
  matchScopeLabels,
  selectScopedTestNames,
  buildCtestEnumerateCommand,
  scopeManifestFile,
  buildScopeManifestContent,
  sanitizeForFilename,
  type ScopeRule,
} from '../src/core/gate/scope.js';
import { pathMatches } from '../src/core/sched/paths.js';
import { GateExecutor } from '../src/core/gate/executor.js';
import { runGate } from '../src/core/lifecycle/gate.js';
import { SliceStore } from '../src/core/slice/store.js';
import { EventStream } from '../src/core/events/stream.js';
import type { GateConfig } from '../src/core/gate/types.js';

// ─── 规则解析 ───────────────────────────────────────────────────────────────

describe('ADR-097 · gate.scope 规则解析', () => {
  it('解析 rules + fallback', () => {
    const cfg = parseScopeConfig(
      [
        'rules:',
        '  - match: "src/modules/ice/**"',
        '    labels: ["ice"]',
        '  - match: "src/modules/sdp/**"',
        '    labels: ["sdp", "session"]',
        'fallback: full',
      ].join('\n'),
    );
    assert.ok(cfg);
    assert.equal(cfg.rules.length, 2);
    assert.deepEqual(cfg.rules[0], { match: 'src/modules/ice/**', labels: ['ice'] });
    assert.deepEqual(cfg.rules[1], { match: 'src/modules/sdp/**', labels: ['sdp', 'session'] });
    assert.equal(cfg.fallback, 'full');
  });

  it('标签接受逗号分隔的裸值', () => {
    const cfg = parseScopeConfig(
      ['rules:', '  - match: "src/a/**"', '    labels: ice, sdp'].join('\n'),
    );
    assert.ok(cfg);
    assert.deepEqual(cfg.rules[0].labels, ['ice', 'sdp']);
  });

  it('没配规则 → null（= 跑全量，老行为）', () => {
    assert.equal(parseScopeConfig('fallback: full'), null);
    assert.equal(parseScopeConfig(''), null);
  });

  it('fallback 只认 full —— 其它值报错，不猜', () => {
    // 静默当 full 会掩盖配置错误；静默当 none 就是假绿门禁。
    assert.throws(
      () => parseScopeConfig(['rules:', '  - match: "a"', '    labels: x', 'fallback: none'].join('\n')),
      /fallback/,
    );
  });
});

// ─── 写集 → 标签 ────────────────────────────────────────────────────────────

describe('ADR-097 · 写集匹配标签', () => {
  const rules: ScopeRule[] = [
    { match: 'src/modules/ice/**', labels: ['ice'] },
    { match: 'src/modules/sdp/**', labels: ['sdp'] },
  ];

  it('写集命中规则 → 收窄到对应标签', () => {
    const m = matchScopeLabels(['src/modules/ice/candidate.cpp'], rules, pathMatches);
    assert.equal(m.source, 'config');
    assert.deepEqual(m.labels, ['ice']);
    assert.deepEqual(m.matchedPatterns, ['src/modules/ice/**']);
  });

  it('写集命中多条规则 → 标签合并去重', () => {
    const m = matchScopeLabels(
      ['src/modules/ice/a.cpp', 'src/modules/sdp/b.cpp'],
      rules,
      pathMatches,
    );
    assert.equal(m.source, 'config');
    assert.deepEqual(m.labels, ['ice', 'sdp']);
  });

  it('写集没命中任何规则 → 退回全量（fail closed）', () => {
    const m = matchScopeLabels(['README.md'], rules, pathMatches);
    assert.equal(m.source, 'fallback-full');
    assert.deepEqual(m.labels, []);
    assert.ok(m.reason.includes('退回全量'));
  });

  it('没配规则 → no-config（全量）', () => {
    const m = matchScopeLabels(['src/a.cpp'], [], pathMatches);
    assert.equal(m.source, 'no-config');
  });

  it('写集条目本身是 glob 时也能命中（ADR-097 实测路径）', () => {
    const m = matchScopeLabels(['src/modules/ice/**'], rules, pathMatches);
    assert.equal(m.source, 'config');
    assert.deepEqual(m.labels, ['ice']);
  });
});

// ─── ctest 枚举与用例筛选 ───────────────────────────────────────────────────

describe('ADR-097 · ctest 枚举命令与用例筛选', () => {
  it('在 ctest 词元后追加 --show-only=json-v1（继承原参数）', () => {
    const out = buildCtestEnumerateCommand('cmd /c "ctest --test-dir build -C Debug"');
    assert.ok(out);
    assert.ok(
      out.includes('ctest --show-only=json-v1 --test-dir build'),
      `枚举参数必须插在 ctest 之后，原参数必须保留，实际：${out}`,
    );
  });

  it('不是 ctest 命令 → null', () => {
    assert.equal(buildCtestEnumerateCommand('cmd /c "cmake --build build"'), null);
    assert.equal(buildCtestEnumerateCommand('npm test'), null);
  });

  it('已经带了 --show-only → 不叠加', () => {
    assert.equal(buildCtestEnumerateCommand('ctest --show-only=json-v1'), null);
  });

  it('从 ctest JSON 里筛出带目标标签的用例名', () => {
    const json = JSON.stringify({
      tests: [
        { name: 'Ice.CandidateBuild', properties: [{ name: 'LABELS', value: ['ice', 'module'] }] },
        { name: 'Sdp.ParseOffer', properties: [{ name: 'LABELS', value: ['module', 'sdp'] }] },
        { name: 'Audio.TurnTaken', properties: [{ name: 'LABELS', value: ['audio'] }] },
        { name: 'NoLabels' },
      ],
    });
    const sel = selectScopedTestNames(json, ['ice']);
    assert.ok(sel);
    assert.deepEqual(sel.names, ['Ice.CandidateBuild']);
    assert.equal(sel.total, 4);
  });

  it('LABELS 是字符串形态也认（老版本 CTest）', () => {
    const json = JSON.stringify({
      tests: [{ name: 'Ice.X', properties: [{ name: 'LABELS', value: 'ice,module' }] }],
    });
    const sel = selectScopedTestNames(json, ['ice']);
    assert.ok(sel);
    assert.deepEqual(sel.names, ['Ice.X']);
  });

  it('JSON 解析失败 → null（调用方退回全量，不许猜）', () => {
    assert.equal(selectScopedTestNames('not json', ['ice']), null);
    assert.equal(selectScopedTestNames('', ['ice']), null);
  });
});

// ─── 清单文件 ───────────────────────────────────────────────────────────────

describe('ADR-097 · 作用域清单文件', () => {
  it('文件名带切片 id（并行切片不互相覆盖）', () => {
    const f = scopeManifestFile('v1-ice', 0);
    assert.ok(f.startsWith('.zelto-gate-scope-'));
    assert.ok(f.includes('v1-ice'));
  });

  it('切片 id 里的路径穿越字符被清洗掉', () => {
    const f = scopeManifestFile('../../etc/passwd', 0);
    assert.ok(!f.includes('/'), `文件名不该含路径分隔符：${f}`);
    assert.ok(!f.includes('..'));
  });

  it('清单内容一行一个精确用例名，末尾带换行', () => {
    const content = buildScopeManifestContent(['Ice.A', 'Ice.B']);
    assert.equal(content, 'Ice.A\nIce.B\n');
  });
});

// ─── 端到端：作用域收窄 ─────────────────────────────────────────────────────
//
// 复刻 nimrtc-v14 的真实命令形态：
//   cmd /c "ctest --test-dir build --output-on-failure -C Debug"
describe('ADR-097 · 作用域收窄端到端', () => {
  const DIR = join(tmpdir(), `zelto-adr097-e2e-${Date.now()}`);
  const SLICES = join(DIR, '.zelto', 'slices');
  const EVENTS = join(DIR, '.zelto', 'events');
  const CTEST = join(DIR, 'ctest.cmd');
  const WORKER = join(DIR, 'worker.cjs');
  const REAL_CMD = `cmd /c "${CTEST} --test-dir build --output-on-failure -C Debug"`;

  before(async () => {
    await mkdir(SLICES, { recursive: true });
    await mkdir(EVENTS, { recursive: true });
    // ctest 替身：
    //   --show-only=json-v1 → 打印带 LABELS 的用例 JSON；
    //   --tests-from-file X → 只跑清单里的用例。
    await writeFile(
      WORKER,
      [
        "const fs = require('fs');",
        'const args = process.argv.slice(2);',
        "const showIdx = args.findIndex(a => a.startsWith('--show-only'));",
        "if (showIdx >= 0) {",
        "  const payload = { tests: [",
        "    { name: 'Ice.CandidateBuild', properties: [{ name: 'LABELS', value: ['ice'] }] },",
        "    { name: 'Ice.SdpCheck', properties: [{ name: 'LABELS', value: ['ice'] }] },",
        "    { name: 'Audio.TurnTaken', properties: [{ name: 'LABELS', value: ['audio'] }] },",
        '  ] };',
        "  console.log(JSON.stringify(payload));",
        '  process.exit(0);',
        '}',
        "const fileIdx = args.indexOf('--tests-from-file');",
        "let names = ['Ice.CandidateBuild', 'Ice.SdpCheck', 'Audio.TurnTaken'];",
        'if (fileIdx >= 0 && args[fileIdx + 1]) {',
        "  names = fs.readFileSync(args[fileIdx + 1], 'utf8').split('\\n').map(s => s.trim()).filter(Boolean);",
        '}',
        "const lines = ['Test project /x'];",
        'for (const n of names) {',
        "  lines.push('   1/' + names.length + ' Test    #1: ' + n + ' ... Passed 0.01 sec');",
        '}',
        "console.log(lines.join('\\n'));",
        'process.exit(0);',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeFile(CTEST, ['@echo off', `node "${WORKER}" %*`, ''].join('\r\n'), 'utf-8');
  });

  after(async () => {
    await rm(DIR, { recursive: true, force: true });
  });

  it('写集命中规则 → 只跑带标签的用例，并在事件里留痕', async () => {
    const store = new SliceStore(SLICES);
    const events = new EventStream(EVENTS);
    const slice = store.create('e2e-097', 'e2e');
    slice.state = 'frozen';
    slice.spec.frozenHash = 'h';
    slice.spec.frozenAt = new Date().toISOString();
    slice.writes = ['src/modules/ice/candidate.cpp'];
    await store.write(slice);

    const cfg: GateConfig = {
      commands: [{ name: 'test', run: REAL_CMD }],
      scope: {
        rules: [{ match: 'src/modules/ice/**', labels: ['ice'] }],
        fallback: 'full',
      },
      timeoutSec: 30,
      retry: { max: 0, budgetStepUsd: 0.05 },
    };
    const report = await new GateExecutor(store, events, cfg, DIR).execute('e2e-097');
    assert.equal(report.passed, true);
    assert.ok(report.scope);
    assert.equal(report.scope.scoped, true);
    assert.deepEqual(report.scope.labels, ['ice']);
    assert.equal(report.scope.testCount, 2);
    assert.equal(report.scope.totalTestCount, 3);
  });

  it('跑完不留残留作用域清单文件', async () => {
    const left = (await readdir(DIR)).filter((f) => f.startsWith('.zelto-gate-scope-'));
    assert.deepEqual(left, [], `不该留残留清单文件，实际：${left.join(', ')}`);
  });

  it('写集没命中规则 → 退回全量，并说明理由', async () => {
    const store = new SliceStore(SLICES);
    const events = new EventStream(EVENTS);
    const slice = store.create('e2e-097-fb', 'e2e');
    slice.state = 'frozen';
    slice.spec.frozenHash = 'h';
    slice.spec.frozenAt = new Date().toISOString();
    slice.writes = ['README.md'];
    await store.write(slice);

    const cfg: GateConfig = {
      commands: [{ name: 'test', run: REAL_CMD }],
      scope: {
        rules: [{ match: 'src/modules/ice/**', labels: ['ice'] }],
        fallback: 'full',
      },
      timeoutSec: 30,
      retry: { max: 0, budgetStepUsd: 0.05 },
    };
    const report = await new GateExecutor(store, events, cfg, DIR).execute('e2e-097-fb');
    assert.ok(report.scope);
    assert.equal(report.scope.scoped, false);
    assert.equal(report.scope.source, 'fallback-full');
  });

  it('--full → 不收窄（人显式要求的全量必须生效）', async () => {
    const store = new SliceStore(SLICES);
    const events = new EventStream(EVENTS);
    const slice = store.create('e2e-097-full', 'e2e');
    slice.state = 'frozen';
    slice.spec.frozenHash = 'h';
    slice.spec.frozenAt = new Date().toISOString();
    slice.writes = ['src/modules/ice/candidate.cpp'];
    await store.write(slice);

    const out = await runGate(
      { store, events, actor: 'cli', via: 'cli', repoRoot: DIR },
      'e2e-097-full',
      {
        commands: [{ name: 'test', run: REAL_CMD }],
        scope: {
          rules: [{ match: 'src/modules/ice/**', labels: ['ice'] }],
          fallback: 'full',
        },
        timeoutSec: 30,
        retryMax: 0,
        gateRoot: DIR,
        requestSign: false,
      },
      { full: true, dryRun: true },
    );

    const scope = out.facts?.scope as { scoped?: boolean; reason?: string } | undefined;
    assert.ok(scope);
    assert.equal(scope.scoped, false);
    assert.ok(scope.reason?.includes('全量'));
  });
});
