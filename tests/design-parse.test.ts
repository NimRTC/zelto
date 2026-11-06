// 设计正文的模块解析（core/design/parse.ts）
//
// 为什么值得单独测：设计正文里的模块声明是模型用自然语言写的，
// 格式不统一。以前解析得太粗，散文会被当成模块名 ——
// 报告里就多出一堆「依赖指向不存在的模块」这种假结论。
//
// 噪声进了报告，报告就没人看；报告没人看，可追溯链就断了。
// 所以这一层的口径必须有测试钉住。
//
// C3: 纯文本计算，不调模型、不触网

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseDesignModules, parseFieldList } from '../src/core/design/parse.js';

// ─── 列表型字段 ──────────────────────────────────────────────────────────────

describe('parseFieldList', () => {
  it('剥掉反引号', () => {
    assert.deepEqual(parseFieldList('`src/core/ports`, `src/core/events`'), [
      'src/core/ports',
      'src/core/events',
    ]);
  });

  it('方括号里的才是列表，括号后面的说明丢掉', () => {
    assert.deepEqual(parseFieldList('[无]（作为核心层，被其他模块依赖）'), []);
    assert.deepEqual(parseFieldList('[src/core, src/cli]（这两个是顶层）'), [
      'src/core',
      'src/cli',
    ]);
  });

  it('条目尾部的括号注释丢掉', () => {
    assert.deepEqual(parseFieldList('src/core（核心层）'), ['src/core']);
  });

  it('「无」类占位词当成空', () => {
    assert.deepEqual(parseFieldList('无'), []);
    assert.deepEqual(parseFieldList('无依赖'), []);
    assert.deepEqual(parseFieldList('none'), []);
    assert.deepEqual(parseFieldList('n/a'), []);
    assert.deepEqual(parseFieldList('-'), []);
  });

  it('顿号与换行也是分隔符', () => {
    assert.deepEqual(parseFieldList('src/a、src/b'), ['src/a', 'src/b']);
    assert.deepEqual(parseFieldList('src/a\nsrc/b'), ['src/a', 'src/b']);
  });

  it('重复项只留一份', () => {
    assert.deepEqual(parseFieldList('src/a, src/a'), ['src/a']);
  });

  it('空输入返回空数组', () => {
    assert.deepEqual(parseFieldList(''), []);
    assert.deepEqual(parseFieldList(undefined), []);
    assert.deepEqual(parseFieldList(null), []);
  });

  it('markdown 链接形式的依赖名留下可读部分', () => {
    // `[根命令模块](#2-根命令模块)` —— 锚点是给渲染器看的，不是模块名
    assert.deepEqual(parseFieldList('[根命令模块](#2-根命令模块)'), ['根命令模块']);
  });
});

// ─── 模块声明 ────────────────────────────────────────────────────────────────

const BODY = [
  '# 设计标题',
  '',
  '## 模块分解',
  '',
  '### src/core',
  '- **职责**：核心逻辑',
  '- **文件路径**：`src/core/**/*.ts`',
  '- **依赖模块**：[无]',
  '',
  '### src/cli',
  '- **职责**：命令行入口',
  '- **文件路径**：`src/cli/**/*.ts`',
  '- **依赖模块**：`src/core`, `src/llm`',
  '',
  '## 数据流',
  '这里还有别的章节，不该被当成模块。',
  '',
].join('\n');

describe('parseDesignModules', () => {
  it('按「### 模块名」切出模块', () => {
    const modules = parseDesignModules(BODY);
    assert.deepEqual(
      modules.map((m) => m.name),
      ['src/core', 'src/cli'],
    );
  });

  it('解析职责、文件路径、依赖模块', () => {
    const modules = parseDesignModules(BODY);
    assert.equal(modules[0].description, '核心逻辑');
    assert.deepEqual(modules[0].filePatterns, ['src/core/**/*.ts']);
    assert.deepEqual(modules[0].dependencies, []);
    assert.equal(modules[1].description, '命令行入口');
    assert.deepEqual(modules[1].filePatterns, ['src/cli/**/*.ts']);
    assert.deepEqual(modules[1].dependencies, ['src/core', 'src/llm']);
  });

  it('正文里没有模块时返回空数组', () => {
    assert.deepEqual(parseDesignModules('# 标题\n\n只是一段话。\n'), []);
  });

  it('模块名里的括号与路径写法原样保留', () => {
    const modules = parseDesignModules(
      [
        '### 3. 数据分析模块（位于 `src/core/report/`）',
        '- **文件路径**：`src/core/report/**`',
        '',
      ].join('\n'),
    );
    assert.equal(modules[0].name, '3. 数据分析模块（位于 `src/core/report/`）');
    assert.deepEqual(modules[0].filePatterns, ['src/core/report/**']);
  });

  it('缺字段的模块不报错，只是字段为空', () => {
    const modules = parseDesignModules('### 只有名字\n\n正文里没有任何字段。\n');
    assert.equal(modules.length, 1);
    assert.equal(modules[0].name, '只有名字');
    assert.equal(modules[0].description, '');
    assert.deepEqual(modules[0].filePatterns, []);
    assert.deepEqual(modules[0].dependencies, []);
  });

  it('最后一个模块不会被丢掉', () => {
    // 正则的前瞻在这里会失配：文末那一节既没有下一个 `###` 也没有 `##`
    const modules = parseDesignModules(
      [
        '### 第一个',
        '- **职责**：一',
        '',
        '### 最后一个',
        '- **职责**：末',
        '',
      ].join('\n'),
    );
    assert.deepEqual(
      modules.map((m) => m.name),
      ['第一个', '最后一个'],
    );
  });

  it('代码围栏里的 `###` 不算模块声明', () => {
    const modules = parseDesignModules(
      [
        '### 真模块',
        '- **职责**：一',
        '',
        '```bash',
        '### 这只是注释',
        '```',
        '',
      ].join('\n'),
    );
    assert.deepEqual(
      modules.map((m) => m.name),
      ['真模块'],
    );
  });

  it('`##` 章节结束当前模块', () => {
    const modules = parseDesignModules(
      [
        '### 甲',
        '- **职责**：一',
        '',
        '## 下一章',
        '',
        '### 乙',
        '- **职责**：二',
        '',
      ].join('\n'),
    );
    assert.deepEqual(
      modules.map((m) => m.name),
      ['甲', '乙'],
    );
  });
});
