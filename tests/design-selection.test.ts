// 默认设计选取（core/design/selection.ts）
//
// 为什么这条规则要单独存在：DesignStore.list() 按创建时间倒序返回，
// 于是「取第一份 confirmed」拿到的是**最新创建**的设计——通常是一份
// 局部功能的设计，而不是描述整个仓库的基线设计。后果是 `zelto arch check`
// 拿局部设计对照全仓，全部文件被判「无归属」，结论完全误导；
// 门禁护栏用同一份设计，于是正常写集被判 unmapped_file 而 blocked。
//
// 选取规则：优先项目基线设计（requirementId === '__project__'），
// 没有才退到「最新的已确认设计」。

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  PROJECT_REQUIREMENT_ID,
  otherConfirmedDesigns,
  pickDefaultDesign,
} from '../src/core/design/selection.js';
import type { DesignSummary } from '../src/core/design/types.js';

function summary(partial: Partial<DesignSummary> & { id: string }): DesignSummary {
  return {
    title: partial.id,
    requirementId: 'req-1',
    status: 'confirmed',
    moduleCount: 1,
    createdAt: '2026-11-01T00:00:00.000Z',
    ...partial,
  };
}

describe('pickDefaultDesign', () => {
  it('没有已确认设计时返回 null', () => {
    const designs = [
      summary({ id: 'd1', status: 'draft' }),
      summary({ id: 'd2', status: 'superseded' }),
    ];
    assert.equal(pickDefaultDesign(designs), null);
  });

  it('没有基线设计时选最新的已确认设计', () => {
    const older = summary({ id: 'older', createdAt: '2026-01-01T00:00:00.000Z' });
    const newer = summary({ id: 'newer', createdAt: '2026-06-01T00:00:00.000Z' });
    assert.equal(pickDefaultDesign([older, newer])?.id, 'newer');
    // 顺序反了也一样 —— 函数不依赖调用方的排序
    assert.equal(pickDefaultDesign([newer, older])?.id, 'newer');
  });

  it('有基线设计时选基线，不管它是不是最新的', () => {
    const baseline = summary({
      id: 'baseline',
      requirementId: PROJECT_REQUIREMENT_ID,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const local = summary({ id: 'local', createdAt: '2026-11-01T00:00:00.000Z' });
    assert.equal(pickDefaultDesign([local, baseline])?.id, 'baseline');
    assert.equal(pickDefaultDesign([baseline, local])?.id, 'baseline');
  });

  it('基线设计未确认时不选它', () => {
    const baselineDraft = summary({
      id: 'baseline',
      requirementId: PROJECT_REQUIREMENT_ID,
      status: 'draft',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const confirmed = summary({ id: 'confirmed', createdAt: '2026-11-01T00:00:00.000Z' });
    assert.equal(pickDefaultDesign([baselineDraft, confirmed])?.id, 'confirmed');
  });

  it('多份基线设计时取最新的一份', () => {
    const old = summary({
      id: 'old',
      requirementId: PROJECT_REQUIREMENT_ID,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const recent = summary({
      id: 'recent',
      requirementId: PROJECT_REQUIREMENT_ID,
      createdAt: '2026-11-01T00:00:00.000Z',
    });
    assert.equal(pickDefaultDesign([old, recent])?.id, 'recent');
  });

  it('空输入返回 null', () => {
    assert.equal(pickDefaultDesign([]), null);
  });
});

describe('otherConfirmedDesigns', () => {
  const designs = [
    summary({ id: 'baseline', requirementId: PROJECT_REQUIREMENT_ID }),
    summary({ id: 'local-1' }),
    summary({ id: 'local-2' }),
    summary({ id: 'draft-1', status: 'draft' }),
  ];

  it('列出除已选中之外的其它已确认设计', () => {
    const others = otherConfirmedDesigns(designs, 'baseline');
    assert.deepEqual(
      others.map((d) => d.id),
      ['local-1', 'local-2'],
    );
  });

  it('不列出未确认的设计', () => {
    const others = otherConfirmedDesigns(designs, 'local-1');
    assert.ok(!others.some((d) => d.id === 'draft-1'));
  });

  it('没有选中设计时返回空列表', () => {
    assert.deepEqual(otherConfirmedDesigns(designs, null), []);
  });
});
