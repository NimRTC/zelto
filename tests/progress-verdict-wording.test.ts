// 「未跑验收」与「进展不明」是两件事
//
// 病灶（实测 nimrtc-zelto v3-weaknet-verdict，2026-11-18）：
//
// D-56 报出来的 summary 是：
//
//   进展不明：规格要求 6 条验收标准、改动 4 个文件
//
// **自相矛盾**：都说了「改动 4 个文件」，还说「进展不明」。
//
// `unknown` 判定说的是**验收结论**不明（一条用例都没拿到），
// 而人看到的是**整体**不明。
// 于是「正事先都做完了、只是没跑验收」被渲染成「什么也不知道」——
// 人会以为这一轮白跑了。
//
// 判据是对的（`casesTotal=0` 时不能假装「已验证通过」），
// 错的是**词头**：
//
//   - 改了文件但没跑验收 → **未跑验收**（「没测」，不是「不知道」）
//   - 什么都没留下         → **进展不明**（「不知道」）
//
// 这条测试直接锁 `summarizeProgress` 的输出 ——
// 它是通过 `buildProgressReport` 暴露的（公开入口）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildProgressReport } from '../src/core/progress/report.js';

describe('「未跑验收」与「进展不明」是两件事', () => {
  it('改了文件但没跑验收 → 「未跑验收」，不是「进展不明」', () => {
    const report = buildProgressReport({
      criteriaTotal: 6,
      cases: [],
      todoCount: 0,
      changedFiles: ['tools/rd_lan.py', 'tools/benchmark_weaknet.py'],
    });

    assert.equal(report.verdict, 'unknown', '判定本身没变 —— 验收结论确实不明');
    assert.ok(
      report.summary.startsWith('未跑验收：'),
      `改了文件就该说「未跑验收」，实际：${report.summary}`,
    );
    assert.ok(
      !report.summary.includes('进展不明'),
      `不能说「进展不明」—— 都说改了 ${report.changedFiles.length} 个文件了`,
    );
    assert.ok(
      report.summary.includes('改动 2 个文件'),
      `改动数量要保留，实际：${report.summary}`,
    );
  });

  it('什么都没留下 → 「进展不明」', () => {
    const report = buildProgressReport({
      criteriaTotal: 6,
      cases: [],
      todoCount: 0,
      changedFiles: [],
    });

    assert.ok(
      report.summary.startsWith('进展不明：'),
      `真的一无所知才叫「进展不明」，实际：${report.summary}`,
    );
  });

  it('跑过验收且全过 → 「已全部验证」（不受这条改动影响）', () => {
    const report = buildProgressReport({
      criteriaTotal: 2,
      cases: [
        { name: '弱网下判定为不可用', status: 'pass' },
        { name: '弱网下判定为可用', status: 'pass' },
      ],
      todoCount: 0,
      changedFiles: ['tools/rd_lan.py'],
    });

    assert.equal(report.verdict, 'verified');
    assert.ok(
      report.summary.startsWith('已全部验证：'),
      `实际：${report.summary}`,
    );
  });

  it('跑过验收但有失败 → 「部分完成」/「未验证」（不受这条改动影响）', () => {
    const partial = buildProgressReport({
      criteriaTotal: 2,
      cases: [
        { name: 'A', status: 'pass' },
        { name: 'B', status: 'fail' },
      ],
      todoCount: 0,
      changedFiles: ['tools/rd_lan.py'],
    });
    assert.equal(partial.verdict, 'partial');
    assert.ok(partial.summary.startsWith('部分完成：'), `实际：${partial.summary}`);

    const unverified = buildProgressReport({
      criteriaTotal: 2,
      cases: [{ name: 'A', status: 'fail' }],
      todoCount: 0,
      changedFiles: ['tools/rd_lan.py'],
    });
    assert.equal(unverified.verdict, 'unverified');
    assert.ok(unverified.summary.startsWith('未验证：'), `实际：${unverified.summary}`);
  });
});
