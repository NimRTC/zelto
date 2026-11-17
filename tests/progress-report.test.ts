// 「做成了什么」—— 失败现场的可追溯性
//
// 病灶（实测于 nimrtc-zelto v2-input-binder，2026-11-17）：
//
// agent 跑完一轮，越界写了一个文件。zelto 报的是：
//
//   {"type":"run.aborted","payload":{"reason":"write-set violation","violations":["rt.txt"]}}
//
// 拦得对。但**只说了「它违规了」**，没说「它做成了什么」。
// 人看到的是「又跑废了」，而实际上是：写集内的活儿基本做完了，就差这一下。
// 于是人只能重跑 —— 重跑会把做对的部分再做一遍，agent 大概率在同一处再岔一次。
//
// 这一组用例守的是：
//   1. 逐条用例结果能从测试运行器输出里**确定性地**读出来（不调模型，C3）；
//   2. todo（没写断言）与真失败**分开报** —— 两者的修法完全不同；
//   3. 判定读不出时返回「不知道」，不假装「没有」（ADR-033 的同一原则）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCaseResults,
  countTodoCases,
  buildProgressReport,
  formatProgressLines,
} from '../src/core/progress/report.js';

describe('progress：逐条用例结果的解析', () => {
  it('TAP 形态：ok / not ok 都读得出来', () => {
    const tap = [
      'TAP version 13',
      '# Subtest: 第一个验收标准',
      'ok 1 - 第一个验收标准',
      '  ---',
      '  duration_ms: 1.5',
      '  ...',
      '# Subtest: 第二个验收标准',
      'not ok 2 - 第二个验收标准',
      '  ---',
      '  duration_ms: 0.5',
      '  ...',
      '1..2',
    ].join('\n');

    const cases = parseCaseResults(tap);
    assert.equal(cases.length, 2);
    assert.equal(cases[0].status, 'pass');
    assert.equal(cases[0].name, '第一个验收标准');
    assert.equal(cases[1].status, 'fail');
    assert.equal(cases[1].name, '第二个验收标准');
  });

  it('spec reporter 形态：✔ / ✖ 都读得出来', () => {
    const spec = [
      '✔ 页面能显示帧计数 (12.3ms)',
      '✖ 页面含错误提示元素 (3.1ms)',
      'ℹ pass 1',
      'ℹ fail 1',
    ].join('\n');

    const cases = parseCaseResults(spec);
    assert.equal(cases.length, 2);
    assert.equal(cases[0].status, 'pass');
    assert.equal(cases[1].status, 'fail');
  });

  it('读不出用例时返回空数组 ——「不知道」不等于「没有」', () => {
    const cases = parseCaseResults('命令跑起来了，但输出里没有任何用例信息');
    assert.deepEqual(cases, []);
  });

  it('TAP 里 todo 是 `ok N - 名字 # TODO` —— 不能当成「已验证通过」', () => {
    // 这条不是洁癖：node 的 TAP reporter 把 test.todo 报成 **ok**。
    // 不认 `# TODO` 后缀，一条根本没写的断言会被算成「验证通过」——
    // 而 ADR-034 恰恰要求 todo 不算验证。
    const tap = [
      'ok 1 - 一条 todo 用例 # TODO',
      'ok 2 - 一条真用例',
    ].join('\n');

    const cases = parseCaseResults(tap);
    assert.equal(cases.length, 2);
    assert.equal(cases[0].status, 'todo');
    assert.equal(cases[0].name, '一条 todo 用例');
    assert.equal(cases[1].status, 'pass');
  });

  it('默认 reporter 里 todo 是 `- 名字 (1.0ms) # TODO`', () => {
    const out = ['- 一条 todo 用例 (1.0ms) # TODO', '✔ 一条真用例 (0.2ms)'].join('\n');
    const cases = parseCaseResults(out);
    assert.equal(cases.length, 2);
    assert.equal(cases[0].status, 'todo');
    assert.equal(cases[1].status, 'pass');
  });

  it('TAP 里 skip 是 `ok N - 名字 # SKIP`', () => {
    const tap = 'ok 1 - 一条跳过的用例 # SKIP';
    const cases = parseCaseResults(tap);
    assert.equal(cases[0].status, 'skipped');
    assert.equal(cases[0].name, '一条跳过的用例');
  });

  it('同名用例重跑取最后一次 —— 问的是「最终有没有成立」', () => {
    // 先失败后通过（重试成功）→ 最终算通过
    const tap = ['not ok 1 - 同一条', 'ok 2 - 同一条'].join('\n');
    const cases = parseCaseResults(tap);
    assert.equal(cases.length, 1);
    assert.equal(cases[0].status, 'pass');
  });
});

