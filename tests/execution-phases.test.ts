// 执行阶段规划的判定测试（G-1 依赖分层 + G-2 写集冲突降级）
//
// 这套判定决定「谁跟谁一起跑」——并行度算错就是两种事故：
//   - 该串行的没串行 → 后面的切片抢跑，前置产物还不存在（必然失败）
//   - 该并行的没并行 → 「高速」是假的，白白等
//
// C3: 判定确定 —— 同样的输入永远得到同样的计划

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { planExecutionPhases } from '../src/core/sched/batch.js';
import type { WriteSetMember } from '../src/core/sched/batch.js';

function member(id: string, writes: string[]): WriteSetMember {
  return { id, writes };
}

function deps(map: Record<string, string[]>): Map<string, string[]> {
  return new Map(Object.entries(map));
}

describe('planExecutionPhases — 依赖分层（G-1）', () => {
  it('没有依赖时全部放同一阶段（并行）', () => {
    const plan = planExecutionPhases(
      [member('a', ['src/a.ts']), member('b', ['src/b.ts']), member('c', ['src/c.ts'])],
      deps({}),
    );
    assert.equal(plan.cycle, null);
    assert.equal(plan.phases.length, 1);
    assert.deepEqual(plan.phases[0].sort(), ['a', 'b', 'c']);
  });

  it('有依赖时分层：b 依赖 a 则 b 在后一个阶段', () => {
    const plan = planExecutionPhases(
      [member('a', ['src/a.ts']), member('b', ['src/b.ts'])],
      deps({ b: ['a'] }),
    );
    assert.deepEqual(plan.phases, [['a'], ['b']]);
  });

  it('依赖链分三层', () => {
    const plan = planExecutionPhases(
      [member('a', ['src/a.ts']), member('b', ['src/b.ts']), member('c', ['src/c.ts'])],
      deps({ b: ['a'], c: ['b'] }),
    );
    assert.deepEqual(plan.phases, [['a'], ['b'], ['c']]);
  });

  it('依赖指向不在批次里的切片时忽略（不是本批的前置）', () => {
    const plan = planExecutionPhases(
      [member('a', ['src/a.ts']), member('b', ['src/b.ts'])],
      deps({ b: ['zzz'] }),
    );
    assert.equal(plan.cycle, null);
    assert.equal(plan.phases.length, 1);
  });

  it('依赖成环时报出环路径，不给阶段', () => {
    const plan = planExecutionPhases(
      [member('a', ['src/a.ts']), member('b', ['src/b.ts'])],
      deps({ a: ['b'], b: ['a'] }),
    );
    assert.ok(plan.cycle);
    assert.equal(plan.phases.length, 0);
  });

  it('同一层内的无关切片仍然并行', () => {
    const plan = planExecutionPhases(
      [member('a', ['src/a.ts']), member('b', ['src/b.ts']), member('c', ['src/c.ts'])],
      deps({ c: ['a'] }),
    );
    assert.equal(plan.phases.length, 2);
    assert.deepEqual(plan.phases[0].sort(), ['a', 'b']);
    assert.deepEqual(plan.phases[1], ['c']);
  });
});

describe('planExecutionPhases — 写集冲突降级（G-2）', () => {
  it('写集重叠的切片被拆成两个阶段，不整批 abort', () => {
    const plan = planExecutionPhases(
      [member('a', ['src/types.ts']), member('b', ['src/types.ts'])],
      deps({}),
    );
    assert.equal(plan.cycle, null);
    assert.equal(plan.phases.length, 2);
    assert.deepEqual(plan.phases[0], ['a']);
    assert.deepEqual(plan.phases[1], ['b']);
    assert.equal(plan.downgrades.length, 1);
    assert.equal(plan.downgrades[0].sliceId, 'b');
    assert.deepEqual(plan.downgrades[0].conflictsWith, ['a']);
  });

  it('冲突降级不影响无冲突的切片并行', () => {
    const plan = planExecutionPhases(
      [
        member('a', ['src/types.ts']),
        member('b', ['src/types.ts']),
        member('c', ['src/other.ts']),
        member('d', ['src/other2.ts']),
      ],
      deps({}),
    );
    // a 与 b 串行；c、d 与谁都不冲突，可以在第一阶段一起跑
    assert.equal(plan.phases.length, 2);
    assert.deepEqual(plan.phases[0].sort(), ['a', 'c', 'd']);
    assert.deepEqual(plan.phases[1], ['b']);
  });

  it('目录前缀写集也算重叠', () => {
    const plan = planExecutionPhases(
      [member('a', ['src/core/']), member('b', ['src/core/types.ts'])],
      deps({}),
    );
    assert.equal(plan.phases.length, 2);
  });

  it('同一批输入永远得到同一份计划（贪心着色是确定性的）', () => {
    const members = [
      member('z', ['src/types.ts']),
      member('a', ['src/types.ts']),
      member('m', ['src/types.ts']),
    ];
    const first = planExecutionPhases(members, deps({}));
    const second = planExecutionPhases([...members].reverse(), deps({}));
    assert.deepEqual(first.phases, second.phases);
    // id 排序决定顺序：a 先跑
    assert.deepEqual(first.phases[0], ['a']);
  });

  it('每个阶段内部的切片写集互不重叠', () => {
    const members = [
      member('a', ['src/types.ts']),
      member('b', ['src/types.ts']),
      member('c', ['src/core/']),
      member('d', ['src/core/x.ts']),
    ];
    const plan = planExecutionPhases(members, deps({}));

    for (const phase of plan.phases) {
      for (let i = 0; i < phase.length; i++) {
        for (let j = i + 1; j < phase.length; j++) {
          const wa = members.find((m) => m.id === phase[i])!.writes;
          const wb = members.find((m) => m.id === phase[j])!.writes;
          const overlap = wa.some((x) => wb.some((y) => x === y));
          assert.equal(overlap, false, `${phase[i]} 与 ${phase[j]} 不该在同一阶段`);
        }
      }
    }
  });
});
