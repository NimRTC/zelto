// 依赖名解析（core/arch/resolve.ts）
//
// 设计里写的依赖名有两类：模块名，和路径（`src/core/ports`）。
// 路径那一类以前一律被报成「依赖指向不存在的模块」——
// 那是噪声，不是证据：设计写 `src/core/ports`，
// 实际意思是「依赖 src/core 这一片里的 ports 部分」。
//
// C3: 纯计算，不调模型、不触网

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveDependencyNames, moduleAliases } from '../src/core/arch/resolve.js';
import type { ModuleSpec, ScanResult } from '../src/core/arch/types.js';

function scan(moduleFiles: Record<string, string[]>): ScanResult {
  return {
    files: [],
    moduleFiles: new Map(Object.entries(moduleFiles)),
    moduleCodeFiles: new Map(),
    moduleVerifiedFiles: new Map(),
    moduleProductionFiles: new Map(),
    edges: [],
    unmapped: [],
    unresolved: [],
    coverage: {
      counts: {
        typescript: 0,
        python: 0,
        cpp: 0,
        go: 0,
        rust: 0,
        java: 0,
        csharp: 0,
        build: 0,
        doc: 0,
        config: 0,
        other: 0,
      },
      verifiable: [],
      verifiedFiles: 0,
      unverifiableCodeFiles: 0,
      nonCodeFiles: 0,
      totalFiles: 0,
      // ADR-065：vendor 文件数
      vendorFiles: 0,
      // ADR-066：测试文件数
      testFiles: 0,
    },
    // ADR-065：vendor 边界
    vendorDirs: [],
    vendorFiles: [],
    vendorModules: [],
  };
}

const MODULES: ModuleSpec[] = [
  { name: 'src/core', description: '', filePatterns: [], dependencies: [] },
  { name: 'src/cli', description: '', filePatterns: [], dependencies: [] },
  { name: 'src/adapters', description: '', filePatterns: [], dependencies: [] },
];

describe('resolveDependencyNames', () => {
  it('名字正好是模块名时原样返回', () => {
    const resolved = resolveDependencyNames(
      ['src/core', 'src/cli'],
      MODULES,
      scan({ 'src/core': ['src/core/a.ts'], 'src/cli': ['src/cli/b.ts'] }),
    );
    assert.equal(resolved.get('src/core'), 'src/core');
    assert.equal(resolved.get('src/cli'), 'src/cli');
  });

  it('路径按文件归属解析到模块', () => {
    const resolved = resolveDependencyNames(
      ['src/core/ports'],
      MODULES,
      scan({
        'src/core': ['src/core/a.ts', 'src/core/ports/llm.ts'],
        'src/cli': ['src/cli/b.ts'],
        'src/adapters': ['src/adapters/c.ts'],
      }),
    );
    assert.equal(resolved.get('src/core/ports'), 'src/core');
  });

  it('路径下的文件分属多个模块时判不出来', () => {
    const resolved = resolveDependencyNames(
      ['src/shared'],
      MODULES,
      scan({
        'src/core': ['src/shared/x.ts'],
        'src/cli': ['src/shared/y.ts'],
      }),
    );
    assert.equal(resolved.get('src/shared'), null);
  });

  it('路径下没有文件时判不出来', () => {
    const resolved = resolveDependencyNames(
      ['src/nothing'],
      MODULES,
      scan({ 'src/core': ['src/core/a.ts'] }),
    );
    assert.equal(resolved.get('src/nothing'), null);
  });

  it('模块名与路径同名时优先认模块名', () => {
    const resolved = resolveDependencyNames(
      ['src/core'],
      MODULES,
      scan({ 'src/core': ['src/core/a.ts'] }),
    );
    assert.equal(resolved.get('src/core'), 'src/core');
  });

  it('尾部的斜杠不影响归属判定', () => {
    const resolved = resolveDependencyNames(
      ['src/core/ports/'],
      MODULES,
      scan({ 'src/core': ['src/core/ports/llm.ts'] }),
    );
    assert.equal(resolved.get('src/core/ports/'), 'src/core');
  });
});

