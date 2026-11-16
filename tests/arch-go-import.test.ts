// ADR-069：Go 的 import 依赖解析。
//
// 关键设计（ADR-069 §3.1）：
//   - Go 的 import 路径是**模块路径**，没有文件系统对应关系
//   - 判据（约定法）：以 `go.mod` 的 module path 开头 → 项目内部
//   - **只读 go.mod 的 module 一行** —— require / replace 的语义不解析
//     （宁可漏，不猜）
//   - 条件编译：`//go:build` 在文件顶部，覆盖整个文件

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { scanArchitecture, findGoModulePath, resolveGoImport } from '../src/core/arch/scan.js';
import { buildArchitectureReport } from '../src/core/arch/report.js';
import { parseImports, classifyGoSpecifier, findGoBuildTag } from '../src/core/arch/imports.js';
import type { ModuleSpec } from '../src/core/arch/types.js';

const TEST_DIR = join(tmpdir(), `zelto-go-import-${Date.now()}`);

const MODULES: ModuleSpec[] = [
  { name: 'internal/core', description: '', filePatterns: ['internal/core/**'], dependencies: [] },
  {
    name: 'internal/engine',
    description: '',
    filePatterns: ['internal/engine/**'],
    dependencies: ['internal/core'],
  },
];

async function write(rel: string, content: string): Promise<void> {
  const full = join(TEST_DIR, ...rel.split('/'));
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content, 'utf-8');
}

