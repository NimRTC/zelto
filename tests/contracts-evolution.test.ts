// 契约演进引擎的判定口径测试（ADR-036）
//
// 这里是「收窄 = 写入方破坏 / 放宽 = 读取方破坏」这条规则的护栏。
// 判错方向会直接把「兼容」说成「破坏」，人就不敢签字了。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { diffSchemas, countBreaking, hasBreaking } from '../src/core/contracts/evolution.js';

type Schema = Record<string, unknown>;

function kinds(before: Schema, after: Schema): string[] {
  return diffSchemas(before, after).filter((c) => c.breaking).map((c) => c.kind);
}

describe('diffSchemas —— 写入方破坏（新契约不再接受旧数据）', () => {
  it('新增必填字段是写入方破坏', () => {
    const changes = diffSchemas(
      { type: 'object', properties: { a: { type: 'string' } } },
      { type: 'object', required: ['a'], properties: { a: { type: 'string' } } },
    );
    const breaking = changes.filter((c) => c.breaking);
    assert.equal(breaking.length, 1);
    assert.equal(breaking[0].direction, 'writer');
    assert.ok(breaking[0].kind.includes('required'));
  });

  it('type 收窄是写入方破坏', () => {
    const changes = diffSchemas(
      { type: ['string', 'null'] },
      { type: 'string' },
    );
    const breaking = changes.filter((c) => c.breaking);
    assert.equal(breaking.length, 1);
    assert.equal(breaking[0].direction, 'writer');
  });

  it('enum 删除取值是写入方破坏', () => {
    const changes = diffSchemas(
      { enum: ['a', 'b'] },
      { enum: ['a'] },
    );
    const breaking = changes.filter((c) => c.breaking);
    assert.equal(breaking.length, 1);
    assert.equal(breaking[0].direction, 'writer');
  });

  it('新增 enum 约束是写入方破坏（旧数据的取值不再都被接受）', () => {
    const changes = diffSchemas({ type: 'string' }, { type: 'string', enum: ['a'] });
    const breaking = changes.filter((c) => c.breaking);
    assert.equal(breaking.length, 1);
    assert.equal(breaking[0].direction, 'writer');
  });

  it('additionalProperties 收紧为 false 是写入方破坏', () => {
    const changes = diffSchemas({ type: 'object' }, { type: 'object', additionalProperties: false });
    const breaking = changes.filter((c) => c.breaking);
    assert.equal(breaking.length, 1);
    assert.equal(breaking[0].direction, 'writer');
  });

  it('抬高下界 / 收紧上界是写入方破坏', () => {
    assert.ok(kinds({ minimum: 0 }, { minimum: 1 }).includes('minimum_raised'));
    assert.ok(kinds({ maximum: 10 }, { maximum: 5 }).includes('maximum_lowered'));
    assert.ok(kinds({ minLength: 1 }, { minLength: 2 }).includes('min_length_raised'));
    assert.ok(kinds({ maxLength: 10 }, { maxLength: 5 }).includes('max_length_lowered'));
  });

  it('删除 property 声明：新契约仍允许额外字段时不破坏', () => {
    const changes = diffSchemas(
      { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } } },
      { type: 'object', properties: { a: { type: 'string' } } },
    );
    assert.equal(countBreaking(changes), 0);
  });

  it('删除 property 声明：新契约封闭（additionalProperties=false）时是写入方破坏', () => {
    const changes = diffSchemas(
      { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } } },
      { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false },
    );
    const breaking = changes.filter((c) => c.breaking);
    // 两处：删除的字段声明本身，以及 additionalProperties 收紧为 false
    assert.equal(breaking.length, 2);
    assert.ok(breaking.every((c) => c.direction === 'writer'));
    assert.ok(breaking.some((c) => c.kind === 'property_removed'));
    assert.ok(breaking.some((c) => c.kind === 'additional_properties_closed'));
  });

  it('新增 items 约束是写入方破坏', () => {
    const changes = diffSchemas({ type: 'array' }, { type: 'array', items: { type: 'string' } });
    const breaking = changes.filter((c) => c.breaking);
    assert.equal(breaking.length, 1);
    assert.equal(breaking[0].direction, 'writer');
  });
});

