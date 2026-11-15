// ADR-065：vendor 目录（引入的外部代码）是架构的**外部边界**
//
// 真实项目实测（nimrtc-zelto）：
//   `src/third_party` 11943 个文件 / 4434 个代码文件
//   占全项目代码文件的 **97%**
//
// 三个后果：
//   1. **淹没信号** —— 5 条「未声明依赖 → src/third_party」是噪音
//   2. **统计失真** —— 「已验证 4481 个 C++ 文件」听起来像整个项目都验过了
//   3. **不是人的设计决策** —— opus 内部依赖 wolfssl，那是 opus 的设计
//
// 决策：vendor 目录**不参与依赖图**，但**计入覆盖率**并单独报出来。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanArchitecture, discoverVendorDirs, isVendorPath } from '../src/core/arch/scan.js';
import { buildArchitectureReport } from '../src/core/arch/report.js';
import type { ModuleSpec } from '../src/core/arch/types.js';

describe('ADR-065：vendor 目录是外部边界', () => {
  const TEST_DIR = mkdtempSync(join(tmpdir(), 'zelto-arch-vendor-'));

  const MODULES: ModuleSpec[] = [
    { name: 'src/core', description: '核心', filePatterns: ['src/core/**/*'], dependencies: [] },
    {
      name: 'src/app',
      description: '应用',
      filePatterns: ['src/app/**/*'],
      dependencies: ['src/core'],
    },
    {
      name: 'src/third_party',
      description: '第三方库集成',
      filePatterns: ['src/third_party/**/*'],
      dependencies: [],
    },
  ];

  function write(rel: string, content: string): void {
    const full = join(TEST_DIR, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf-8');
  }

  before(() => {
    // 项目自己的代码
    write('src/core/include/nimrtc/core/log.hpp', '#pragma once\nnamespace nimrtc::core {}\n');
    write('src/app/src/app.cpp', '#include "nimrtc/core/log.hpp"\nint main() { return 0; }\n');

    // vendor 代码：项目代码 include 了它
    write('src/third_party/libfoo/include/libfoo/foo.hpp', '#pragma once\nnamespace libfoo {}\n');
    write('src/third_party/libfoo/src/foo.cpp', '#include "libfoo/foo.hpp"\nnamespace libfoo {}\n');
    // vendor 代码内部还有自己的依赖（不是项目的设计决策）
    write('src/third_party/libfoo/src/bar.cpp', '#include "libfoo/foo.hpp"\nnamespace libfoo {}\n');
  });

  after(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('vendor 目录识别', () => {
    it('发现约定名的目录', () => {
      const dirs = discoverVendorDirs(TEST_DIR);
      assert.deepEqual(dirs, ['src/third_party']);
    });

    it('路径归属判定', () => {
      const dirs = ['src/third_party'];
      assert.equal(isVendorPath('src/third_party/libfoo/src/foo.cpp', dirs), true);
      assert.equal(isVendorPath('src/third_party', dirs), true);
      assert.equal(isVendorPath('src/core/log.hpp', dirs), false);
      // 同前缀但不是子路径 —— 不算 vendor
      assert.equal(isVendorPath('src/third_party_extra/x.cpp', dirs), false);
    });
  });

  describe('依赖图：vendor 不参与', () => {
    it('vendor 文件不被模块认领', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      const vendorFile = scan.files.find((f) => f.path.includes('third_party'));
      assert.equal(vendorFile, undefined, 'vendor 文件不该出现在已扫描文件里');
    });

    it('vendor 模块被识别出来', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      assert.deepEqual(scan.vendorModules, ['src/third_party']);
      assert.deepEqual(scan.vendorDirs, ['src/third_party']);
    });

    it('项目代码 → vendor 的边不产生', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      const edge = scan.edges.find((e) => e.to === 'src/third_party');
      assert.equal(edge, undefined, '「用了第三方库」不是架构耦合，不该有边');
    });

    it('vendor 目录里的文件被单独计数', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      // vendor 里有 3 个文件：foo.hpp / foo.cpp / bar.cpp
      assert.equal(scan.vendorFiles.length, 3);
      assert.equal(scan.coverage.vendorFiles, 3);
    });
  });

  describe('报告：vendor 不产生偏离', () => {
    it('不报「未声明依赖 → vendor」', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      const report = buildArchitectureReport(MODULES, scan);
      const toVendor = report.deviations.filter(
        (d) => d.to === 'src/third_party' && d.kind === 'undeclared_dependency',
      );
      assert.equal(toVendor.length, 0, '不该报「未声明依赖 → vendor」');
    });

    it('不报「缺失依赖 → vendor」', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      const report = buildArchitectureReport(MODULES, scan);
      const missing = report.deviations.filter(
        (d) => d.to === 'src/third_party' && d.kind === 'missing_dependency',
      );
      assert.equal(missing.length, 0, '第三方库当然存在，不该报缺失依赖');
    });

    it('vendor 模块不报「模块无文件」', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      const report = buildArchitectureReport(MODULES, scan);
      const empty = report.deviations.filter(
        (d) => d.kind === 'empty_module' && d.from === 'src/third_party',
      );
      assert.equal(empty.length, 0, 'vendor 模块「0 个文件」是正常的');
    });

    it('vendor 模块在概况里被标出来', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      const report = buildArchitectureReport(MODULES, scan);
      const vendor = report.modules.find((m) => m.name === 'src/third_party');
      assert.ok(vendor);
      assert.equal(vendor.isVendor, true);
      const core = report.modules.find((m) => m.name === 'src/core');
      assert.equal(core?.isVendor, undefined);
    });

    it('报告里带上 vendor 目录与模块', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      const report = buildArchitectureReport(MODULES, scan);
      assert.deepEqual(report.vendorDirs, ['src/third_party']);
      assert.deepEqual(report.vendorModules, ['src/third_party']);
    });
  });

  describe('覆盖率：vendor 单独计数，不混进语言类别', () => {
    it('C++ 文件数不含 vendor', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      // 项目自己的 C++：log.hpp + app.cpp = 2 个
      // vendor 里的 3 个（foo.hpp / foo.cpp / bar.cpp）不该混进来
      const cppCount = scan.coverage.counts.cpp;
      assert.equal(cppCount, 2, 'vendor 的 C++ 文件不该混进语言类别计数');
      assert.equal(scan.coverage.vendorFiles, 3);
    });
  });

  describe('反向：没有 vendor 目录时行为不变', () => {
    const PLAIN_DIR = mkdtempSync(join(tmpdir(), 'zelto-arch-plain-'));

    before(() => {
      const full = join(PLAIN_DIR, 'src/core/include/nimrtc/core/log.hpp');
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, '#pragma once\nnamespace nimrtc::core {}\n', 'utf-8');
    });

    after(() => {
      rmSync(PLAIN_DIR, { recursive: true, force: true });
    });

    it('没有 vendor 目录', () => {
      const dirs = discoverVendorDirs(PLAIN_DIR);
      assert.deepEqual(dirs, []);
    });

    it('vendor 模块列表为空', () => {
      const scan = scanArchitecture(PLAIN_DIR, [
        { name: 'src/core', description: '核心', filePatterns: ['src/core/**/*'], dependencies: [] },
      ]);
      assert.deepEqual(scan.vendorModules, []);
      assert.equal(scan.coverage.vendorFiles, 0);
    });
  });
});
