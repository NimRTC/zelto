// ADR-060 §4 方案 A：架构扫描必须诚实地说出「哪些文件验过、哪些没验过」。
//
// 没有覆盖面报告时，`arch check` 在一个 C++ 项目上会输出
// 「✔ 没有偏离」或「⚠️ N 项无法验证」——
// 后者看起来像「项目有点小问题」，而真相是「**这个工具在这个项目上没有判据**」。
//
// 这两件事对人的行动含义完全不同：前者说「去修一下」，
// 后者说「补判据或换工具」。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanArchitecture } from '../src/core/arch/scan.js';
import { classifyLangCategory, isVerifiableLang } from '../src/core/arch/imports.js';
import type { ModuleSpec } from '../src/core/arch/types.js';

const TEST_DIR = join(tmpdir(), `zelto-arch-coverage-${Date.now()}`);

const MODULES: ModuleSpec[] = [
  { name: 'core', description: '核心', filePatterns: ['src/core/**'], dependencies: [] },
  { name: 'engine', description: '引擎', filePatterns: ['src/engine/**'], dependencies: ['core'] },
];

describe('ADR-060 §4：架构扫描的语言覆盖面', () => {
  before(async () => {
    await mkdir(join(TEST_DIR, 'src', 'core'), { recursive: true });
    await mkdir(join(TEST_DIR, 'src', 'engine'), { recursive: true });

    // TS —— 有 import 语义，已支持
    await writeFile(
      join(TEST_DIR, 'src', 'core', 'index.ts'),
      "export const x = 1;\n",
      'utf-8',
    );
    // Python —— 有 import 语义，已支持
    await writeFile(
      join(TEST_DIR, 'src', 'core', 'helper.py'),
      "def f():\n    return 1\n",
      'utf-8',
    );
    // C++ —— 有 include 语义，**尚未支持**
    await writeFile(
      join(TEST_DIR, 'src', 'engine', 'engine.cpp'),
      '#include "core.hpp"\nint main() { return 0; }\n',
      'utf-8',
    );
    await writeFile(
      join(TEST_DIR, 'src', 'engine', 'engine.hpp'),
      '#pragma once\n',
      'utf-8',
    );
    // Java / Kotlin —— 尚未支持（ADR-069 只覆盖了 Go / Rust）
    await writeFile(
      join(TEST_DIR, 'src', 'engine', 'Main.java'),
      'public class Main {}\n',
      'utf-8',
    );
    // 非代码文件 —— 不产生依赖边，不该混进「验不了」的警告里
    await writeFile(join(TEST_DIR, 'src', 'engine', 'Makefile'), 'all:\n\techo hi\n', 'utf-8');
    await writeFile(join(TEST_DIR, 'src', 'engine', 'README.md'), '# engine\n', 'utf-8');
    await writeFile(join(TEST_DIR, 'src', 'engine', 'config.json'), '{}\n', 'utf-8');
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('语言类别分类：C++ / Go / Rust 认得出来', () => {
    assert.equal(classifyLangCategory('src/a.cpp'), 'cpp');
    assert.equal(classifyLangCategory('src/a.h'), 'cpp');
    assert.equal(classifyLangCategory('src/a.hpp'), 'cpp');
    assert.equal(classifyLangCategory('src/a.cc'), 'cpp');
    assert.equal(classifyLangCategory('src/a.go'), 'go');
    assert.equal(classifyLangCategory('src/a.rs'), 'rust');
    assert.equal(classifyLangCategory('src/a.java'), 'java');
    assert.equal(classifyLangCategory('src/a.kt'), 'java');
  });

  it('语言类别分类：TS/JS 归到 typescript，Python 归到 python', () => {
    assert.equal(classifyLangCategory('src/a.ts'), 'typescript');
    assert.equal(classifyLangCategory('src/a.tsx'), 'typescript');
    assert.equal(classifyLangCategory('src/a.js'), 'typescript');
    assert.equal(classifyLangCategory('src/a.mjs'), 'typescript');
    assert.equal(classifyLangCategory('src/a.py'), 'python');
  });

  it('语言类别分类：构建脚本 / 文档 / 配置单独归类', () => {
    assert.equal(classifyLangCategory('Makefile'), 'build');
    assert.equal(classifyLangCategory('src/Makefile'), 'build');
    assert.equal(classifyLangCategory('Dockerfile'), 'build');
    // `CMakeLists.txt` 的扩展名是 `.txt`（文档类），但它其实是构建脚本 ——
    // 特殊文件名必须优先于扩展名判定。
    assert.equal(classifyLangCategory('CMakeLists.txt'), 'build');
    assert.equal(classifyLangCategory('src/CMakeLists.txt'), 'build');
    assert.equal(classifyLangCategory('src/a.md'), 'doc');
    assert.equal(classifyLangCategory('src/a.yaml'), 'config');
    assert.equal(classifyLangCategory('src/a.json'), 'config');
  });

  it('可验证性：TS/JS、Python、C/C++、Go、Rust 目前有判据', () => {
    assert.equal(isVerifiableLang('typescript'), true);
    assert.equal(isVerifiableLang('python'), true);
    // ADR-062：C/C++ 的 `#include` 语义已支持
    assert.equal(isVerifiableLang('cpp'), true);
    // ADR-069：Go 的 `import` / Rust 的 `use` 语义已支持
    assert.equal(isVerifiableLang('go'), true);
    assert.equal(isVerifiableLang('rust'), true);
    // Java / Kotlin 还没做
    assert.equal(isVerifiableLang('java'), false);
    assert.equal(isVerifiableLang('build'), false);
    assert.equal(isVerifiableLang('doc'), false);
    assert.equal(isVerifiableLang('config'), false);
  });

  it('覆盖面统计：验过的 / 验不了的 / 不产生依赖边的，分开算', () => {
    const scan = scanArchitecture(TEST_DIR, MODULES);
    const coverage = scan.coverage;

    // 验过：1 个 ts + 1 个 py + 2 个 C++（ADR-062 起 C++ 也验了）
    assert.equal(coverage.verifiedFiles, 4, `实际：${coverage.verifiedFiles}`);
    assert.deepEqual(coverage.verifiable, ['typescript', 'python', 'cpp']);

    // 验不了的代码：Java (1) —— Go/Rust 已移出这一类（ADR-069）
    assert.equal(coverage.unverifiableCodeFiles, 1, `实际：${coverage.unverifiableCodeFiles}`);
    assert.equal(coverage.counts.cpp, 2);
    assert.equal(coverage.counts.java, 1);

    // 不产生依赖边：Makefile + README.md + config.json
    assert.equal(coverage.nonCodeFiles, 3, `实际：${coverage.nonCodeFiles}`);
    assert.equal(coverage.counts.build, 1);
    assert.equal(coverage.counts.doc, 1);
    assert.equal(coverage.counts.config, 1);

    assert.equal(coverage.totalFiles, 8, `实际：${coverage.totalFiles}`);
  });

  it('C++ 文件参与 import 图（ADR-062 起有判据了）', () => {
    const scan = scanArchitecture(TEST_DIR, MODULES);
    const cppFiles = scan.files.filter((f) => f.path.endsWith('.cpp') || f.path.endsWith('.hpp'));
    assert.equal(cppFiles.length, 2, `C++ 文件应参与 import 图，实际 ${cppFiles.length} 个`);
  });

  it('覆盖面统计是确定的（同样输入两次结果相同）', () => {
    const a = scanArchitecture(TEST_DIR, MODULES);
    const b = scanArchitecture(TEST_DIR, MODULES);
    assert.deepEqual(a.coverage.counts, b.coverage.counts);
    assert.equal(a.coverage.verifiedFiles, b.coverage.verifiedFiles);
    assert.equal(a.coverage.unverifiableCodeFiles, b.coverage.unverifiableCodeFiles);
  });

  it('counts 的键是语言类别，不是数组索引', () => {
    // 曾经的 bug：`Object.keys(LANG_CATEGORY_KEYS)` 给的是**数组索引**
    // （"0".."9"），不是元素值 —— 于是 counts 里塞满了 "0".."9" 的假键，
    // 报告里也会出现一堆看不懂的类别。
    const scan = scanArchitecture(TEST_DIR, MODULES);
    const keys = Object.keys(scan.coverage.counts);
    for (const key of keys) {
      assert.ok(
        !/^\d+$/.test(key),
        `counts 里不该有数组索引键 "${key}"，实际键：${keys.join(', ')}`,
      );
    }
    assert.deepEqual(keys, [
      'typescript',
      'python',
      'cpp',
      'go',
      'rust',
      'java',
      'build',
      'doc',
      'config',
      'other',
    ]);
  });
});
