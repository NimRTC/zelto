// ADR-062：C/C++ 的 `#include` 依赖解析。
//
// 调研基于真实项目（nimrtc-zelto）：
//   - 108 条引号 include 里，**72 条是裸文件名**、36 条带目录
//   - 两种形态在同一个项目里并存
//   - 44 个 include 根目录，**全部叫 `include`**
//
// 所以三种解析策略都要有：
//   1. 带目录 → 相对引用文件目录 / include 根
//   2. 裸文件名 → 先引用文件目录（C++ 规范行为），再 include 根
//   3. 尖括号 → 系统头，不产生模块边

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { scanArchitecture, discoverIncludeRoots, resolveCppInclude } from '../src/core/arch/scan.js';
import { buildArchitectureReport } from '../src/core/arch/report.js';
import { parseImports } from '../src/core/arch/imports.js';
import type { ModuleSpec } from '../src/core/arch/types.js';

const TEST_DIR = join(tmpdir(), `zelto-cpp-include-${Date.now()}`);

/**
 * 模块划分照搬真实项目的形状：
 *   src/core/include/nimrtc/core/xxx.hpp   ← 公共头文件在 include 根
 *   src/engine/src/xxx.cpp                  ← 实现文件与内部头文件同目录
 */
const MODULES: ModuleSpec[] = [
  { name: 'src/core', description: '', filePatterns: ['src/core/**'], dependencies: [] },
  {
    name: 'src/engine',
    description: '',
    filePatterns: ['src/engine/**'],
    dependencies: ['src/core'],
  },
];

async function write(rel: string, content: string): Promise<void> {
  const full = join(TEST_DIR, ...rel.split('/'));
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content, 'utf-8');
}

