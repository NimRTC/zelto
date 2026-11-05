// 架构偏离检查（G-4/B）测试
//
// 分两层：
//   1. 判定层（import 解析 / 相对路径解析 / 扫描 / 报告）—— 直接测 core/arch
//   2. 命令层（zelto arch check）—— 跑真实 CLI 进程
//
// C3: 判定确定 —— 同样的输入永远得到同样的结论

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

import {
  buildArchitectureReport,
  classifySpecifier,
  detectLang,
  findCycles,
  matchModuleBySpecifier,
  parseImports,
  resolveRelative,
  scanArchitecture,
  type ModuleSpec,
} from '../src/core/arch/index.js';

// ─── import 解析 ──────────────────────────────────────────────────────────────

describe('import 解析', () => {
  it('认出 TS 的四种 import 写法', () => {
    const source = [
      "import fs from 'node:fs';",
      "import { a } from './a';",
      "export { b } from './b';",
      "const c = require('./c');",
      "const d = await import('./d');",
    ].join('\n');
    const refs = parseImports(source, 'ts');
    const specifiers = refs.map((r) => r.specifier);
    assert.ok(specifiers.includes('node:fs'));
    assert.ok(specifiers.includes('./a'));
    assert.ok(specifiers.includes('./b'));
    assert.ok(specifiers.includes('./c'));
    assert.ok(specifiers.includes('./d'));
  });

  it('相对路径 / 包 / 内置分得清', () => {
    assert.equal(classifySpecifier('./x'), 'relative');
    assert.equal(classifySpecifier('../x'), 'relative');
    assert.equal(classifySpecifier('node:fs'), 'builtin');
    assert.equal(classifySpecifier('fs'), 'builtin');
    assert.equal(classifySpecifier('react'), 'package');
  });

  it('认出 Python 的 import', () => {
    const source = ['import os', 'from pathlib import Path', 'from .mod import thing'].join('\n');
    const refs = parseImports(source, 'python');
    const specifiers = refs.map((r) => r.specifier);
    assert.ok(specifiers.includes('os'));
    assert.ok(specifiers.includes('pathlib'));
    assert.ok(specifiers.includes('.mod'));
  });

  it('行号是 1 基的', () => {
    const source = "import a from './a';\nimport b from './b';";
    const refs = parseImports(source, 'ts');
    const b = refs.find((r) => r.specifier === './b');
    assert.equal(b?.line, 2);
  });

  it('按扩展名判定语言', () => {
    assert.equal(detectLang('src/a.ts'), 'ts');
    assert.equal(detectLang('src/a.py'), 'python');
    assert.equal(detectLang('docs/a.md'), null);
  });

  it('包说明符按最后一段匹配模块名', () => {
    assert.equal(matchModuleBySpecifier('@app/db', ['db', 'exporter']), 'db');
    assert.equal(matchModuleBySpecifier('lodash', ['db']), null);
    assert.equal(matchModuleBySpecifier('@app/db', ['core/db']), 'core/db');
  });
});

// ─── 相对路径解析 ────────────────────────────────────────────────────────────

describe('相对 import 解析', () => {
  const fileSet = new Set([
    'src/core/a.ts',
    'src/core/b.ts',
    'src/core/sub/index.ts',
    'src/core/sub/deep.ts',
  ]);

  it('解析到同名文件', () => {
    assert.equal(resolveRelative('src/core/x.ts', './b', fileSet), 'src/core/b.ts');
  });

  it('解析到目录里的 index 文件', () => {
    assert.equal(resolveRelative('src/core/x.ts', './sub', fileSet), 'src/core/sub/index.ts');
  });

  it('解析上一级目录', () => {
    assert.equal(resolveRelative('src/core/sub/x.ts', '../b', fileSet), 'src/core/b.ts');
  });

  it('解析不到时返回 null', () => {
    assert.equal(resolveRelative('src/core/x.ts', './nope', fileSet), null);
  });
});

// ─── 扫描与报告 ──────────────────────────────────────────────────────────────

