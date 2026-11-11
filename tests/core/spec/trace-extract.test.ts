import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  extractAcceptanceCriteria,
  extractRequirements,
  materializeRequirements,
} from '../../../src/core/spec/trace-extract.js';

describe('extractAcceptanceCriteria', () => {
  it('extracts numbered items from the acceptance section', () => {
    const spec = ['## 验收标准', '', '1. 第一条', '2. 第二条'].join('\n');
    const items = extractAcceptanceCriteria(spec);
    assert.deepEqual(items.map((i) => i.text), ['第一条', '第二条']);
    assert.ok(items.every((i) => i.source === 'acceptance'));
  });

  it('returns an empty array when the section is absent', () => {
    assert.deepEqual(extractAcceptanceCriteria('## 目的\n\n内容\n'), []);
  });

  // ADR-050：验收标准的续行是同一条目的一部分。
  // 只取编号行本行的话，「验证方式：……」整段丢掉 ——
  // 骨架里的用例名只剩半句，agent 追的是残缺的契约。
  it('joins continuation lines into the numbered item', () => {
    const spec = [
      '## 验收标准',
      '',
      '1. `signal_source` 判别式存在，且能表达三种来源；',
      '   验证方式：单元测试对三种取值各断言一次，且默认值是「未指定」。',
    ].join('\n');

    const items = extractAcceptanceCriteria(spec);
    assert.equal(items.length, 1);
    assert.equal(
      items[0].text,
      '`signal_source` 判别式存在，且能表达三种来源； 验证方式：单元测试对三种取值各断言一次，且默认值是「未指定」。',
    );
  });

  it('does not swallow the next item after a continuation', () => {
    const spec = [
      '## 验收标准',
      '',
      '1. 第一条',
      '   续行。',
      '2. 第二条',
      '   续行。',
    ].join('\n');

    assert.deepEqual(
      extractAcceptanceCriteria(spec).map((i) => i.text),
      ['第一条 续行。', '第二条 续行。'],
    );
  });

  it('treats an unindented following line as a separate paragraph, not a continuation', () => {
    const spec = ['## 验收标准', '', '1. 第一条', '普通段落', '2. 第二条'].join('\n');
    const items = extractAcceptanceCriteria(spec).map((i) => i.text);
    assert.deepEqual(items, ['第一条', '第二条']);
  });
});

describe('extractRequirements', () => {
  it('joins continuation lines for bullet items too', () => {
    const spec = ['## 需求', '', '- 第一条需求', '  续行说明'].join('\n');
    assert.deepEqual(
      extractRequirements(spec).map((i) => i.text),
      ['第一条需求 续行说明'],
    );
  });
});

describe('materializeRequirements', () => {
  it('keeps existing declarations over spec-derived ones', () => {
    const spec = ['## 验收标准', '', '1. 从规格来的'].join('\n');
    assert.deepEqual(materializeRequirements(['人声明的'], spec), ['人声明的']);
  });

  it('falls back to the spec when nothing is declared', () => {
    const spec = ['## 验收标准', '', '1. 从规格来的', '   续行。'].join('\n');
    assert.deepEqual(materializeRequirements([], spec), ['从规格来的 续行。']);
  });
});
