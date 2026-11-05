// 亲和分组调度的判定测试（ADR-024）
//
// 亲和只改变同阶段内「谁先谁后」，不改变阶段划分；
// 分组是确定性纯计算（C3）：同输入必得同分组，不调模型、不触网。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  affinityPrefixOf,
  affinityPreviousOf,
  planAffinityGroups,
  splitPhaseByAffinity,
} from '../src/core/sched/batch.js';
import type { WriteSetMember } from '../src/core/sched/batch.js';

function member(id: string, writes: string[]): WriteSetMember {
  return { id, writes };
}

function deps(map: Record<string, string[]>): Map<string, string[]> {
  return new Map(Object.entries(map));
}

describe('planAffinityGroups — 分组规则', () => {
  it('同写集前缀的两片进同组', () => {
    const plan = planAffinityGroups(
      [member('a', ['src/core/sched/engine.ts']), member('b', ['src/core/sched/batch.ts'])],
      deps({}),
    );
    assert.equal(plan.groups.get('a'), plan.groups.get('b'));
    assert.notEqual(plan.groups.get('a'), null);
    assert.equal(plan.affinityGroups.length, 1);
    assert.equal(plan.affinityGroups[0].reason, 'writes-prefix');
  });

  it('依赖 B -> A 时 A、B 同组（原因 dep）', () => {
    const plan = planAffinityGroups(
      [member('a', ['src/a.ts']), member('b', ['src/b.ts'])],
      deps({ b: ['a'] }),
    );
    assert.equal(plan.groups.get('a'), plan.groups.get('b'));
    assert.equal(plan.affinityGroups[0].reason, 'dep');
  });

  it('同设计模块的两片进同组', () => {
    const plan = planAffinityGroups(
      [member('a', ['src/a.ts']), member('b', ['src/b.ts'])],
      deps({}),
      new Map([['a', ['mod-x']], ['b', ['mod-x']]]),
    );
    assert.equal(plan.groups.get('a'), plan.groups.get('b'));
    assert.equal(plan.affinityGroups[0].reason, 'module');
  });

  it('无命中时为 null，语义与原来一致', () => {
    const plan = planAffinityGroups(
      [member('a', ['src/a.ts']), member('b', ['docs/b.md'])],
      deps({}),
    );
    assert.equal(plan.groups.get('a'), null);
    assert.equal(plan.groups.get('b'), null);
    assert.equal(plan.affinityGroups.length, 0);
  });

  it('同输入两次结果完全一致（含组内排序）', () => {
    const members = [
      member('c', ['src/core/x.ts']),
      member('a', ['src/core/y.ts']),
      member('b', ['src/core/z.ts']),
    ];
    const first = planAffinityGroups(members, deps({ b: ['a'] }));
    const second = planAffinityGroups(members, deps({ b: ['a'] }));
    assert.deepEqual(
      [...first.groups.entries()].sort(),
      [...second.groups.entries()].sort(),
    );
    assert.deepEqual(first.affinityGroups, second.affinityGroups);
    for (const g of first.affinityGroups) {
      assert.deepEqual(g.members, [...g.members].sort());
    }
  });
});

describe('affinityPrefixOf — 写集主前缀', () => {
  it('取前两段目录，众数决胜，票平取字典序最小', () => {
    assert.equal(affinityPrefixOf(['src/core/sched/engine.ts']), 'src/core');
    assert.equal(
      affinityPrefixOf(['src/core/a.ts', 'src/core/b.ts', 'docs/x.md']),
      'src/core',
    );
    assert.equal(affinityPrefixOf([]), null);
  });
});

describe('affinityPreviousOf — 组内前序', () => {
  it('组首为空，其余为组内排前面的 id（按 id 排序）', () => {
    const plan = planAffinityGroups(
      [member('b', ['src/core/b.ts']), member('a', ['src/core/a.ts'])],
      deps({}),
    );
    const prev = affinityPreviousOf(plan);
    assert.deepEqual(prev.get('a'), []);
    assert.deepEqual(prev.get('b'), ['a']);
  });
});

describe('splitPhaseByAffinity — 阶段内串行切分', () => {
  it('同组切片分散到不同轮，无组切片只在第 0 轮', () => {
    const plan = planAffinityGroups(
      [
        member('a', ['src/core/a.ts']),
        member('b', ['src/core/b.ts']),
        member('c', ['docs/c.md']),
      ],
      deps({}),
    );
    const rounds = splitPhaseByAffinity(['a', 'b', 'c'], plan.groups);
    assert.equal(rounds.length, 2);
    // 第 0 轮含无组片 c 与组内首片 a；第 1 轮只剩 b
    assert.deepEqual(rounds[0].sort(), ['a', 'c']);
    assert.deepEqual(rounds[1], ['b']);
  });

  it('无命中（全 null）时返回原阶段单轮，与 ADR-019 语义一致', () => {
    const rounds = splitPhaseByAffinity(
      ['a', 'b'],
      new Map([['a', null], ['b', null]]),
    );
    assert.deepEqual(rounds, [['a', 'b']]);
  });

  it('亲和不跨阶段：逐阶段切分绝不把跨阶段切片拉到同一轮', () => {
    const plan = planAffinityGroups(
      [member('a', ['src/core/a.ts']), member('c', ['src/core/c.ts'])],
      deps({}),
    );
    // a 与 c 同组，但分属两个执行阶段 → 各自切分，轮次互不合并
    assert.equal(plan.groups.get('a'), plan.groups.get('c'));
    const rounds0 = splitPhaseByAffinity(['a'], plan.groups);
    const rounds1 = splitPhaseByAffinity(['c'], plan.groups);
    assert.deepEqual(rounds0, [['a']]);
    assert.deepEqual(rounds1, [['c']]);
  });
});
