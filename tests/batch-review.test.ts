// `zelto batch` 的判定逻辑测试
//
// 这条命令是 core/sched/batch.ts 唯一的入口 —— 那个模块此前写好了却没人调用，
// 是死代码。测试分两层：
//   1. 判定层（reviewBatch / planBatchPhases / evaluateBatchConflicts）—— 直接测 core
//   2. 命令层（zelto batch）—— 跑真实 CLI 进程，验证「读事实 → 判定 → 渲染」这条链
//
// C3: 判定确定 —— 同样的输入永远得到同样的结论

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  reviewBatch,
  planBatchPhases,
  evaluateBatchConflicts,
  groupIssues,
} from '../src/core/sched/batch.js';
import type { BatchMember } from '../src/core/sched/batch.js';

/** 造一个「一切就绪」的切片事实，只改要测的那一项 */
function makeMember(id: string, overrides: Partial<BatchMember> = {}): BatchMember {
  return {
    id,
    state: 'frozen',
    writes: [`src/${id}.ts`],
    specFrozen: true,
    specDrift: false,
    trace: { requirements: 1, contracts: 1, tests: 1 },
    traceWaiver: false,
    acceptancePresent: true,
    budgetExhausted: false,
    ...overrides,
  };
}

describe('reviewBatch — 准入审核', () => {
  it('全部就绪时 ready 为 true', () => {
    const r = reviewBatch([makeMember('a'), makeMember('b')]);
    assert.equal(r.ready, true);
    assert.equal(r.errorCount, 0);
    assert.equal(r.slices.length, 2);
  });

  it('状态不是 frozen/completed 时阻断', () => {
    const r = reviewBatch([makeMember('a', { state: 'draft' })]);
    assert.equal(r.ready, false);
    assert.equal(r.issues[0].code, 'state_not_frozen');
    assert.equal(r.issues[0].severity, 'error');
  });

  it('completed 状态算可开工', () => {
    const r = reviewBatch([makeMember('a', { state: 'completed' })]);
    assert.equal(r.ready, true);
  });

  it('规格未冻结时阻断', () => {
    const r = reviewBatch([makeMember('a', { specFrozen: false })]);
    assert.equal(r.ready, false);
    assert.ok(r.issues.some((i) => i.code === 'spec_not_frozen'));
  });

  it('规格漂移时阻断', () => {
    const r = reviewBatch([makeMember('a', { specDrift: true })]);
    assert.equal(r.ready, false);
    assert.ok(r.issues.some((i) => i.code === 'spec_drift'));
  });

  it('没有需求追溯时阻断', () => {
    const r = reviewBatch([makeMember('a', { trace: { requirements: 0, contracts: 1, tests: 1 } })]);
    assert.ok(r.issues.some((i) => i.code === 'no_requirements'));
  });

  it('没有契约引用时阻断', () => {
    const r = reviewBatch([makeMember('a', { trace: { requirements: 1, contracts: 0, tests: 1 } })]);
    assert.ok(r.issues.some((i) => i.code === 'no_contracts'));
  });

  it('有豁免记录时允许没有契约引用', () => {
    const r = reviewBatch([
      makeMember('a', { trace: { requirements: 1, contracts: 0, tests: 1 }, traceWaiver: true }),
    ]);
    assert.equal(r.ready, true);
    assert.ok(!r.issues.some((i) => i.code === 'no_contracts'));
  });

  it('没有测试追溯时阻断', () => {
    const r = reviewBatch([makeMember('a', { trace: { requirements: 1, contracts: 1, tests: 0 } })]);
    assert.ok(r.issues.some((i) => i.code === 'no_tests'));
  });

  it('验收测试目录不存在时阻断', () => {
    const r = reviewBatch([makeMember('a', { acceptancePresent: false })]);
    assert.ok(r.issues.some((i) => i.code === 'acceptance_missing'));
  });

  it('写集为空时阻断', () => {
    const r = reviewBatch([makeMember('a', { writes: [] })]);
    assert.ok(r.issues.some((i) => i.code === 'no_write_set'));
  });

  it('预算耗尽时阻断', () => {
    const r = reviewBatch([makeMember('a', { budgetExhausted: true })]);
    assert.ok(r.issues.some((i) => i.code === 'budget_exhausted'));
  });

  it('问题按切片归位——每条 issue 都带 sliceId', () => {
    const r = reviewBatch([makeMember('a', { writes: [] }), makeMember('b', { writes: [] })]);
    assert.equal(r.issues.length, 2);
    assert.deepEqual(r.issues.map((i) => i.sliceId).sort(), ['a', 'b']);
  });
});

describe('planBatchPhases — 依赖分阶段', () => {
  it('无依赖时全在一个阶段', () => {
    const plan = planBatchPhases(['a', 'b'], new Map([['a', []], ['b', []]]));
    assert.equal(plan.cycle, null);
    assert.equal(plan.phases.length, 1);
    assert.deepEqual(plan.phases[0].sort(), ['a', 'b']);
  });

  it('线性依赖排成多个阶段', () => {
    const plan = planBatchPhases(
      ['a', 'b', 'c'],
      new Map([['a', []], ['b', ['a']], ['c', ['b']]]),
    );
    assert.equal(plan.phases.length, 3);
    assert.deepEqual(plan.phases[0], ['a']);
    assert.deepEqual(plan.phases[1], ['b']);
    assert.deepEqual(plan.phases[2], ['c']);
  });

  it('成环时报出环路径且不给阶段', () => {
    const plan = planBatchPhases(
      ['a', 'b'],
      new Map([['a', ['b']], ['b', ['a']]]),
    );
    assert.notEqual(plan.cycle, null);
    assert.equal(plan.phases.length, 0);
    assert.equal(plan.issues[0].code, 'dependency_cycle');
    assert.equal(plan.issues[0].sliceId, null);
  });
});

describe('evaluateBatchConflicts — 同阶段冲突', () => {
  it('同阶段写集重叠时判 error', () => {
    const members = [
      makeMember('a', { writes: ['src/shared.ts'] }),
      makeMember('b', { writes: ['src/shared.ts'] }),
    ];
    const issues = evaluateBatchConflicts(members, [['a', 'b']]);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, 'write_set_overlap');
    assert.equal(issues[0].severity, 'error');
  });

  it('同阶段写集不重叠时无冲突', () => {
    const members = [
      makeMember('a', { writes: ['src/a.ts'] }),
      makeMember('b', { writes: ['src/b.ts'] }),
    ];
    assert.equal(evaluateBatchConflicts(members, [['a', 'b']]).length, 0);
  });

  it('跨阶段不查写集重叠——阶段之间本来就允许改同一批文件', () => {
    const members = [
      makeMember('a', { writes: ['src/shared.ts'] }),
      makeMember('b', { writes: ['src/shared.ts'] }),
    ];
    const issues = evaluateBatchConflicts(members, [['a'], ['b']]);
    assert.equal(issues.length, 0);
  });
});

describe('groupIssues — 分组', () => {
  it('按严重程度分开', () => {
    const { errors, warnings } = groupIssues([
      { sliceId: 'a', severity: 'error', code: 'x', message: 'm' },
      { sliceId: 'a', severity: 'warning', code: 'y', message: 'm' },
      { sliceId: null, severity: 'error', code: 'z', message: 'm' },
    ]);
    assert.equal(errors.length, 2);
    assert.equal(warnings.length, 1);
  });
});
