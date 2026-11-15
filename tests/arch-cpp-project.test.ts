// ADR-061：C++ 项目上的架构报告 —— 「代码」与「扫描器读得懂」要分开。
//
// 这三个问题都是在真实项目（nimrtc-zelto，14439 个文件）上跑
// `arch check` 时暴露的 —— 不是推测，是实测。
//
//   D-13：「0 源码」是错的标签 —— src/core 有 13 个 .cpp/.hpp，
//        那些**就是**源码，只是不是扫描器读得懂的源码。
//   D-14：可扫描率的分母把文档/配置也算进去了 ——
//        「这个模块有 80% 的文件不是代码」不该拉低「代码的可读比例」。
//   D-15：不可验证的说明只有一句话，把人引向错误的方向。
//
// 注：ADR-062 起 C/C++ 也参与 import 图了（`#include` 语义已支持），
// 所以这些用例改用 **Go / Rust** 作为「有代码但验不了」的代表 ——
// 「代码」与「已验证」必须分开这一点不变。
//
// C3: 纯计算，不调模型、不触网

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanArchitecture } from '../src/core/arch/scan.js';
import { buildArchitectureReport } from '../src/core/arch/report.js';
import type { ModuleSpec } from '../src/core/arch/types.js';

const TEST_DIR = join(tmpdir(), `zelto-arch-lang-split-${Date.now()}`);

const MODULES: ModuleSpec[] = [
  { name: 'src/core', description: '', filePatterns: ['src/core/**'], dependencies: [] },
  {
    name: 'src/engine',
    description: '',
    filePatterns: ['src/engine/**'],
    dependencies: ['src/core'],
  },
];

