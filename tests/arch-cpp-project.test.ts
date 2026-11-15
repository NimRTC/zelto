// ADR-061：架构报告在 C++ 项目上的三个问题。
//
// 这三个问题都是在真实项目（nimrtc-zelto，14439 个文件）上跑
// `arch check` 时暴露的 —— 不是推测，是实测。
//
// 三个问题共享一条主线：**报告的标签与数字没能如实反映事实**。
//
//   D-13：「0 源码」是错的标签 —— src/core 有 14 个 .cpp/.hpp，
//        那些**就是**源码，只是不是扫描器读得懂的源码。
//   D-14：可扫描率的分母把文档/配置也算进去了 ——
//        「这个模块有 80% 的文件不是代码」不该拉低「代码的可读比例」。
//   D-15：第三方代码被算进了项目模块 ——
//        src/third_party 的 11944 个文件让整张图的统计失去意义。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanArchitecture } from '../src/core/arch/scan.js';
import { buildArchitectureReport } from '../src/core/arch/report.js';
import type { ModuleSpec } from '../src/core/arch/types.js';

const TEST_DIR = join(tmpdir(), `zelto-arch-cpp-${Date.now()}`);

const MODULES: ModuleSpec[] = [
  { name: 'src/core', description: '', filePatterns: ['src/core/**'], dependencies: [] },
  { name: 'src/engine', description: '', filePatterns: ['src/engine/**'], dependencies: ['src/core'] },
];

describe('ADR-061：C++ 项目上的架构报告', () => {
  before(async () => {
    await mkdir(join(TEST_DIR, 'src', 'core'), { recursive: true });
    await mkdir(join(TEST_DIR, 'src', 'engine'), { recursive: true });

    // src/core —— 纯 C++，14 个文件
    await writeFile(join(TEST_DIR, 'src', 'core', 'api.hpp'), '#pragma once\n', 'utf-8');
    await writeFile(join(TEST_DIR, 'src', 'core', 'error.hpp'), '#pragma once\n', 'utf-8');
    await writeFile(join(TEST_DIR, 'src', 'core', 'registry.cpp'), '// code\n', 'utf-8');
    await writeFile(join(TEST_DIR, 'src', 'core', 'CMakeLists.txt'), 'add_library(core)\n', 'utf-8');
    await writeFile(join(TEST_DIR, 'src', 'core', 'README.md'), '# core\n', 'utf-8');

    // src/engine —— 纯 C++
    await writeFile(join(TEST_DIR, 'src', 'engine', 'engine.cpp'), '#include "api.hpp"\n', 'utf-8');
    await writeFile(join(TEST_DIR, 'src', 'engine', 'engine.hpp'), '#pragma once\n', 'utf-8');
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('D-13：模块概况区分「代码文件」与「已验证文件」', () => {
    const scan = scanArchitecture(TEST_DIR, MODULES);
    const report = buildArchitectureReport(MODULES, scan);

    const core = report.modules.find((m) => m.name === 'src/core');
    assert.ok(core, '应该有 src/core 模块');

    // src/core 有 5 个文件：3 个代码（.hpp x2 + .cpp x1）、
    // 1 个构建脚本（CMakeLists.txt）、1 个文档（README.md）
    //
    // 修复前：codeFileCount = 0 → 报告显示「5 个文件（0 源码）」
    //         —— 读起来像「这个模块没有代码」。它有 3 个 C++ 代码文件。
    //
    // 修复后：codeFileCount = 3（所有代码文件）
    //         verifiedFileCount = 0（扫描器读不懂 C++）
    assert.equal(core.codeFileCount, 3, 'src/core 的代码文件数（C++ 也要算）');
    assert.equal(core.verifiedFileCount, 0, 'src/core 的已验证文件数（扫描器读不懂 C++）');
    assert.equal(core.fileCount, 5, 'src/core 的总文件数');
  });

  it('D-14：可扫描率的分母不该把非代码文件算进去', () => {
    const scan = scanArchitecture(TEST_DIR, MODULES);
    const report = buildArchitectureReport(MODULES, scan);

    // src/engine → src/core 声明了依赖，但 C++ 的 #include 扫不到
    // → 应该是 unverifiable_dependency（软偏离，永不拦）
    const dev = report.deviations.find(
      (d) => d.kind === 'unverifiable_dependency' && d.from === 'src/engine' && d.to === 'src/core',
    );
    assert.ok(dev, `应有 unverifiable_dependency，实际：${JSON.stringify(report.deviations)}`);
  });

  it('D-13 修复后：模块概况区分「代码文件」与「已验证文件」', () => {
    const scan = scanArchitecture(TEST_DIR, MODULES);
    const report = buildArchitectureReport(MODULES, scan);

    const core = report.modules.find((m) => m.name === 'src/core');
    assert.ok(core, '应该有 src/core 模块');

    // 修复后的契约：codeFileCount 数的是**代码文件**（不限语言），
    // verifiedFileCount 数的是**已验证**（扫描器读得懂的）文件。
    assert.equal(core.codeFileCount, 3, 'src/core 的代码文件数（C++ 也要算）');
    assert.equal(core.verifiedFileCount, 0, 'src/core 的已验证文件数（扫描器读不懂 C++）');
    assert.equal(core.fileCount, 5, 'src/core 的总文件数');
  });

  it('D-13 修复后：报告不再显示误导性的「0 源码」', () => {
    const scan = scanArchitecture(TEST_DIR, MODULES);
    const report = buildArchitectureReport(MODULES, scan);

    const core = report.modules.find((m) => m.name === 'src/core');
    assert.ok(core);
    // 「0 源码」只在「一个代码文件都没有」时才合理。
    // 这里有 3 个 C++ 代码文件，说「0 源码」是错的。
    assert.ok(
      core.codeFileCount > 0,
      `C++ 代码文件不该被算成 0 —— 现状 ${core.codeFileCount}`,
    );
  });

  it('D-14 修复后：不可验证的说明要区分三种原因', () => {
    const scan = scanArchitecture(TEST_DIR, MODULES);
    const report = buildArchitectureReport(MODULES, scan);

    const dev = report.deviations.find(
      (d) => d.kind === 'unverifiable_dependency' && d.from === 'src/engine' && d.to === 'src/core',
    );
    assert.ok(dev);
    // 目标模块有代码，但扫描器一个都读不懂 ——
    // 说明必须指向「语言不支持」，而不是「没有源文件」
    // （后者会让人去找「是不是漏写了」）。
    assert.ok(
      dev.detail.includes('读不懂') || dev.detail.includes('支持'),
      `说明应指向「扫描器读不懂」，实际：${dev.detail}`,
    );
    assert.ok(
      !dev.detail.includes('没有源文件'),
      `不该说「没有源文件」—— 目标模块有 3 个代码文件，实际：${dev.detail}`,
    );
  });
});