interface Fixture {
  root: string;
  modules: ModuleSpec[];
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'zelto-arch-'));

  await mkdir(join(root, 'src', 'exporter'), { recursive: true });
  await mkdir(join(root, 'src', 'db'), { recursive: true });
  await mkdir(join(root, 'src', 'utils'), { recursive: true });

  await writeFile(
    join(root, 'src', 'exporter', 'index.ts'),
    "import { read } from '../db';\nimport { fmt } from '../utils';\n",
    'utf-8',
  );
  await writeFile(join(root, 'src', 'db', 'index.ts'), "export const read = () => {};\n", 'utf-8');
  await writeFile(join(root, 'src', 'utils', 'index.ts'), "export const fmt = () => '';\n", 'utf-8');
  await writeFile(join(root, 'src', 'loose.ts'), "export const x = 1;\n", 'utf-8');

  const modules: ModuleSpec[] = [
    {
      name: 'exporter',
      description: '导出',
      filePatterns: ['src/exporter/**'],
      dependencies: ['db'],
    },
    {
      name: 'db',
      description: '读数据',
      filePatterns: ['src/db/**'],
      dependencies: [],
    },
    {
      name: 'utils',
      description: '工具',
      filePatterns: ['src/utils/**'],
      dependencies: [],
    },
  ];

  return { root, modules };
}

describe('架构扫描', () => {
  let fixture: Fixture;

  before(async () => {
    fixture = await makeFixture();
  });

  after(async () => {
    await rm(fixture.root, { recursive: true, force: true });
  });

  it('算出模块之间的实际依赖', async () => {
    const scan = scanArchitecture(fixture.root, fixture.modules);
    const edges = scan.edges.map((e) => `${e.from}→${e.to}`).sort();
    assert.deepEqual(edges, ['exporter→db', 'exporter→utils']);
  });

  it('模块名与文件对应', async () => {
    const scan = scanArchitecture(fixture.root, fixture.modules);
    assert.deepEqual(scan.moduleFiles.get('exporter'), ['src/exporter/index.ts']);
  });

  it('没有模块认领的文件被记下来', async () => {
    const scan = scanArchitecture(fixture.root, fixture.modules);
    assert.ok(scan.unmapped.includes('src/loose.ts'));
  });
});

describe('架构报告', () => {
  it('设计没声明的依赖被标成未声明依赖', async () => {
    const fixture = await makeFixture();
    const scan = scanArchitecture(fixture.root, fixture.modules);
    const report = buildArchitectureReport(fixture.modules, scan);
    const undeclared = report.deviations.find((d) => d.kind === 'undeclared_dependency');
    assert.equal(undeclared?.from, 'exporter');
    assert.equal(undeclared?.to, 'utils');
    assert.equal(report.ok, false);
    await rm(fixture.root, { recursive: true, force: true });
  });

  it('设计声明了但代码里没有的依赖被标成缺失依赖', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zelto-arch-missing-'));
    await mkdir(join(root, 'src', 'a'), { recursive: true });
    await mkdir(join(root, 'src', 'b'), { recursive: true });
    await writeFile(join(root, 'src', 'a', 'index.ts'), 'export const a = 1;\n', 'utf-8');
    await writeFile(join(root, 'src', 'b', 'index.ts'), 'export const b = 1;\n', 'utf-8');

    const modules: ModuleSpec[] = [
      { name: 'a', description: '', filePatterns: ['src/a/**'], dependencies: ['b'] },
      { name: 'b', description: '', filePatterns: ['src/b/**'], dependencies: [] },
    ];
    const scan = scanArchitecture(root, modules);
    const report = buildArchitectureReport(modules, scan);
    assert.ok(report.deviations.some((d) => d.kind === 'missing_dependency'));
    await rm(root, { recursive: true, force: true });
  });

  it('依赖指向不存在的模块被标成未知模块', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zelto-arch-ghost-'));
    await mkdir(join(root, 'src', 'a'), { recursive: true });
    await writeFile(join(root, 'src', 'a', 'index.ts'), 'export const a = 1;\n', 'utf-8');

    const modules: ModuleSpec[] = [
      { name: 'a', description: '', filePatterns: ['src/a/**'], dependencies: ['ghost'] },
    ];
    const scan = scanArchitecture(root, modules);
    const report = buildArchitectureReport(modules, scan);
    assert.ok(report.deviations.some((d) => d.kind === 'unknown_module'));
    await rm(root, { recursive: true, force: true });
  });

  it('设计完全对得上时没有偏离', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zelto-arch-clean-'));
    await mkdir(join(root, 'src', 'a'), { recursive: true });
    await mkdir(join(root, 'src', 'b'), { recursive: true });
    await writeFile(join(root, 'src', 'a', 'index.ts'), "import { b } from '../b';\n", 'utf-8');
    await writeFile(join(root, 'src', 'b', 'index.ts'), 'export const b = 1;\n', 'utf-8');

    const modules: ModuleSpec[] = [
      { name: 'a', description: '', filePatterns: ['src/a/**'], dependencies: ['b'] },
      { name: 'b', description: '', filePatterns: ['src/b/**'], dependencies: [] },
    ];
    const scan = scanArchitecture(root, modules);
    const report = buildArchitectureReport(modules, scan);
    assert.equal(report.deviations.length, 0);
    assert.equal(report.ok, true);
    await rm(root, { recursive: true, force: true });
  });

  it('实际依赖成环会被找出来', () => {
    const cycles = findCycles([
      { from: 'a', to: 'b', files: [], specifiers: [] },
      { from: 'b', to: 'a', files: [], specifiers: [] },
    ]);
    assert.equal(cycles.length, 1);
    assert.ok(cycles[0].length >= 2);
  });

  it('两个模块用同样具体的范围抢一个文件，被标成歧义', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zelto-arch-ambig-'));
    await mkdir(join(root, 'src', 'shared'), { recursive: true });
    await writeFile(join(root, 'src', 'shared', 'x.ts'), 'export const x = 1;\n', 'utf-8');

    const modules: ModuleSpec[] = [
      { name: 'a', description: '', filePatterns: ['src/shared/*.ts'], dependencies: [] },
      { name: 'b', description: '', filePatterns: ['src/shared/*.ts'], dependencies: [] },
    ];
    const scan = scanArchitecture(root, modules);
    const report = buildArchitectureReport(modules, scan);
    assert.ok(report.deviations.some((d) => d.kind === 'ambiguous_module'));
    await rm(root, { recursive: true, force: true });
  });

  it('父模块的范围盖住子模块时不算歧义', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zelto-arch-nested-'));
    await mkdir(join(root, 'src', 'shared'), { recursive: true });
    await writeFile(join(root, 'src', 'shared', 'x.ts'), 'export const x = 1;\n', 'utf-8');

    const modules: ModuleSpec[] = [
      { name: 'a', description: '', filePatterns: ['src/**'], dependencies: [] },
      { name: 'b', description: '', filePatterns: ['src/shared/**'], dependencies: [] },
    ];
    const scan = scanArchitecture(root, modules);
    const report = buildArchitectureReport(modules, scan);
    assert.ok(!report.deviations.some((d) => d.kind === 'ambiguous_module'));
    await rm(root, { recursive: true, force: true });
  });
});

