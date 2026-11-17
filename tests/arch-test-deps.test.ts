import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isTestFile, partitionTestFiles } from '../src/core/arch/test-files.js';
import { scanArchitecture } from '../src/core/arch/scan.js';
import { buildArchitectureReport } from '../src/core/arch/report.js';
import type { ModuleSpec } from '../src/core/arch/types.js';

// ─── 测试文件识别 ──────────────────────────────────────────────────────────

test('isTestFile：目录级 —— tests 目录下的文件是测试', () => {
  assert.equal(isTestFile('src/plugins/tests/test_foo.cpp'), true);
  assert.equal(isTestFile('src/__tests__/a.ts'), true);
  assert.equal(isTestFile('tests/unit/b.test.ts'), true);
  assert.equal(isTestFile('src/spec/foo.rb'), true);
});

test('isTestFile：目录级 —— test_ 前缀的目录（testdata 除外）', () => {
  assert.equal(isTestFile('src/test_helpers/util.ts'), true);
  // testdata 是测试**数据**，不是测试代码 —— 不该被排除出依赖图
  assert.equal(isTestFile('src/testdata/sample.json'), false);
});

test('isTestFile：文件名级 —— 各种生态的测试命名', () => {
  assert.equal(isTestFile('src/foo_test.cpp'), true);
  assert.equal(isTestFile('src/foo_test.go'), true);
  assert.equal(isTestFile('src/test_foo.ts'), true);
  assert.equal(isTestFile('src/FooTest.java'), true);
  assert.equal(isTestFile('src/FooTests.cs'), true);
  assert.equal(isTestFile('src/foo_spec.rb'), true);
  assert.equal(isTestFile('src/test.ts'), true);
});

test('isTestFile：生产代码不是测试', () => {
  assert.equal(isTestFile('src/core/log.ts'), false);
  assert.equal(isTestFile('src/core/contest/entry.ts'), false);
  assert.equal(isTestFile('src/core/latest.ts'), false);
  assert.equal(isTestFile('src/protest/handler.ts'), false);
});

test('partitionTestFiles：把路径分成测试与生产两组', () => {
  const { testFiles, productionFiles } = partitionTestFiles([
    'src/a.ts',
    'src/tests/b.ts',
    'src/c_test.ts',
  ]);
  assert.deepEqual(testFiles, ['src/tests/b.ts', 'src/c_test.ts']);
  assert.deepEqual(productionFiles, ['src/a.ts']);
});

// ─── 依赖图：测试文件不产生依赖边 ─────────────────────────────────────────

function makeProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'zelto-arch-test-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf-8');
  }
  return root;
}

const MODULES: ModuleSpec[] = [
  { name: 'src/core', description: '', filePatterns: ['src/core/**'], dependencies: [] },
  { name: 'src/plugins', description: '', filePatterns: ['src/plugins/**'], dependencies: [] },
  { name: 'src/modules', description: '', filePatterns: ['src/modules/**'], dependencies: [] },
];

test('测试文件不产生依赖边（ADR-066）', () => {
  const root = makeProject({
    'src/core/index.ts': "export const a = 1;\n",
    'src/plugins/index.ts': "export const b = 1;\n",
    'src/modules/frame.ts': "export const c = 1;\n",
    // 测试引用了 src/modules —— 这不该成为架构边
    'src/plugins/tests/frame.test.ts': "import { c } from '../../modules/frame';\n",
  });

  const scan = scanArchitecture(root, MODULES);
  const edge = scan.edges.find((e) => e.from === 'src/plugins' && e.to === 'src/modules');
  assert.equal(edge, undefined, '测试文件不该产生 src/plugins → src/modules 边');
});

test('生产代码的依赖边照常产生', () => {
  const root = makeProject({
    'src/core/index.ts': "export const a = 1;\n",
    'src/plugins/index.ts': "import { a } from '../core/index';\nexport const b = a;\n",
    'src/modules/frame.ts': "export const c = 1;\n",
  });

  const scan = scanArchitecture(root, MODULES);
  const edge = scan.edges.find((e) => e.from === 'src/plugins' && e.to === 'src/core');
  assert.ok(edge, '生产代码的依赖边应该存在');
});

test('测试文件仍然归属到模块（不报「文件无归属」）', () => {
  const root = makeProject({
    'src/core/index.ts': "export const a = 1;\n",
    'src/plugins/index.ts': "export const b = 1;\n",
    'src/plugins/tests/frame.test.ts': "export const t = 1;\n",
  });

  const scan = scanArchitecture(root, MODULES);
  assert.ok(
    !scan.unmapped.includes('src/plugins/tests/frame.test.ts'),
    '测试文件应该归属到 src/plugins',
  );
});