describe('ADR-061：「代码」与「扫描器读得懂」要分开', () => {
  before(async () => {
    await mkdir(join(TEST_DIR, 'src', 'core'), { recursive: true });
    await mkdir(join(TEST_DIR, 'src', 'engine'), { recursive: true });

    // src/core —— Go / Rust 代码（扫描器读不懂）+ 文档 + 配置
    await writeFile(join(TEST_DIR, 'src', 'core', 'api.go'), 'package core\n', 'utf-8');
    await writeFile(join(TEST_DIR, 'src', 'core', 'lib.rs'), 'pub fn f() {}\n', 'utf-8');
    await writeFile(join(TEST_DIR, 'src', 'core', 'README.md'), '# core\n', 'utf-8');
    await writeFile(join(TEST_DIR, 'src', 'core', 'config.json'), '{}\n', 'utf-8');

    // src/engine —— TypeScript（扫描器读得懂）
    await writeFile(join(TEST_DIR, 'src', 'engine', 'main.ts'), "import '../core/api';\n", 'utf-8');

    // src/mixed —— 2 个 TS + 8 个文档（分母差异在它身上显形）
    await mkdir(join(TEST_DIR, 'src', 'mixed'), { recursive: true });
    await writeFile(join(TEST_DIR, 'src', 'mixed', 'a.ts'), 'export const a = 1;\n', 'utf-8');
    await writeFile(join(TEST_DIR, 'src', 'mixed', 'b.ts'), 'export const b = 2;\n', 'utf-8');
    for (let i = 0; i < 8; i++) {
      await writeFile(join(TEST_DIR, 'src', 'mixed', `doc${i}.md`), `# doc\n`, 'utf-8');
    }
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('D-13：代码文件数不限语言，Go/Rust 都算代码', () => {
    const scan = scanArchitecture(TEST_DIR, MODULES);
    const report = buildArchitectureReport(MODULES, scan);

    const core = report.modules.find((m) => m.name === 'src/core');
    assert.ok(core, '应该有 src/core 模块');

    // src/core 有 4 个文件：2 个代码（.go + .rs）+ 1 个文档 + 1 个配置
    assert.equal(core.fileCount, 4, 'src/core 的总文件数');
    assert.equal(core.codeFileCount, 2, 'Go 与 Rust 都算「代码」');
  });

  it('D-13：已验证文件数只数扫描器读得懂的', () => {
    const scan = scanArchitecture(TEST_DIR, MODULES);
    const report = buildArchitectureReport(MODULES, scan);

    const core = report.modules.find((m) => m.name === 'src/core');
    assert.ok(core);

    // 修复前：codeFileCount = 0 → 报告显示「4 个文件（0 源码）」
    //         —— 读起来像「这个模块没有代码」。它有 2 个 Go/Rust 代码文件。
    assert.equal(core.verifiedFileCount, 0, 'Go/Rust 扫描器读不懂');
    assert.ok(
      core.codeFileCount > core.verifiedFileCount,
      '「代码」与「已验证」必须是两个数 —— 否则报告会显示误导性的「0 源码」',
    );
  });

  it('D-13：TS 模块的「代码」与「已验证」相等', () => {
    const scan = scanArchitecture(TEST_DIR, MODULES);
    const report = buildArchitectureReport(MODULES, scan);

    const engine = report.modules.find((m) => m.name === 'src/engine');
    assert.ok(engine);
    assert.equal(engine.codeFileCount, 1);
    assert.equal(engine.verifiedFileCount, 1, 'TS 扫描器读得懂 → 代码即已验证');
  });

  it('D-14：可扫描率的分母是代码文件数，不是全部文件', () => {
    const scan = scanArchitecture(TEST_DIR, MODULES);
    const report = buildArchitectureReport(MODULES, scan);

    // src/engine → src/core 声明了依赖，但目标模块的代码扫描器都读不懂
    // → unverifiable_dependency（软偏离，永不拦）
    //
    // 注意：src/core 有 4 个文件但只有 2 个代码文件。
    // 修复前分母用全部文件（4），修复后用代码文件（2）——
    // 两种算法这里都判为不可读懂，所以结果一样。
    // 分母差异在「代码占比高的模块」上才显形（见下一个用例的说明）。
    const dev = report.deviations.find(
      (d) => d.kind === 'unverifiable_dependency' && d.from === 'src/engine' && d.to === 'src/core',
    );
    assert.ok(dev, `应有 unverifiable_dependency，实际：${JSON.stringify(report.deviations)}`);
  });

  it('D-14：文档多的模块不会因为文档而「读不懂」', () => {
    const scan = scanArchitecture(TEST_DIR, MODULES);
    const report = buildArchitectureReport(MODULES, scan);

    // src/engine 是纯 TS（1 个代码文件，0 个非代码文件）
    // src/core 是 Go/Rust（2 个代码文件 + 2 个非代码文件）
    //
    // 如果分母用全部文件，src/core 的可读比例 = 0/4 = 0
    // 如果分母用代码文件，比例 = 0/2 = 0 —— 两者都是 0。
    //
    // 真正的分叉在**有部分可读**的模块：
    // 一个模块 10 个 TS 文件 + 90 个 README，
    // 全部文件分母 → 10/100 = 0.1（判为读不懂，漏放）
    // 代码文件分母 → 10/10 = 1.0（判为读得懂，正确拦）
    //
    // 这里构造那个模块来验证。
    const MIXED_MODULES: ModuleSpec[] = [
      { name: 'src/mixed', description: '', filePatterns: ['src/mixed/**'], dependencies: [] },
    ];

    const mixedScan = scanArchitecture(TEST_DIR, MIXED_MODULES);
    const mixedReport = buildArchitectureReport(MIXED_MODULES, mixedScan);
    const mixed = mixedReport.modules.find((m) => m.name === 'src/mixed');
    assert.ok(mixed);
    assert.equal(mixed.fileCount, 10);
    assert.equal(mixed.codeFileCount, 2);
    assert.equal(mixed.verifiedFileCount, 2, '两个 TS 文件都验过了');
    // 比例 = 2/2 = 1.0 ≥ 0.5 → 可扫描 → 该拦的会拦
    // （修复前：2/10 = 0.2 < 0.5 → 误判为读不懂 → 漏放）
  });
});

describe('ADR-062 §4.5：来源模块没认领到代码文件时，诊断要指向真正的原因', () => {
  const LOG_MODULES: ModuleSpec[] = [
    { name: 'src/core', description: '', filePatterns: ['src/core/**'], dependencies: [] },
    {
      // 路径只写一层 → 代码在 src/log/src/log.cpp 认领不到
      name: 'src/log',
      description: '',
      filePatterns: ['src/log/*'],
      dependencies: ['src/core'],
    },
  ];

  const LOG_DIR = join(tmpdir(), `zelto-arch-log-${Date.now()}`);

  before(async () => {
    await mkdir(join(LOG_DIR, 'src', 'core'), { recursive: true });
    await mkdir(join(LOG_DIR, 'src', 'log', 'src'), { recursive: true });
    await writeFile(join(LOG_DIR, 'src', 'core', 'a.ts'), 'export const a = 1;\n', 'utf-8');
    await writeFile(join(LOG_DIR, 'src', 'log', 'CMakeLists.txt'), 'add_library(log)\n', 'utf-8');
    await writeFile(
      join(LOG_DIR, 'src', 'log', 'src', 'log.cpp'),
      // C++ 语法：用尖括号 include 项目的公共头文件
      '#include <nimrtc/core/a.hpp>\n',
      'utf-8',
    );
    // 项目公共头文件放在 include 根下
    await mkdir(join(LOG_DIR, 'src', 'core', 'include', 'nimrtc', 'core'), { recursive: true });
    await writeFile(
      join(LOG_DIR, 'src', 'core', 'include', 'nimrtc', 'core', 'a.hpp'),
      '#pragma once\n',
      'utf-8',
    );
  });

  after(async () => {
    await rm(LOG_DIR, { recursive: true, force: true });
  });

  it('来源模块没匹配到代码文件时，说明指向「来源模块的路径」', () => {
    const scan = scanArchitecture(LOG_DIR, LOG_MODULES);
    const report = buildArchitectureReport(LOG_MODULES, scan);

    // src/log 只认领到 CMakeLists.txt，没认领到 log.cpp
    const log = report.modules.find((m) => m.name === 'src/log');
    assert.ok(log);
    assert.equal(log.codeFileCount, 0, 'src/log 应该一个代码文件都没认领到');

    const dev = report.deviations.find(
      (d) => d.kind === 'missing_dependency' && d.from === 'src/log' && d.to === 'src/core',
    );
    assert.ok(dev, `应有 missing_dependency，实际：${JSON.stringify(report.deviations)}`);
    // 依赖真实存在（log.cpp import 了 core），但因为源文件没被认领，扫不到
    // → 说明必须指向「来源模块的路径不对」，而不是「代码里没有对应的 import」
    assert.ok(
      dev.detail.includes('来源模块'),
      `说明应指向来源模块，实际：${dev.detail}`,
    );
    assert.ok(
      !dev.detail.includes('代码里没有对应的 import'),
      `不该说「代码里没有对应的 import」—— 依赖真实存在，实际：${dev.detail}`,
    );
  });

  it('来源模块有代码文件时，说明保持原样', () => {
    // 用同一个目录，但模块声明成能认领到代码文件的样子
    const OK_MODULES: ModuleSpec[] = [
      { name: 'src/core', description: '', filePatterns: ['src/core/**'], dependencies: [] },
      {
        // 路径写两层 → 认领到 src/log/src/log.cpp
        name: 'src/log',
        description: '',
        filePatterns: ['src/log/*', 'src/log/**/*'],
        dependencies: ['src/core'],
      },
    ];

    const scan = scanArchitecture(LOG_DIR, OK_MODULES);
    const report = buildArchitectureReport(OK_MODULES, scan);

    const log = report.modules.find((m) => m.name === 'src/log');
    assert.ok(log);
    assert.ok(log.codeFileCount > 0, 'src/log 应该认领到代码文件');

    // 现在依赖扫得到了 → 不该有 missing_dependency
    const dev = report.deviations.find(
      (d) => d.kind === 'missing_dependency' && d.from === 'src/log' && d.to === 'src/core',
    );
    assert.equal(dev, undefined, '认领到代码文件后，依赖就扫得到了，不该再报缺失');
  });
});
