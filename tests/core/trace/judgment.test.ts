// 追溯判据的单元测试 —— 单一真源（core/trace/judgment.ts）
//
// 三处调用方（门禁① zelto check、批量审核 zelto batch、规格校验 validateDeterministic）
// 都调这一个判据，所以它的语义就是全项目的追溯语义，改这里等于改三处。
//
// C3: 判定确定 —— 同样的输入永远得到同样的结论

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { judgeTrace, traceCountsOf } from '../../../src/core/trace/index.js';

const FULL = { requirements: 1, contracts: 1, tests: 1 };

describe('judgeTrace — 追溯判据', () => {
  it('三条都齐时合格', () => {
    const j = judgeTrace({ trace: FULL, waiver: null });
    assert.equal(j.ok, true);
    assert.equal(j.violations.length, 0);
    assert.equal(j.waived, false);
  });

  it('缺需求时不合格', () => {
    const j = judgeTrace({ trace: { ...FULL, requirements: 0 }, waiver: null });
    assert.equal(j.ok, false);
    assert.deepEqual(j.violations.map((v) => v.code), ['no_requirements']);
  });

  it('缺契约时不合格', () => {
    const j = judgeTrace({ trace: { ...FULL, contracts: 0 }, waiver: null });
    assert.deepEqual(j.violations.map((v) => v.code), ['no_contracts']);
  });

  it('缺测试时不合格', () => {
    const j = judgeTrace({ trace: { ...FULL, tests: 0 }, waiver: null });
    assert.deepEqual(j.violations.map((v) => v.code), ['no_tests']);
  });

  it('三条都缺时按需求→契约→测试的固定顺序报出', () => {
    const j = judgeTrace({ trace: { requirements: 0, contracts: 0, tests: 0 }, waiver: null });
    assert.deepEqual(j.violations.map((v) => v.code), ['no_requirements', 'no_contracts', 'no_tests']);
  });

  it('有豁免理由时整体豁免三条', () => {
    const j = judgeTrace({
      trace: { requirements: 0, contracts: 0, tests: 0 },
      waiver: '基线切片 — 不修改代码',
    });
    assert.equal(j.ok, true);
    assert.equal(j.waived, true);
    assert.equal(j.waiverReason, '基线切片 — 不修改代码');
    assert.equal(j.violations.length, 0);
  });

  it('豁免理由为空串时不生效', () => {
    const j = judgeTrace({ trace: { requirements: 0, contracts: 1, tests: 1 }, waiver: '' });
    assert.equal(j.waived, false);
    assert.deepEqual(j.violations.map((v) => v.code), ['no_requirements']);
  });

  it('豁免理由只有空白时也不生效', () => {
    const j = judgeTrace({ trace: { requirements: 0, contracts: 1, tests: 1 }, waiver: '   ' });
    assert.equal(j.waived, false);
    assert.equal(j.violations.length, 1);
  });

  it('没给豁免字段等同于未豁免', () => {
    const j = judgeTrace({ trace: { requirements: 0, contracts: 1, tests: 1 } });
    assert.equal(j.waived, false);
    assert.equal(j.violations.length, 1);
  });
});

describe('traceCountsOf — 从切片追溯取条数', () => {
  it('取三条的条数', () => {
    const c = traceCountsOf({ requirements: ['R1', 'R2'], contracts: ['C1'], tests: [] });
    assert.deepEqual(c, { requirements: 2, contracts: 1, tests: 0 });
  });
});