describe('progress：todo（没写断言）单独数', () => {
  it('数得出验收源码里还剩几条 test.todo', () => {
    const src = [
      'const { test } = require("node:test");',
      'test.todo("标准一");',
      'test.todo("标准二");',
      'test("标准三", () => {});',
    ].join('\n');

    assert.equal(countTodoCases(src), 2);
  });

  it('没有 todo 时数出 0', () => {
    assert.equal(countTodoCases('test("a", () => {});'), 0);
  });

  it('不会把 test.todo.skip 之类误算 —— 只认 test.todo(', () => {
    assert.equal(countTodoCases('test.todo.skip("x");'), 0);
  });
});

describe('progress：判定「做成了什么」', () => {
  it('全过 → verified', () => {
    const report = buildProgressReport({
      criteriaTotal: 3,
      cases: [
        { name: 'a', status: 'pass' },
        { name: 'b', status: 'pass' },
        { name: 'c', status: 'pass' },
      ],
      todoCount: 0,
      changedFiles: ['src/a.ts'],
    });

    assert.equal(report.verdict, 'verified');
    assert.equal(report.passed, 3);
    assert.equal(report.failed, 0);
    assert.match(report.summary, /已全部验证/);
    assert.match(report.summary, /3 条已验证通过/);
  });

  it('有的过有的挂 → partial', () => {
    const report = buildProgressReport({
      criteriaTotal: 3,
      cases: [
        { name: 'a', status: 'pass' },
        { name: 'b', status: 'fail' },
        { name: 'c', status: 'fail' },
      ],
      todoCount: 0,
      changedFiles: [],
    });

    assert.equal(report.verdict, 'partial');
    assert.equal(report.passed, 1);
    assert.equal(report.failed, 2);
    assert.deepEqual(report.failedNames, ['b', 'c']);
    assert.match(report.summary, /部分完成/);
  });

  it('还有 todo → 「没写断言」单独报，不混进失败数', () => {
    const report = buildProgressReport({
      criteriaTotal: 2,
      cases: [{ name: 'a', status: 'pass' }],
      todoCount: 1,
      changedFiles: [],
    });

    assert.equal(report.verdict, 'partial');
    assert.equal(report.passed, 1);
    assert.equal(report.todo, 1);
    // 关键：todo 不被算成「断言不成立」—— 两者的修法完全不同
    assert.equal(report.failed, 0);
    assert.match(report.summary, /1 条还没写断言/);
  });

  it('一条都没过 → unverified', () => {
    const report = buildProgressReport({
      criteriaTotal: 2,
      cases: [],
      todoCount: 2,
      changedFiles: [],
    });

    assert.equal(report.verdict, 'unverified');
    assert.match(report.summary, /未验证/);
  });

  it('什么都没有 → unknown，不假装「有进展」', () => {
    const report = buildProgressReport({
      criteriaTotal: null,
      cases: [],
      todoCount: 0,
      changedFiles: [],
    });

    assert.equal(report.verdict, 'unknown');
    assert.match(report.summary, /没有留下任何可判定的进展/);
  });

  it('规格读不到时 criteriaTotal 为 null，不假装 0 条', () => {
    const report = buildProgressReport({
      criteriaTotal: null,
      cases: [{ name: 'a', status: 'pass' }],
      todoCount: 0,
      changedFiles: [],
    });

    assert.equal(report.criteriaTotal, null);
    // 不出现「规格要求 0 条」这种误导说法
    assert.doesNotMatch(report.summary, /规格要求/);
  });
});

describe('progress：渲染成人看的样子', () => {
  it('把通过/失败/todo/改动清单都列出来', () => {
    const report = buildProgressReport({
      criteriaTotal: 4,
      cases: [
        { name: '第一条', status: 'pass' },
        { name: '第二条', status: 'fail' },
      ],
      todoCount: 1,
      changedFiles: ['src/a.ts', 'src/b.ts'],
    });

    const text = formatProgressLines(report).join('\n');
    assert.match(text, /第一条/);
    assert.match(text, /第二条/);
    assert.match(text, /还没写断言/);
    assert.match(text, /src\/a\.ts/);
    assert.match(text, /src\/b\.ts/);
  });
});