describe('ADR-069：Go 的 import 解析', () => {
  before(async () => {
    await write('go.mod', 'module github.com/foo/bar\n\ngo 1.21\n');
    await write('internal/core/registry.go', 'package core\n\nfunc Registry() {}\n');
    await write(
      'internal/engine/engine.go',
      [
        'package engine',
        '',
        'import (',
        '\t"fmt"',
        '\t"github.com/foo/bar/internal/core"',
        '\talias "github.com/foo/bar/internal/core/sub"',
        '\t_ "embed"',
        '\t"github.com/other/pkg"',
        ')',
        '',
        'func Run() { fmt.Println(core.Registry()) }',
        '',
      ].join('\n'),
    );
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  describe('import 语句的解析', () => {
    it('单行 import', () => {
      const refs = parseImports('import "fmt"\n', 'go');
      assert.equal(refs.length, 1);
      assert.equal(refs[0].specifier, 'fmt');
    });

    it('import 块里的多条 import', () => {
      const refs = parseImports('import (\n\t"fmt"\n\t"net/http"\n)\n', 'go');
      assert.equal(refs.length, 2);
      assert.deepEqual(refs.map((r) => r.specifier), ['fmt', 'net/http']);
    });

    it('带别名的 import —— 说明符是路径，不是别名', () => {
      const refs = parseImports('import alias "github.com/foo/bar/x"\n', 'go');
      assert.equal(refs.length, 1);
      assert.equal(refs[0].specifier, 'github.com/foo/bar/x');
    });

    it('空导入（_ "x"）也是依赖', () => {
      const refs = parseImports('import _ "embed"\n', 'go');
      assert.equal(refs.length, 1);
      assert.equal(refs[0].specifier, 'embed');
    });

    it('标准库归为 builtin', () => {
      assert.equal(classifyGoSpecifier('fmt'), 'builtin');
      assert.equal(classifyGoSpecifier('net/http'), 'builtin');
      assert.equal(classifyGoSpecifier('os'), 'builtin');
    });

    it('第三方模块归为 package', () => {
      assert.equal(classifyGoSpecifier('github.com/other/pkg'), 'package');
    });

    it('行号正确', () => {
      const refs = parseImports('package x\n\nimport (\n\t"fmt"\n\t"os"\n)\n', 'go');
      assert.equal(refs[0].line, 4);
      assert.equal(refs[1].line, 4);
    });
  });

  describe('条件编译（//go:build）', () => {
    it('文件顶部的 //go:build 被认出来', () => {
      const tag = findGoBuildTag('//go:build linux && amd64\n\npackage x\n');
      assert.equal(tag, 'linux && amd64');
    });

    it('旧格式 // +build 也认', () => {
      const tag = findGoBuildTag('// +build linux,amd64\n\npackage x\n');
      assert.equal(tag, 'linux,amd64');
    });

    it('没有约束时返回 null', () => {
      assert.equal(findGoBuildTag('package x\n'), null);
    });

    it('条件文件里的所有 import 都带条件标记', () => {
      const source = ['//go:build linux', '', 'package x', '', 'import "fmt"', 'import "os"', ''].join('\n');
      const refs = parseImports(source, 'go');
      assert.equal(refs.length, 2);
      for (const ref of refs) {
        assert.equal(ref.condition, 'linux', '条件文件里的 import 都该带条件');
      }
    });

    it('无条件文件里的 import 不带条件标记', () => {
      const refs = parseImports('package x\n\nimport "fmt"\n', 'go');
      assert.equal(refs[0].condition, undefined);
    });

    it('package 子句之后的 //go:build 不算约束', () => {
      // Go 规范：约束注释必须在 package 之前
      const tag = findGoBuildTag('package x\n\n//go:build linux\n');
      assert.equal(tag, null);
    });
  });

  describe('模块路径的发现', () => {
    it('读出 go.mod 的 module 行', () => {
      assert.equal(findGoModulePath(TEST_DIR), 'github.com/foo/bar');
    });

    it('没有 go.mod 时返回 null', () => {
      assert.equal(findGoModulePath(join(tmpdir(), 'zelto-nonexistent-xyz')), null);
    });
  });

  describe('import 路径的解析', () => {
    it('以 module path 开头 → 项目内部，返回包目录路径', () => {
      const resolved = resolveGoImport('github.com/foo/bar/internal/core', 'github.com/foo/bar');
      assert.equal(resolved, 'internal/core');
    });

    it('正好是 module path → 根目录', () => {
      const resolved = resolveGoImport('github.com/foo/bar', 'github.com/foo/bar');
      assert.equal(resolved, '.');
    });

    it('不是本模块 → 外部依赖（null）', () => {
      assert.equal(resolveGoImport('github.com/other/pkg', 'github.com/foo/bar'), null);
    });

    it('没有 module path 时一律判外部', () => {
      assert.equal(resolveGoImport('github.com/foo/bar/internal/core', null), null);
    });
  });

  describe('跨模块依赖边', () => {
    it('项目内部的 import 产生跨模块边', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      const edge = scan.edges.find((e) => e.from === 'internal/engine' && e.to === 'internal/core');
      assert.ok(edge, `应产生 internal/engine → internal/core 的边，实际：${JSON.stringify(scan.edges)}`);
      assert.ok(edge.specifiers.includes('github.com/foo/bar/internal/core'));
    });

    it('外部依赖不产生边', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      for (const edge of scan.edges) {
        assert.ok(!edge.to.includes('other'), '外部模块不该成为模块边');
      }
    });

    it('标准库不产生边', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      for (const edge of scan.edges) {
        assert.ok(edge.to !== 'fmt' && edge.to !== 'os', '标准库不该成为模块');
      }
    });
  });

  describe('Go 计入「已验证」', () => {
    it('Go 文件参与 import 图', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      const goFiles = scan.files.filter((f) => f.lang === 'go');
      assert.ok(goFiles.length >= 2, `Go 文件应参与扫描，实际 ${goFiles.length} 个`);
    });

    it('覆盖面报告里 go 变成「已验证」', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      assert.ok(scan.coverage.verifiable.includes('go'), 'go 应在可验证类别里');
    });

    it('模块概况里 Go 代码既算「代码」也算「已验证」', () => {
      const scan = scanArchitecture(TEST_DIR, MODULES);
      const report = buildArchitectureReport(MODULES, scan);
      const core = report.modules.find((m) => m.name === 'internal/core');
      assert.ok(core);
      assert.ok(core.codeFileCount > 0, 'Go 代码文件要算进「代码」');
      assert.equal(core.codeFileCount, core.verifiedFileCount, 'Go 文件全都验过了');
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
