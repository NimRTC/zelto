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

import { resolveDependencyNames } from '../src/core/arch/resolve.js';
import type { ModuleSpec, ScanResult } from '../src/core/arch/types.js';

function scan(moduleFiles: Record<string, string[]>): ScanResult {
  return {
    files: [],
    moduleFiles: new Map(Object.entries(moduleFiles)),
    moduleCodeFiles: new Map(),
    edges: [],
    unmapped: [],
    unresolved: [],
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