describe('ADR-062：C++ 的 include 解析', () => {
  before(async () => {
    // src/core —— 公共头文件在 include 根下
    await write(
      'src/core/include/nimrtc/core/registry.hpp',
      '#pragma once\nnamespace nimrtc::core {}\n',
    );
    await write('src/core/src/registry.cpp', '#include "nimrtc/core/registry.hpp"\n');

    // src/engine —— 实现文件与内部头文件同目录
    await write('src/engine/src/engine_impl.hpp', '#pragma once\n');
    await write(
      'src/engine/src/engine.cpp',
      [
        '#include "engine_impl.hpp"',
        '#include "nimrtc/core/registry.hpp"',
        // 尖括号指向**项目内部**头文件 —— 真实项目里这种用法占尖括号 include 的 40%
        '#include <nimrtc/core/registry.hpp>',
        '#include <mutex>',
        '#include <vector>',
        '',
        'void engine_main() {}',
      ].join('\n'),
    );
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  describe('include 根目录的发现', () => {
    it('按目录名发现 include 根（约定法）', () => {
      const roots = discoverIncludeRoots(TEST_DIR);
      assert.deepEqual(roots, ['src/core/include']);
    });

    it('include 根按字典序（确定性，C3）', () => {
      const roots = discoverIncludeRoots(TEST_DIR);
      const sorted = [...roots].sort();
      assert.deepEqual(roots, sorted, 'include 根必须是有序的');
    });
  });

  describe('include 的解析', () => {
    it('带目录的 include 相对 include 根解析', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      const fileSet = new Set(scan.files.map((f) => f.path));
      const resolved = resolveCppInclude(
        'src/engine/src/engine.cpp',
        'nimrtc/core/registry.hpp',
        fileSet,
        ['src/core/include'],
      );
      assert.equal(resolved, 'src/core/include/nimrtc/core/registry.hpp');
    });

    it('裸文件名优先在引用文件所在目录解析（C++ 规范行为）', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      const fileSet = new Set(scan.files.map((f) => f.path));
      const resolved = resolveCppInclude(
        'src/engine/src/engine.cpp',
        'engine_impl.hpp',
        fileSet,
        ['src/core/include'],
      );
      assert.equal(resolved, 'src/engine/src/engine_impl.hpp');
    });

    it('裸文件名找不到当前目录时，回退到 include 根', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      const fileSet = new Set(scan.files.map((f) => f.path));
      const resolved = resolveCppInclude(
        'src/engine/src/engine.cpp',
        'registry.hpp',
        fileSet,
        ['src/core/include'],
      );
      // include 根下是 nimrtc/core/registry.hpp，不是直接的 registry.hpp
      assert.equal(resolved, null, 'include 根下没有裸的 registry.hpp');
    });

    it('尖括号**跳过**当前目录（只搜 include 根）', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      const fileSet = new Set(scan.files.map((f) => f.path));

      // `engine_impl.hpp` 在引用文件同目录 —— 引号能找到，尖括号找不到
      const quoted = resolveCppInclude(
        'src/engine/src/engine.cpp',
        'engine_impl.hpp',
        fileSet,
        ['src/core/include'],
        '"',
      );
      assert.equal(quoted, 'src/engine/src/engine_impl.hpp', '引号：当前目录优先');

      const angled = resolveCppInclude(
        'src/engine/src/engine.cpp',
        'engine_impl.hpp',
        fileSet,
        ['src/core/include'],
        '<',
      );
      assert.equal(angled, null, '尖括号：跳过当前目录');
    });

    it('尖括号能找到 include 根下的项目头文件', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      const fileSet = new Set(scan.files.map((f) => f.path));
      const resolved = resolveCppInclude(
        'src/engine/src/engine.cpp',
        'nimrtc/core/registry.hpp',
        fileSet,
        ['src/core/include'],
        '<',
      );
      assert.equal(resolved, 'src/core/include/nimrtc/core/registry.hpp');
    });
  });

  describe('尖括号与引号的区别', () => {
    it('#include <...> 也要解析（尖括号可能是项目内部头文件）', () => {
      // ADR-062 §3.2（修正）：尖括号**不等于**系统头。
      // 真实项目实测：2716 条尖括号 include 里 1081 条是项目内部的。
      // 所以两种括号都要解析，只是搜索顺序不同。
      const refs = parseImports('#include <mutex>\n#include <nimrtc/core/x.hpp>\n', 'cpp');
      assert.equal(refs.length, 2);
      for (const ref of refs) {
        assert.equal(ref.kind, 'relative', `<${ref.specifier}> 也该尝试解析`);
      }
    });

    it('括号类型被记下来（决定搜索顺序）', () => {
      const refs = parseImports('#include <mutex>\n#include "foo.hpp"\n', 'cpp');
      assert.equal(refs.length, 2);
      assert.equal(refs[0].cppBracket, '<');
      assert.equal(refs[1].cppBracket, '"');
    });

    it('#include "..." 归为 relative（进模块图）', () => {
      const refs = parseImports('#include "foo.hpp"\n', 'cpp');
      assert.equal(refs.length, 1);
      assert.equal(refs[0].kind, 'relative');
      assert.equal(refs[0].specifier, 'foo.hpp');
    });

    it('系统头不会在模块图里产生边', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      for (const edge of scan.edges) {
        assert.notEqual(edge.to, 'system', '系统头不该成为模块');
      }
    });

    it('尖括号 include 指向项目内部头文件时，产生跨模块边', () => {
      // 这是 ADR-062 §3.2 修正的核心场景：
      // `<nimrtc/core/registry.hpp>` 是项目内部的，但用了尖括号。
      const scan = scanArchitecture(TEST_DIR, MODULES);
      const edge = scan.edges.find((e) => e.from === 'src/engine' && e.to === 'src/core');
      assert.ok(edge, '尖括号 include 也应产生跨模块边');
    });
  });

  describe('跨模块依赖边', () => {
    it('C++ include 产生跨模块边', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      const edge = scan.edges.find((e) => e.from === 'src/engine' && e.to === 'src/core');
      assert.ok(edge, `应产生 src/engine → src/core 的边，实际：${JSON.stringify(scan.edges)}`);
      assert.ok(edge.specifiers.includes('nimrtc/core/registry.hpp'));
    });

    it('同一模块内的 include 不产生边', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      const edge = scan.edges.find((e) => e.from === 'src/engine' && e.to === 'src/engine');
      assert.equal(edge, undefined, '模块内部的自引用不该算依赖边');
    });
  });

  describe('C++ 文件进入「已验证」', () => {
    it('C++ 文件参与 import 图', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      const cppFiles = scan.files.filter((f) => f.lang === 'cpp');
      assert.ok(cppFiles.length >= 3, `C++ 文件应参与扫描，实际 ${cppFiles.length} 个`);
    });

    it('覆盖面报告里 C++ 变成「已验证」', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      assert.ok(scan.coverage.verifiable.includes('cpp'), 'cpp 应在可验证类别里');
      assert.equal(scan.coverage.unverifiableCodeFiles, 0, '不该再有「验不了的代码文件」');
    });

    it('模块概况里 C++ 代码既算「代码」也算「已验证」', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      const report = buildArchitectureReport(MODULES, scan);
      const core = report.modules.find((m) => m.name === 'src/core');
      assert.ok(core);
      assert.ok(core.codeFileCount > 0, 'C++ 代码文件要算进「代码」');
      assert.equal(core.codeFileCount, core.verifiedFileCount, 'C++ 文件全都验过了');
    });
  });

  describe('确定性（C3）', () => {
    it('同样输入两次结果完全相同', () => {
      const a = scanArchitecture(TEST_DIR, MODULES);
      const b = scanArchitecture(TEST_DIR, MODULES);
      assert.deepEqual(a.edges, b.edges);
      assert.deepEqual(a.unresolved, b.unresolved);
      assert.deepEqual(a.coverage, b.coverage);
    });
  });
});