test('报告：无归属的测试文件不报「文件无归属」偏离（zelto 自己生成的验收骨架）', () => {
  // 真实证据：`tests/acceptance/<slice>/acceptance.test.cjs` 由 zelto 生成，
  // 不属于任何设计模块。若报 unmapped_file（deny），**每个切片**都会被
  // 自己的验收文件拦住门禁 —— 死锁。
  const root = makeProject({
    'src/core/index.ts': "export const a = 1;\n",
    'tests/acceptance/s1/acceptance.test.cjs': "console.log('ok');\n",
    'src/loose.ts': "export const loose = 1;\n",
  });

  const scan = scanArchitecture(root, MODULES);
  const report = buildArchitectureReport(MODULES, scan);

  const unmappedFiles = report.deviations
    .filter((d) => d.kind === 'unmapped_file')
    .map((d) => d.to);
  assert.ok(
    !unmappedFiles.includes('tests/acceptance/s1/acceptance.test.cjs'),
    '测试文件不该报「文件无归属」',
  );
  // 生产文件的无归属仍然要报 —— 别把人真该修的事一起吞掉
  assert.ok(unmappedFiles.includes('src/loose.ts'), '生产代码的无归属必须继续报');
});

test('覆盖统计：测试文件单独计数，不混进语言分母', () => {
  const root = makeProject({
    'src/core/index.ts': "export const a = 1;\n",
    'src/core/helper.ts': "export const h = 1;\n",
    'src/plugins/tests/a.test.ts': "export const t = 1;\n",
    'src/plugins/tests/b.test.ts': "export const t = 1;\n",
  });

  const scan = scanArchitecture(root, MODULES);
  assert.equal(scan.coverage.testFiles, 2);
  // TypeScript 分母只算 2 个生产文件，不含 2 个测试文件
  assert.equal(scan.coverage.counts.typescript, 2);
  assert.equal(scan.coverage.verifiedFiles, 2);
});

test('报告：测试文件不再导致「未声明依赖」偏离', () => {
  const root = makeProject({
    'src/core/index.ts': "export const a = 1;\n",
    'src/plugins/index.ts': "export const b = 1;\n",
    'src/modules/frame.ts': "export const c = 1;\n",
    'src/plugins/tests/frame.test.ts': "import { c } from '../../modules/frame';\n",
  });

  const scan = scanArchitecture(root, MODULES);
  const report = buildArchitectureReport(MODULES, scan);
  const undeclared = report.deviations.filter((d) => d.kind === 'undeclared_dependency');
  assert.equal(undeclared.length, 0, '测试引用不该报未声明依赖');
});

test('报告：测试造成的伪环消失', () => {
  const root = makeProject({
    'src/core/index.ts': "export const a = 1;\n",
    // plugins → modules（只由测试产生）
    'src/plugins/tests/frame.test.ts': "import { c } from '../../modules/frame';\n",
    // modules → plugins（生产代码，真实依赖）
    'src/modules/adapter.ts': "import { p } from '../../plugins/index';\n",
    'src/plugins/index.ts': "export const p = 1;\n",
    'src/modules/frame.ts': "export const c = 1;\n",
  });

  const scan = scanArchitecture(root, MODULES);
  const report = buildArchitectureReport(MODULES, scan);
  assert.equal(report.cycles.length, 0, '测试不该造成依赖成环');
});

// ─── 测试模块的声明依赖不该报「缺失依赖」──────────────────────────────────

const TEST_MODULE_SPECS: ModuleSpec[] = [
  { name: 'src/core', description: '', filePatterns: ['src/core/**'], dependencies: [] },
  {
    name: 'tests',
    description: '',
    filePatterns: ['tests/**'],
    dependencies: ['src/core'],
  },
];

test('全是测试文件的模块：声明的依赖不报「缺失依赖」（ADR-066）', () => {
  const root = makeProject({
    'src/core/index.ts': "export const a = 1;\n",
    'tests/unit/a.test.ts': "import { a } from '../../src/core/index';\nexport const t = a;\n",
  });

  const scan = scanArchitecture(root, TEST_MODULE_SPECS);
  const report = buildArchitectureReport(TEST_MODULE_SPECS, scan);
  const missing = report.deviations.filter((d) => d.kind === 'missing_dependency');
  assert.equal(missing.length, 0, '测试模块的声明依赖不该报缺失依赖');
});

test('生产模块的声明依赖缺失时仍然要报（不能误放行）', () => {
  const root = makeProject({
    'src/core/index.ts': "export const a = 1;\n",
    // src/core 声明依赖 src/plugins，但代码里没有这条边
    'src/plugins/index.ts': "export const p = 1;\n",
  });

  const specs: ModuleSpec[] = [
    { name: 'src/core', description: '', filePatterns: ['src/core/**'], dependencies: ['src/plugins'] },
    { name: 'src/plugins', description: '', filePatterns: ['src/plugins/**'], dependencies: [] },
  ];

  const scan = scanArchitecture(root, specs);
  const report = buildArchitectureReport(specs, scan);
  const missing = report.deviations.filter((d) => d.kind === 'missing_dependency');
  assert.equal(missing.length, 1, '生产模块的缺失依赖必须照报');
});