describe('diffSchemas —— 读取方破坏（新数据旧程序读不懂）', () => {
  it('取消必填是读取方破坏', () => {
    const changes = diffSchemas(
      { type: 'object', required: ['a'], properties: { a: { type: 'string' } } },
      { type: 'object', properties: { a: { type: 'string' } } },
    );
    const breaking = changes.filter((c) => c.breaking);
    assert.equal(breaking.length, 1);
    assert.equal(breaking[0].direction, 'reader');
  });

  it('type 放宽是读取方破坏', () => {
    const changes = diffSchemas({ type: 'string' }, { type: ['string', 'null'] });
    const breaking = changes.filter((c) => c.breaking);
    assert.equal(breaking.length, 1);
    assert.equal(breaking[0].direction, 'reader');
  });

  it('enum 新增取值是读取方破坏', () => {
    const changes = diffSchemas({ enum: ['a'] }, { enum: ['a', 'b'] });
    const breaking = changes.filter((c) => c.breaking);
    assert.equal(breaking.length, 1);
    assert.equal(breaking[0].direction, 'reader');
  });

  it('additionalProperties 放宽是读取方破坏', () => {
    const changes = diffSchemas(
      { type: 'object', additionalProperties: false },
      { type: 'object' },
    );
    const breaking = changes.filter((c) => c.breaking);
    assert.equal(breaking.length, 1);
    assert.equal(breaking[0].direction, 'reader');
  });

  it('降低下界 / 抬高上界是读取方破坏', () => {
    assert.ok(kinds({ minimum: 1 }, { minimum: 0 }).includes('minimum_lowered'));
    assert.ok(kinds({ maximum: 5 }, { maximum: 10 }).includes('maximum_raised'));
  });

  it('新增可选字段且旧契约封闭时是读取方破坏', () => {
    const changes = diffSchemas(
      { type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } },
      { type: 'object', additionalProperties: false, properties: { a: { type: 'string' }, b: { type: 'string' } } },
    );
    const breaking = changes.filter((c) => c.breaking);
    assert.equal(breaking.length, 1);
    assert.equal(breaking[0].direction, 'reader');
  });
});

describe('diffSchemas —— 非破坏与递归', () => {
  it('完全相同的契约没有破坏性变化', () => {
    const schema: Schema = {
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string', enum: ['x', 'y'] } },
    };
    assert.equal(countBreaking(diffSchemas(schema, schema)), 0);
  });

  it('没有基线时只记一条「新增契约」，不算破坏', () => {
    const changes = diffSchemas(null, { type: 'object' });
    assert.equal(changes.length, 1);
    assert.equal(changes[0].breaking, false);
    assert.equal(hasBreaking(changes), false);
  });

  it('嵌套 property 的变化会带上路径', () => {
    const changes = diffSchemas(
      { type: 'object', properties: { outer: { type: 'object', properties: { inner: { type: 'string' } } } } },
      { type: 'object', properties: { outer: { type: 'object', properties: { inner: { type: 'number' } } } } },
    );
    const breaking = changes.filter((c) => c.breaking);
    assert.equal(breaking.length, 1);
    assert.equal(breaking[0].path, '$.properties.outer.properties.inner.type');
  });

  it('pattern 改变按「无法确定兼容」处理，算破坏', () => {
    const changes = diffSchemas({ type: 'string', pattern: '^a' }, { type: 'string', pattern: '^b' });
    const breaking = changes.filter((c) => c.breaking);
    assert.equal(breaking.length, 1);
    assert.equal(breaking[0].direction, 'writer');
  });

  it('不认识的 JSON Schema 关键字不产生破坏性结论', () => {
    const changes = diffSchemas(
      { type: 'object', anyOf: [{ type: 'string' }] },
      { type: 'object', anyOf: [{ type: 'number' }] },
    );
    assert.equal(countBreaking(changes), 0);
  });
});