describe('ADR-062 §4.4：模块声明了但一个文件都没匹配上', () => {
  const EMPTY_MODULES: ModuleSpec[] = [
    { name: 'src/core', description: '', filePatterns: ['src/core/**'], dependencies: [] },
    {
      // 路径写错了 —— 真实项目里踩到的：设计写 src/dtls，代码在 src/modules/dtls
      name: 'src/dtls',
      description: '',
      filePatterns: ['src/dtls/*', 'src/dtls/**/*'],
      dependencies: ['src/core'],
    },
  ];

  before(async () => {
    await mkdir(join(TEST_DIR, 'src', 'core', 'include', 'nimrtc', 'core'), { recursive: true });
    await writeFile(
      join(TEST_DIR, 'src', 'core', 'include', 'nimrtc', 'core', 'x.hpp'),
      '#pragma once\n',
      'utf-8',
    );
  });

  it('报出 empty_module 偏离', () => {
    const scan = scanArchitecture(TEST_DIR, EMPTY_MODULES);
    const report = buildArchitectureReport(EMPTY_MODULES, scan);
    const dev = report.deviations.find((d) => d.kind === 'empty_module');
    assert.ok(dev, `应报 empty_module，实际：${JSON.stringify(report.deviations)}`);
    assert.equal(dev.from, 'src/dtls');
  });

  it('empty_module 是软偏离（不阻断「是否一致」）', () => {
    const scan = scanArchitecture(TEST_DIR, EMPTY_MODULES);
    const report = buildArchitectureReport(EMPTY_MODULES, scan);
    // 报告里可能还有其它偏离，但 empty_module 本身不该让 ok 变 false
    const onlyEmpty = report.deviations.filter((d) => d.kind === 'empty_module');
    assert.ok(onlyEmpty.length > 0);
    assert.equal(report.ok, !report.deviations.some((d) => d.kind === 'missing_dependency'));
  });

  it('说明里要点名路径写错了', () => {
    const scan = scanArchitecture(TEST_DIR, EMPTY_MODULES);
    const report = buildArchitectureReport(EMPTY_MODULES, scan);
    const dev = report.deviations.find((d) => d.kind === 'empty_module');
    assert.ok(dev);
    assert.ok(
      dev.detail.includes('src/dtls'),
      `说明里应点名出错的路径，实际：${dev.detail}`,
    );
  });
});