// ─── 命令层 ──────────────────────────────────────────────────────────────────

const CLI_SCRIPT = join(process.cwd(), 'dist', 'cli', 'index.js');

function runCli(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI_SCRIPT, ...args], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ZELTO_SKIP_LLM: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    child.on('error', reject);
    setTimeout(() => { child.kill(); reject(new Error('timeout')); }, 20000).unref();
  });
}

describe('zelto arch check', () => {
  let testDir: string;

  before(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'zelto-arch-cli-'));
    await mkdir(join(testDir, '.zelto', 'design'), { recursive: true });
    await mkdir(join(testDir, 'src', 'a'), { recursive: true });
    await mkdir(join(testDir, 'src', 'b'), { recursive: true });
    await writeFile(join(testDir, 'src', 'a', 'index.ts'), "import { b } from '../b';\n", 'utf-8');
    await writeFile(join(testDir, 'src', 'b', 'index.ts'), 'export const b = 1;\n', 'utf-8');

    const design = {
      id: 'dsg-test',
      requirementId: 'req-test',
      title: '测试设计',
      body: '',
      modules: [
        { name: 'a', description: '', filePatterns: ['src/a/**'], dependencies: [] },
        { name: 'b', description: '', filePatterns: ['src/b/**'], dependencies: [] },
      ],
      status: 'confirmed',
      supersedes: null,
      createdAt: new Date().toISOString(),
      confirmedAt: new Date().toISOString(),
    };
    await writeFile(
      join(testDir, '.zelto', 'design', 'dsg-test.json'),
      JSON.stringify(design, null, 2),
      'utf-8',
    );
  });

  after(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('给出偏离报告', async () => {
    const { stdout, code } = await runCli(testDir, 'arch', 'check');
    assert.equal(code, 0);
    assert.ok(stdout.includes('架构偏离检查'));
    assert.ok(stdout.includes('未声明依赖'));
  });

  it('--strict 时有偏离就返回 1', async () => {
    const { code } = await runCli(testDir, 'arch', 'check', '--strict');
    assert.equal(code, 1);
  });

  it('--json 给出结构化结果', async () => {
    const { stdout, code } = await runCli(testDir, 'arch', 'check', '--json');
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.design.id, 'dsg-test');
    assert.ok(Array.isArray(parsed.report.deviations));
  });

  it('找不到设计时返回 1', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'zelto-arch-empty-'));
    const { code } = await runCli(emptyDir, 'arch', 'check');
    assert.equal(code, 1);
    await rm(emptyDir, { recursive: true, force: true });
  });
});
