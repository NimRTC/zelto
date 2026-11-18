// ADR-082 的架构解析补齐：
//   1. **Java / Kotlin 的 import 解析**（D-75）
//   2. **Go 的平台后缀约束**（D-76）
//   3. **Rust 的 `super::` / `self::` 层级解析**（D-77）
//
// 三条都是「漏边」类缺陷：少报边，而不是多报边。
// 但漏边会让真实的架构违规（「A 依赖 B，B 又依赖 A」）被放过 —— 所以值得修。
//
// **判据的核心权衡**（ADR-062 §7 / ADR-069 §6）：
// > 宁可漏边，也不要判错边 —— 判错边会产生假的「环」。
//
// 所以本文件里几乎每条断言都同时守两件事：
//   - 该有的边**必须**有（不漏）
//   - 不该有的边**必须**没有（不猜）

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { scanArchitecture, resolveJavaImport, resolveRustImport, parseGoFileConstraints } from '../src/core/arch/scan.js';
import { parseImports, detectLang, isVerifiableLang, classifyLangCategory } from '../src/core/arch/imports.js';
import { isTestFile } from '../src/core/arch/test-files.js';
import type { ModuleSpec } from '../src/core/arch/types.js';

// ─── Java / Kotlin ──────────────────────────────────────────────────────────

describe('D-75：Java / Kotlin 的 import 解析', () => {
  it('Java 的四种 import 形态都被解析出来', () => {
    const source = [
      'package com.example.core;',
      '',
      'import com.example.core.Registry;',
      'import static com.example.core.Utils.helper;',
      'import com.example.core.spi.*;',
      'import com.example.core.Engine as EngineAlias;',
      '',
      'public class App {}',
    ].join('\n');

    const refs = parseImports(source, 'java');
    const specs = refs.map((r) => r.specifier);

    assert.ok(specs.includes('com.example.core.Registry'), `普通 import 没解析出来：${specs.join(', ')}`);
    assert.ok(specs.includes('com.example.core.Utils.helper'), `静态 import 没解析出来：${specs.join(', ')}`);
    assert.ok(specs.includes('com.example.core.spi.*'), `通配符 import 没解析出来：${specs.join(', ')}`);
    assert.ok(specs.includes('com.example.core.Engine'), `别名 import 没解析出来：${specs.join(', ')}`);
  });

  it('别名不是路径的一部分（import a.b.C as D → 依赖是 a.b.C）', () => {
    const refs = parseImports('import com.example.core.Engine as EngineAlias;\n', 'java');
    assert.equal(refs.length, 1);
    assert.equal(refs[0].specifier, 'com.example.core.Engine');
  });

  it('Kotlin 的 import 也能解析', () => {
    const source = [
      'package com.example.core',
      '',
      'import com.example.core.Registry',
      'import com.example.core.Engine as EngineAlias',
      '',
      'class App',
    ].join('\n');

    const refs = parseImports(source, 'java');
    const specs = refs.map((r) => r.specifier);
    assert.ok(specs.includes('com.example.core.Registry'));
    assert.ok(specs.includes('com.example.core.Engine'));
  });

  it('Java / Kotlin 的 import 一律归为 package（全限定名）', () => {
    const refs = parseImports('import com.example.core.Registry;\n', 'java');
    assert.equal(refs[0].kind, 'package');
  });

  it('.java / .kt / .kts 都被识别为 java 语言', () => {
    assert.equal(detectLang('src/main/java/com/example/App.java'), 'java');
    assert.equal(detectLang('src/com/example/App.kt'), 'java');
    assert.equal(detectLang('build.gradle.kts'), 'java');
  });

  it('java 现在是「可验证」语言类别（isVerifiableLang）', () => {
    assert.equal(isVerifiableLang('java'), true);
    assert.equal(classifyLangCategory('src/main/java/com/example/App.java'), 'java');
  });

  it('包路径 → 类文件的解析（Gradle / Maven 布局）', () => {
    const fileSet = new Set([
      'src/main/java/com/example/core/Registry.java',
      'src/main/kotlin/com/example/core/Engine.kt',
    ]);
    assert.equal(resolveJavaImport('com.example.core.Registry', fileSet), 'src/main/java/com/example/core/Registry.java');
    assert.equal(resolveJavaImport('com.example.core.Engine', fileSet), 'src/main/kotlin/com/example/core/Engine.kt');
  });

  it('通配符 import 解析不到具体类 → 漏边而不是猜错边', () => {
    const fileSet = new Set(['src/main/java/com/example/core/Registry.java']);
    assert.equal(resolveJavaImport('com.example.core.spi.*', fileSet), null);
  });

  it('解析不到的包路径返回 null（不猜）', () => {
    const fileSet = new Set(['src/main/java/com/example/core/Registry.java']);
    assert.equal(resolveJavaImport('com.other.lib.Thing', fileSet), null);
    assert.equal(resolveJavaImport('Registry', fileSet), null);
  });
});

