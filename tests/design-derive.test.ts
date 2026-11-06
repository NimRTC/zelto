// 设计模块声明的推导（core/design/derive.ts）
//
// 核心主张：设计文档的**正文是模块声明的真源**，
// 存的 `modules` 只是给人看的快照。
//
// 判定（架构检查、切片归属、追溯图）一律从正文重新推导，
// 这样解析口径改了，存量文档不会继续用旧口径的产物。
//
// C3: 纯文本计算，不调模型、不触网

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { deriveModules } from '../src/core/design/derive.js';
import type { DesignModule } from '../src/core/design/types.js';

const BODY = [
  '# 标题',
  '',
  '## 模块分解',
  '',
  '### core',
  '- **职责**：核心',
  '- **文件路径**：`src/core/**/*.ts`',
  '- **依赖模块**：[无]',
  '',
  '### cli',
  '- **职责**：入口',
  '- **文件路径**：`src/cli/**/*.ts`',
  '- **依赖模块**：`core`',
  '',
].join('\n');

const STALE: DesignModule[] = [
  {
    name: 'core',
    description: '旧口径写的',
    filePatterns: ['`src/core/**/*.ts`（整个目录'],
    dependencies: ['无]（作为核心层'],
  },
];

describe('deriveModules', () => {
  it('正文能解析时用推导结果（正文是真源）', () => {
    const modules = deriveModules({ body: BODY, modules: STALE });
    assert.deepEqual(
      modules.map((m) => m.name),
      ['core', 'cli'],
    );
    assert.equal(modules[0].description, '核心');
    assert.deepEqual(modules[0].filePatterns, ['src/core/**/*.ts']);
  });

  it('正文解析不出模块时退回存的 modules', () => {
    const modules = deriveModules({ body: '# 只有标题\n', modules: STALE });
    assert.deepEqual(modules, STALE);
  });

  it('正文为空时退回存的 modules', () => {
    const modules = deriveModules({ body: '', modules: STALE });
    assert.deepEqual(modules, STALE);
  });

  it('两边都没有时返回空数组', () => {
    assert.deepEqual(deriveModules({ body: '', modules: [] }), []);
    assert.deepEqual(deriveModules({ body: '没有模块', modules: [] }), []);
  });

  it('推导是幂等的：同一份文档推导两次结果相同', () => {
    const once = deriveModules({ body: BODY, modules: STALE });
    const twice = deriveModules({ body: BODY, modules: once });
    assert.deepEqual(twice, once);
  });
});
