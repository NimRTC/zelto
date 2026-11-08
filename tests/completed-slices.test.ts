// Tests for completed-slices — 已完成切片的交付状态判定
//
// 为什么要有这组测试：`completed` 同时表示「门禁②过了」与「人签过字」
// （ADR-018），同一个状态字底下压着五种现实。判定一旦漂移，
// 「有多少切片真的进了主干」这个数就会错 —— 而那正是人看板上唯一
// 拿得出手的结论。
//
// 口径全部锁在这里，不靠散落在各处的 if。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyDelivery,
  deliveryLabel,
  deliverySummaryLine,
  DELIVERY_ORDER,
  type DeliveryFacts,
  type DeliveryStatus,
} from '../src/cli/commands/completed-slices.js';

function facts(overrides: Partial<DeliveryFacts> = {}): DeliveryFacts {
  return {
    sliceState: 'completed',
    signStatus: null,
    isMergeCandidate: false,
    branchExists: false,
    mergedIntoHead: false,
    ...overrides,
  };
}

describe('交付状态判定', () => {
  it('已签字且在合并候选里 → 待合并', () => {
    assert.equal(
      classifyDelivery(facts({ signStatus: 'approved', isMergeCandidate: true })),
      'awaiting-merge',
    );
  });

  it('已签字但不在合并候选里 → 已合入主干', () => {
    // 合并候选的口径里含「已合入但 worktree 还有未提交产物」这一种，
    // 所以「不在候选里」才等于「真的合完了」。
    assert.equal(
      classifyDelivery(facts({ signStatus: 'approved', isMergeCandidate: false })),
      'merged',
    );
  });

  it('签字请求挂着 → 待签字', () => {
    assert.equal(
      classifyDelivery(facts({ signStatus: 'pending', branchExists: true })),
      'awaiting-sign',
    );
  });

  it('没签过且分支还在 → 未发起签字', () => {
    assert.equal(
      classifyDelivery(facts({ signStatus: null, branchExists: true })),
      'unsigned',
    );
  });

  it('签过又撤销且分支还在 → 未发起签字（批准作废了，等于没签）', () => {
    assert.equal(
      classifyDelivery(facts({ signStatus: 'revoked', branchExists: true })),
      'unsigned',
    );
  });

  it('没签过且没分支 → 基线切片，不算「该签字却没人签」', () => {
    // 接管既有项目时 `project scan` 生成的基线切片：产物早就在主干上了，
    // 没东西可签。把它算成「待签字」会用历史切片淹掉真正的待办。
    assert.equal(
      classifyDelivery(facts({ signStatus: null, branchExists: false })),
      'no-branch',
    );
  });

  it('分支已合入 HEAD 且没签过 → 已合入主干', () => {
    assert.equal(
      classifyDelivery(facts({ signStatus: null, branchExists: true, mergedIntoHead: true })),
      'merged',
    );
  });

  it('切片已作废 → 作废（不管有没有分支）', () => {
    assert.equal(
      classifyDelivery(facts({ sliceState: 'abandoned', branchExists: true })),
      'abandoned',
    );
  });

  it('签字被拒 → 作废', () => {
    assert.equal(
      classifyDelivery(facts({ signStatus: 'rejected', branchExists: true })),
      'abandoned',
    );
  });

  it('待签字优先于分支事实 —— 有人在签，等的是人', () => {
    // 分支还没合入 HEAD 时也仍是「待签字」，不是「未发起签字」。
    assert.equal(
      classifyDelivery(facts({ signStatus: 'pending', branchExists: true, mergedIntoHead: false })),
      'awaiting-sign',
    );
  });

  it('作废优先于一切 —— 不该再出现在任何待办里', () => {
    assert.equal(
      classifyDelivery(facts({ sliceState: 'abandoned', signStatus: 'pending', branchExists: true })),
      'abandoned',
    );
  });
});

describe('交付状态的展示', () => {
  it('每种状态都有人话标签', () => {
    for (const status of DELIVERY_ORDER) {
      assert.ok(deliveryLabel(status).length > 0, `${status} 该有标签`);
    }
  });

  it('汇总行把「已合入主干」放在最前面', () => {
    const line = deliverySummaryLine({
      total: 5,
      counts: {
        merged: 2,
        'awaiting-merge': 1,
        'awaiting-sign': 1,
        unsigned: 0,
        'no-branch': 1,
        abandoned: 0,
      },
      slices: [],
    });
    assert.ok(line.includes('已合入主干 2'), line);
    assert.ok(line.includes('待签字 1'), line);
    assert.ok(line.includes('待合并 1'), line);
  });

  it('没有已完成切片时汇总行为空', () => {
    const line = deliverySummaryLine({
      total: 0,
      counts: {
        merged: 0,
        'awaiting-merge': 0,
        'awaiting-sign': 0,
        unsigned: 0,
        'no-branch': 0,
        abandoned: 0,
      },
      slices: [],
    });
    assert.equal(line, '');
  });

  it('展示顺序里六种状态一个不少', () => {
    const expected: DeliveryStatus[] = [
      'awaiting-sign',
      'awaiting-merge',
      'unsigned',
      'merged',
      'no-branch',
      'abandoned',
    ];
    assert.deepEqual([...DELIVERY_ORDER].sort(), [...expected].sort());
  });
});