describe('模块名的括号短名（ZD-011）', () => {
  // 实战病灶：设计里的模块名写成「中文描述 (标识符)」，
  // 而「依赖模块」那一栏写的是标识符（`ice` / `device`）。
  // 精确匹配一个都匹配不上 → 全被报成「未知模块」→ 架构护栏 deny → 门禁开不了。

  const NAMED_MODULES: ModuleSpec[] = [
    { name: '网络适配层 (ice)', description: '', filePatterns: [], dependencies: [] },
    { name: '设备管理层 (device)', description: '', filePatterns: [], dependencies: [] },
    { name: '参考实现 (examples)', description: '', filePatterns: [], dependencies: [] },
  ];

  it('moduleAliases 取出括号里的标识符', () => {
    assert.deepEqual(moduleAliases('网络适配层 (ice)'), ['ice']);
    assert.deepEqual(moduleAliases('设备管理层（device）'), ['device']);
    assert.deepEqual(moduleAliases('参考实现 (examples)'), ['examples']);
  });

  it('没有括号就没有短名', () => {
    assert.deepEqual(moduleAliases('src/core'), []);
    assert.deepEqual(moduleAliases(''), []);
  });

  it('括号里不是标识符形状 → 没有短名（不猜）', () => {
    assert.deepEqual(moduleAliases('核心层 (作为基础，被依赖)'), []);
    assert.deepEqual(moduleAliases('模块 (a b)'), []);
  });

  it('短名可以是路径形状（plugins/hw）', () => {
    // 短名可能本身是「某个目录下的子集」的写法 —— 不允许斜杠的话
    // 这种写法一个都匹配不上 → 全被报成未知模块。
    assert.deepEqual(moduleAliases('插件层 (plugins/hw)'), ['plugins/hw']);
  });

  it('依赖名按短名解析到模块', () => {
    const resolved = resolveDependencyNames(
      ['ice', 'device', 'examples'],
      NAMED_MODULES,
      scan({
        '网络适配层 (ice)': ['src/modules/ice/a.cpp'],
        '设备管理层 (device)': ['src/modules/audio_device/b.cpp'],
        '参考实现 (examples)': ['examples/c.js'],
      }),
    );
    assert.equal(resolved.get('ice'), '网络适配层 (ice)');
    assert.equal(resolved.get('device'), '设备管理层 (device)');
    assert.equal(resolved.get('examples'), '参考实现 (examples)');
  });

  it('短名匹配优先于路径归属（作者起了短名，比目录里正好有文件更可信）', () => {
    const resolved = resolveDependencyNames(
      ['ice'],
      NAMED_MODULES,
      scan({
        '网络适配层 (ice)': ['src/modules/ice/a.cpp'],
        '参考实现 (examples)': ['ice/b.js'],
      }),
    );
    assert.equal(resolved.get('ice'), '网络适配层 (ice)');
  });

  it('两个模块抢同一个短名 → 判不出来（设计本身有歧义，解析层不替它选）', () => {
    const ambiguous: ModuleSpec[] = [
      { name: '网络适配层 (net)', description: '', filePatterns: [], dependencies: [] },
      { name: '网络抽象 (net)', description: '', filePatterns: [], dependencies: [] },
    ];
    const resolved = resolveDependencyNames(['net'], ambiguous, scan({}));
    assert.equal(resolved.get('net'), null);
  });

  it('完整名依然精确优先（不改变原有行为）', () => {
    const resolved = resolveDependencyNames(
      ['网络适配层 (ice)'],
      NAMED_MODULES,
      scan({ '网络适配层 (ice)': ['src/modules/ice/a.cpp'] }),
    );
    assert.equal(resolved.get('网络适配层 (ice)'), '网络适配层 (ice)');
  });
});
