// ADR-069：Rust 的依赖解析。
//
// 关键设计（ADR-069 §3.2）：
//   - `use crate::x` / `use self::x` / `use super::x` → 项目内部
//   - `use std::x` / `use core::x` / `use alloc::x` → 标准库
//   - 其它裸路径 → 外部 crate
//   - **`mod` 声明不产生依赖边** —— 它是「声明」不是「引用」
//   - `#[cfg(...)]` 挂在 item 上，只给那一个 item 标条件

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { scanArchitecture, findCargoRoot, resolveRustImport } from '../src/core/arch/scan.js';
import { buildArchitectureReport } from '../src/core/arch/report.js';
import {
  parseImports,
  classifyRustSpecifier,
  expandRustUsePath,
  parseRustUseLine,
} from '../src/core/arch/imports.js';
import type { ModuleSpec } from '../src/core/arch/types.js';

const TEST_DIR = join(tmpdir(), `zelto-rust-import-${Date.now()}`);

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

describe('ADR-069：Rust 的依赖解析', () => {
  before(async () => {
    await write('Cargo.toml', '[package]\nname = "demo"\nversion = "0.1.0"\n');
    await write('src/lib.rs', 'pub mod core;\npub mod engine;\n');
    await write('src/core/mod.rs', 'pub mod registry;\n');
    await write('src/core/registry.rs', 'pub struct Registry;\n');
    await write(
      'src/engine/mod.rs',
      [
        'use crate::core::registry::Registry;',
        'use std::collections::HashMap;',
        'use core::fmt::Debug;',
        'use serde::Serialize;',
        'use crate::core::registry as reg;',
        'use crate::{core::registry::Registry as R2, engine};',
        'extern crate libc;',
        '',
        'mod submodule;',
        '',
        '#[cfg(target_os = "linux")]',
        'use nix::unistd::close;',
        '',
      ].join('\n'),
    );
    await write('src/engine/submodule.rs', 'pub fn f() {}\n');
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  describe('use 语句的解析', () => {
    it('标准库归为 builtin', () => {
      assert.equal(classifyRustSpecifier('std::collections::HashMap'), 'builtin');
      assert.equal(classifyRustSpecifier('core::fmt::Debug'), 'builtin');
      assert.equal(classifyRustSpecifier('alloc::vec::Vec'), 'builtin');
    });

    it('crate:: / self:: / super:: 归为 relative', () => {
      assert.equal(classifyRustSpecifier('crate::core::registry'), 'relative');
      assert.equal(classifyRustSpecifier('self::sibling'), 'relative');
      assert.equal(classifyRustSpecifier('super::parent'), 'relative');
    });

    it('裸路径归为 package（外部 crate）', () => {
      assert.equal(classifyRustSpecifier('serde::Serialize'), 'package');
    });

    it('use crate::core::registry 被解析出来', () => {
      const refs = parseImports('use crate::core::registry::Registry;\n', 'rust');
      assert.equal(refs.length, 1);
      assert.equal(refs[0].specifier, 'crate::core::registry::Registry');
      assert.equal(refs[0].kind, 'relative');
    });

    it('带别名的 use —— 别名不是路径的一部分', () => {
      const refs = parseImports('use crate::core::registry as reg;\n', 'rust');
      assert.equal(refs.length, 1);
      assert.equal(refs[0].specifier, 'crate::core::registry');
    });

    it('嵌套花括号被展开成多条', () => {
      const refs = parseImports('use crate::{a, b::c};\n', 'rust');
      assert.equal(refs.length, 2);
      assert.deepEqual(refs.map((r) => r.specifier), ['crate::a', 'crate::b::c']);
    });

    it('深层嵌套花括号被递归展开', () => {
      const expanded = expandRustUsePath('crate::{a, b::{c, d}}');
      assert.deepEqual(expanded, ['crate::a', 'crate::b::c', 'crate::b::d']);
    });

    it('pub use（re-export）也是依赖', () => {
      const refs = parseImports('pub use crate::core::registry::Registry;\n', 'rust');
      assert.equal(refs.length, 1);
      assert.equal(refs[0].specifier, 'crate::core::registry::Registry');
    });

    it('extern crate 被解析出来', () => {
      const refs = parseImports('extern crate libc;\n', 'rust');
      assert.equal(refs.length, 1);
      assert.equal(refs[0].specifier, 'libc');
      assert.equal(refs[0].kind, 'package');
    });

    it('**mod 声明不产生依赖边**', () => {
      // `mod submodule;` 是「声明」不是「引用」——
      // 它指的是同目录的 submodule.rs，那是「这个文件属于那个模块」
      const refs = parseImports('mod submodule;\n', 'rust');
      assert.equal(refs.length, 0, 'mod 不该被当成依赖');
    });

    it('pub mod 也不产生依赖边', () => {
      const refs = parseImports('pub mod submodule;\n', 'rust');
      assert.equal(refs.length, 0, 'pub mod 不该被当成依赖');
    });
  });

  describe('条件编译（#[cfg]）', () => {
    it('#[cfg] 下的 use 带条件标记', () => {
      const source = '#[cfg(target_os = "linux")]\nuse nix::unistd::close;\n';
      const refs = parseImports(source, 'rust');
      assert.equal(refs.length, 1);
      assert.equal(refs[0].condition, 'target_os = "linux"');
    });

    it('#[cfg] 之外的 use 不带条件标记', () => {
      const source = 'use std::fmt;\n\n#[cfg(unix)]\nuse nix::unistd;\n';
      const refs = parseImports(source, 'rust');
      const std = refs.find((r) => r.specifier === 'std::fmt');
      const nix = refs.find((r) => r.specifier === 'nix::unistd');
      assert.equal(std?.condition, undefined);
      assert.equal(nix?.condition, 'unix');
    });
  });

  describe('crate 根的发现', () => {
    it('找到含 Cargo.toml 的目录', () => {
      assert.equal(findCargoRoot(TEST_DIR), '');
    });

    it('没有 Cargo.toml 时返回 null', () => {
      assert.equal(findCargoRoot(join(tmpdir(), 'zelto-nonexistent-xyz')), null);
    });
  });

  describe('use 路径的解析', () => {
    it('crate::core::registry → src/core/registry.rs', () => {
      const fileSet = new Set([
        'src/lib.rs',
        'src/core/mod.rs',
        'src/core/registry.rs',
        'src/engine/mod.rs',
        'src/engine/submodule.rs',
      ]);
      const resolved = resolveRustImport('crate::core::registry', fileSet, '');
      assert.equal(resolved, 'src/core/registry.rs');
    });

    it('crate::core → src/core/mod.rs', () => {
      const fileSet = new Set(['src/lib.rs', 'src/core/mod.rs']);
      const resolved = resolveRustImport('crate::core', fileSet, '');
      assert.equal(resolved, 'src/core/mod.rs');
    });

    it('crate:: → crate 根的 lib.rs', () => {
      const fileSet = new Set(['src/lib.rs']);
      const resolved = resolveRustImport('crate', fileSet, '');
      assert.equal(resolved, 'src/lib.rs');
    });

    it('非 crate:: 路径不解析（super:: / self:: 判不准时宁可漏）', () => {
      const fileSet = new Set(['src/lib.rs']);
      assert.equal(resolveRustImport('super::parent', fileSet, ''), null);
      assert.equal(resolveRustImport('self::sibling', fileSet, ''), null);
    });
  });

  describe('跨模块依赖边', () => {
    it('crate:: 内部的 use 产生跨模块边', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      const edge = scan.edges.find((e) => e.from === 'src/engine' && e.to === 'src/core');
      assert.ok(edge, `应产生 src/engine → src/core 的边，实际：${JSON.stringify(scan.edges)}`);
    });

    it('外部 crate 不产生边', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      for (const edge of scan.edges) {
        assert.ok(!edge.to.includes('serde'), '外部 crate 不该成为模块');
        assert.ok(!edge.to.includes('nix'), '外部 crate 不该成为模块');
      }
    });

    it('标准库不产生边', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      for (const edge of scan.edges) {
        assert.ok(edge.to !== 'std' && edge.to !== 'core', '标准库不该成为模块');
      }
    });

    it('mod 声明不产生边', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      // src/engine/submodule.rs 属于 src/engine —— 不该产生 src/engine → src/engine
      const edge = scan.edges.find((e) => e.from === 'src/engine' && e.to === 'src/engine');
      assert.equal(edge, undefined, '模块内部的自引用不该算依赖边');
    });
  });

  describe('Rust 计入「已验证」', () => {
    it('Rust 文件参与 import 图', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      const rustFiles = scan.files.filter((f) => f.lang === 'rust');
      assert.ok(rustFiles.length >= 4, `Rust 文件应参与扫描，实际 ${rustFiles.length} 个`);
    });

    it('覆盖面报告里 rust 变成「已验证」', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      assert.ok(scan.coverage.verifiable.includes('rust'), 'rust 应在可验证类别里');
    });

    it('模块概况里 Rust 代码既算「代码」也算「已验证」', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      const report = buildArchitectureReport(MODULES, scan);
      const core = report.modules.find((m) => m.name === 'src/core');
      assert.ok(core);
      assert.ok(core.codeFileCount > 0, 'Rust 代码文件要算进「代码」');
      assert.equal(core.codeFileCount, core.verifiedFileCount, 'Rust 文件全都验过了');
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

  describe('parseRustUseLine 的直接用法', () => {
    it('非 use 行返回空数组', () => {
      assert.deepEqual(parseRustUseLine('fn main() {}', 1), []);
    });

    it('行号被带上', () => {
      const refs = parseRustUseLine('use crate::x::y;', 42);
      assert.equal(refs[0].line, 42);
    });
  });
});