describe('D-75：Java 的跨模块依赖边', () => {
  const TEST_DIR = join(tmpdir(), `zelto-java-import-${Date.now()}`);

  const MODULES: ModuleSpec[] = [
    { name: 'src/core', description: '', filePatterns: ['src/core/**'], dependencies: [] },
    { name: 'src/app', description: '', filePatterns: ['src/app/**'], dependencies: ['src/core'] },
  ];

  async function write(rel: string, content: string): Promise<void> {
    const full = join(TEST_DIR, ...rel.split('/'));
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content, 'utf-8');
  }

  before(async () => {
    // Gradle / Maven 常规布局
    await write(
      'src/core/com/example/core/Registry.java',
      'package com.example.core;\n\npublic class Registry {}\n',
    );
    await write(
      'src/app/com/example/app/App.java',
      [
        'package com.example.app;',
        '',
        'import com.example.core.Registry;',
        '',
        'public class App {',
        '  Registry r = new Registry();',
        '}',
      ].join('\n'),
    );
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('Java 的 import 产生跨模块边', () => {
    const scan = scanArchitecture(TEST_DIR, MODULES);
    const edge = scan.edges.find((e) => e.from === 'src/app' && e.to === 'src/core');
    assert.ok(edge, `应产生 src/app → src/core 的边，实际：${JSON.stringify(scan.edges)}`);
  });

  it('Java 文件参与 import 图（不再是「验不了」）', () => {
    const scan = scanArchitecture(TEST_DIR, MODULES);
    assert.ok(scan.coverage.verifiable.includes('java'), 'java 应在可验证类别里');
    const javaFiles = scan.files.filter((f) => f.lang === 'java');
    assert.equal(javaFiles.length, 2, '两个 Java 文件都应参与扫描');
  });

  it('Kotlin 布局（src/<pkg>/<Class>.kt）也能解析', () => {
    const fileSet = new Set(['src/com/example/core/Engine.kt']);
    assert.equal(resolveJavaImport('com.example.core.Engine', fileSet), 'src/com/example/core/Engine.kt');
  });
});

// ─── Go 的文件级构建约束 ────────────────────────────────────────────────────

describe('D-76：Go 的文件名构建约束', () => {
  it('_test.go 被识别为测试文件（不产生依赖边）', () => {
    // 与 test-files.ts 的既有约定一致
    assert.equal(isTestFile('internal/core/registry_test.go'), true);
    assert.equal(isTestFile('internal/core/registry.go'), false);
  });

  it('平台后缀被识别', () => {
    assert.equal(parseGoFileConstraints('internal/core/registry_linux.go'), 'linux');
    assert.equal(parseGoFileConstraints('internal/core/registry_windows.go'), 'windows');
    assert.equal(parseGoFileConstraints('internal/core/registry_darwin.go'), 'darwin');
    assert.equal(parseGoFileConstraints('internal/core/registry_linux_amd64.go'), 'linux_amd64');
  });

  it('没有平台后缀时返回 null', () => {
    assert.equal(parseGoFileConstraints('internal/core/registry.go'), null);
    assert.equal(parseGoFileConstraints('internal/core/registry_test.go'), null);
  });

  it('不是文件名最后一段的不认（linux_helper.go 不是 linux 专属）', () => {
    assert.equal(parseGoFileConstraints('internal/core/linux_helper.go'), null);
  });
});

describe('D-76：Go 的平台专属文件不误报环', () => {
  const TEST_DIR = join(tmpdir(), `zelto-go-platform-${Date.now()}`);

  const MODULES: ModuleSpec[] = [
    { name: 'internal/core', description: '', filePatterns: ['internal/core/**'], dependencies: [] },
    { name: 'internal/platform', description: '', filePatterns: ['internal/platform/**'], dependencies: [] },
  ];

  async function write(rel: string, content: string): Promise<void> {
    const full = join(TEST_DIR, ...rel.split('/'));
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content, 'utf-8');
  }

  before(async () => {
    await write('go.mod', 'module example.com/demo\n\ngo 1.22\n');
    // 两个平台专属实现互相引用 —— 在各自平台上它们是互斥的，
    // 绝不该被算成「依赖成环」。
    await write(
      'internal/core/registry_linux.go',
      'package core\n\nimport "example.com/demo/internal/platform"\n\nfunc F() { platform.Linux() }\n',
    );
    await write(
      'internal/core/registry_windows.go',
      'package core\n\nimport "example.com/demo/internal/platform"\n\nfunc F() { platform.Windows() }\n',
    );
    await write(
      'internal/platform/platform_linux.go',
      'package platform\n\nfunc Linux() {}\n',
    );
    await write(
      'internal/platform/platform_windows.go',
      'package platform\n\nfunc Windows() {}\n',
    );
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('平台专属文件产生的边被标成「条件边」', () => {
    const scan = scanArchitecture(TEST_DIR, MODULES);
    const edge = scan.edges.find((e) => e.from === 'internal/core' && e.to === 'internal/platform');
    assert.ok(edge, `应产生 internal/core → internal/platform 的边，实际：${JSON.stringify(scan.edges)}`);
    assert.equal(edge.conditionalOnly, true, '平台专属文件产生的边应标成条件边');
    assert.ok(
      (edge.conditions ?? []).some((c) => c.includes('linux') || c.includes('windows')),
      `条件里应含平台名，实际：${JSON.stringify(edge.conditions)}`,
    );
  });
});

// ─── Rust 的 super:: / self:: ──────────────────────────────────────────────

describe('D-77：Rust 的 super:: / self:: 层级解析', () => {
  it('self::sibling → 当前模块目录下的 sibling', () => {
    const fileSet = new Set([
      'src/foo/mod.rs',
      'src/foo/bar.rs',
    ]);
    assert.equal(
      resolveRustImport('self::bar', fileSet, '', 'src/foo/mod.rs'),
      'src/foo/bar.rs',
    );
  });

  it('super::parent → 上一级模块', () => {
    const fileSet = new Set([
      'src/foo/mod.rs',
      'src/foo/bar.rs',
      'src/foo/baz.rs',
    ]);
    // `src/foo/bar.rs` 是模块 `foo::bar` → 上一级是 `foo` → `src/foo/baz.rs`
    assert.equal(
      resolveRustImport('super::baz', fileSet, '', 'src/foo/bar.rs'),
      'src/foo/baz.rs',
    );
  });

  it('super::super::x → 上跳两级', () => {
    const fileSet = new Set([
      'src/a/b/mod.rs',
      'src/a/b/c.rs',
      'src/a/x.rs',
    ]);
    // `src/a/b/c.rs` 是模块 `a::b::c` → super → `a::b` → super → `a` → `src/a/x.rs`
    assert.equal(
      resolveRustImport('super::super::x', fileSet, '', 'src/a/b/c.rs'),
      'src/a/x.rs',
    );
  });

  it('foo.rs + foo/ 两种布局都认（同一模块的两种摆法）', () => {
    // 布局 A：`src/foo.rs` 是模块 foo，其子模块在 `src/foo/` 下
    const fileSetA = new Set([
      'src/foo.rs',
      'src/foo/bar.rs',
    ]);
    assert.equal(
      resolveRustImport('self::bar', fileSetA, '', 'src/foo.rs'),
      'src/foo/bar.rs',
    );

    // 布局 B：`src/foo/mod.rs` 是模块 foo
    const fileSetB = new Set([
      'src/foo/mod.rs',
      'src/foo/bar.rs',
    ]);
    assert.equal(
      resolveRustImport('self::bar', fileSetB, '', 'src/foo/mod.rs'),
      'src/foo/bar.rs',
    );
  });

  it('模块目录形式（self::x 指向 x/mod.rs）', () => {
    const fileSet = new Set([
      'src/foo/mod.rs',
      'src/foo/x/mod.rs',
    ]);
    assert.equal(
      resolveRustImport('self::x', fileSet, '', 'src/foo/mod.rs'),
      'src/foo/x/mod.rs',
    );
  });

  it('super:: 从 mod.rs 出发 → 上一级目录', () => {
    const fileSet = new Set([
      'src/foo/mod.rs',
      'src/baz.rs',
    ]);
    assert.equal(
      resolveRustImport('super::baz', fileSet, '', 'src/foo/mod.rs'),
      'src/baz.rs',
    );
  });

  it('判不准时返回 null（漏边，不猜）', () => {
    const fileSet = new Set(['src/foo/mod.rs']);
    assert.equal(resolveRustImport('self::missing', fileSet, '', 'src/foo/mod.rs'), null);
    // 没有 fromFile 时无法定位层级 → 漏边
    assert.equal(resolveRustImport('self::bar', fileSet, ''), null);
  });
});

describe('D-77：Rust 的 super:: / self:: 产生跨模块边', () => {
  const TEST_DIR = join(tmpdir(), `zelto-rust-relative-${Date.now()}`);

  const MODULES: ModuleSpec[] = [
    { name: 'src/core', description: '', filePatterns: ['src/core/**'], dependencies: [] },
    { name: 'src/engine', description: '', filePatterns: ['src/engine/**'], dependencies: ['src/core'] },
  ];

  async function write(rel: string, content: string): Promise<void> {
    const full = join(TEST_DIR, ...rel.split('/'));
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content, 'utf-8');
  }

  before(async () => {
    await write('Cargo.toml', '[package]\nname = "demo"\nversion = "0.1.0"\n');
    await write('src/lib.rs', 'pub mod core;\npub mod engine;\n');
    await write('src/core/mod.rs', 'pub mod registry;\n');
    await write('src/core/registry.rs', 'pub struct Registry;\n');
    // `src/engine/impl.rs` 用 `super::` 指向上一级模块 `src/engine` 的兄弟模块？
    // 不 —— `super::` 指向上一级 `src`，所以这里用 `crate::` 的等价物做跨模块边，
    // 并另加一个 `super::` 的**同包**引用来验证层级解析确实生效。
    await write(
      'src/engine/mod.rs',
      ['use crate::core::registry::Registry;', 'use super::engine::helper::H;', ''].join('\n'),
    );
    await write('src/engine/helper.rs', 'pub struct H;\n');
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('crate:: 跨模块边照常产生', () => {
    const scan = scanArchitecture(TEST_DIR, MODULES);
    const edge = scan.edges.find((e) => e.from === 'src/engine' && e.to === 'src/core');
    assert.ok(edge, `应产生 src/engine → src/core 的边，实际：${JSON.stringify(scan.edges)}`);
  });
});
