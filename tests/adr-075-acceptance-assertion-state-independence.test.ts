// ADR-075 · 验收断言必须与「切片是否已合并」无关
//
// 病灶（实测于 nimrtc-zelto，2026-11-18）：
//
//   agent 在验收测试里加「写集边界」断言，判据写成
//   「`git diff --name-only` 非空」「必须包含某文件」。
//   这种判据**只在切片尚未合并时成立**：
//   门禁在 worktree 里跑时绿，切片合并、worktree 清理后主干复跑变红。
//
//   「这次切片改了哪些文件」是**历史事件**（合并前后不一样）；
//   「这次切片的产物在不在树上」是**状态**（合并前后一样）。
//   追溯链（C4）要求结论可复现 → 断言必须判状态。
//
// ADR-034 的骨架只负责「每条验收标准一条 todo 用例」，
// 从来没告诉 agent「写集边界断言该怎么写」—— 真空在这里被填上。
//
// 这个文件钉住两件事：
//   1. 骨架里必须出现状态式的判据模板（ls-files / 在树上）；
//   2. 骨架里**不得**出现「必须存在未提交改动」这类脆表述作为判据。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildAcceptanceSkeleton, WRITE_SET_ASSERTION_GUIDE } from '../src/core/spec/skeleton.js';

describe('ADR-075 · 骨架带「写集边界断言的正确写法」', () => {
  const skeleton = buildAcceptanceSkeleton('v1-demo', ['第一条验收标准']);

  it('骨架里有写集边界那一节', () => {
    assert.match(skeleton, /写集边界断言/);
  });

  it('给出状态式判据：产物在树上（ls-files）', () => {
    // 状态式判据的关键词必须出现
    assert.match(skeleton, /ls-files/);
    assert.match(skeleton, /在树上/);
  });

  it('明确点破旧写法为什么错：git diff 只在未合并状态成立', () => {
    assert.match(skeleton, /git diff/);
    assert.match(skeleton, /未合并/);
    // 必须说清「历史事件 vs 状态」这个区别
    assert.match(skeleton, /历史事件/);
  });

  it('给出可抄的辅助函数形态', () => {
    assert.match(skeleton, /function gitLsFiles/);
    assert.match(skeleton, /spawnSync\('git'/);
  });

  it('越界守卫明确交给运行时守卫（C9），不在验收测试里重做', () => {
    // 必须说清「越界由 C9 负责」——否则 agent 会自己写一个必然误报的版本
    assert.match(skeleton, /越界/);
    assert.match(skeleton, /PreToolUse/);
    // 明确劝退「基点之后的提交动了什么」这条脆判据
    assert.match(skeleton, /不要/);
  });

  it('导出的指南与骨架里嵌的那份一致', () => {
    assert.ok(skeleton.includes(WRITE_SET_ASSERTION_GUIDE));
  });
});

describe('ADR-075 · 骨架不得把脆判据当成正确写法', () => {
  const skeleton = buildAcceptanceSkeleton('v1-demo', ['第一条验收标准']);

  it('「必须存在未提交改动」只能作为反例出现，不能作为判据', () => {
    // 反例行会被标成「错（只在未合并状态成立）」——
    // 断言它出现时**必须**跟着那个标记，否则就是把它当判据教给了 agent。
    const lines = skeleton.split('\n');
    for (const line of lines) {
      if (!/必须存在已追踪文件的改动|必须存在未提交改动/.test(line)) continue;
      // 反例块要么在「错（…）」那一段里，要么紧邻明确的错误标记
      const before = lines.slice(0, lines.indexOf(line)).join('\n');
      const isCounterExample =
        /错（只在未合并状态成立）/.test(before.split('\n').slice(-12).join('\n')) ||
        /对（任何状态都成立）/.test(before.split('\n').slice(-12).join('\n'));
      assert.ok(
        isCounterExample,
        `脆判据必须只作为反例出现，不能被当成正确写法：${line.trim()}`,
      );
    }
  });

  it('骨架里的 todo 用例一条不少', () => {
    const skeleton = buildAcceptanceSkeleton('v1-demo', ['甲要成立', '乙要成立']);
    const todos = skeleton.match(/test\.todo\(/g) ?? [];
    assert.equal(todos.length, 2);
  });
});
