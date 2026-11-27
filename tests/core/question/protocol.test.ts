import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  parseQuestion,
  severityForType,
  isQuestionType,
  QUESTION_TYPES,
  QUESTION_INSTRUCTIONS,
  MARKER_START,
  MARKER_END,
} from '../../../src/core/question/index.js';

describe('question protocol — type → severity (C3: 查表，非模型判定)', () => {
  it('maps every declared type to a blocking severity', () => {
    for (const type of QUESTION_TYPES) {
      assert.equal(severityForType(type), 'blocking');
    }
  });

  it('accepts only the three declared types', () => {
    assert.equal(isQuestionType('spec_gap'), true);
    assert.equal(isQuestionType('choice'), true);
    assert.equal(isQuestionType('blocker'), true);
    assert.equal(isQuestionType('progress'), false);
    assert.equal(isQuestionType(''), false);
  });
});

describe('question protocol — parseQuestion', () => {
  it('parses a well-formed marker', () => {
    const output = [
      '我已经完成了大部分实现。',
      '',
      MARKER_START,
      'type: choice',
      'question: 找不到资源时返回 404 还是 422？',
      'options: 404 | 422 | 409',
      MARKER_END,
    ].join('\n');

    const parsed = parseQuestion(output);
    assert.ok(parsed);
    assert.equal(parsed.type, 'choice');
    assert.equal(parsed.question, '找不到资源时返回 404 还是 422？');
    assert.deepEqual(parsed.options, ['404', '422', '409']);
  });

  it('parses a marker without options', () => {
    const output = [MARKER_START, 'type: blocker', 'question: 没有凭据，跑不动。', MARKER_END].join('\n');
    const parsed = parseQuestion(output);
    assert.ok(parsed);
    assert.equal(parsed.type, 'blocker');
    assert.equal(parsed.question, '没有凭据，跑不动。');
    assert.deepEqual(parsed.options, []);
  });

  it('returns null when there is no marker', () => {
    assert.equal(parseQuestion('一切正常，没有问题。'), null);
    assert.equal(parseQuestion(''), null);
  });

  it('returns null for a malformed marker', () => {
    // 未闭合
    assert.equal(parseQuestion(`${MARKER_START}\ntype: choice`), null);
    // 未知 type
    assert.equal(parseQuestion(`${MARKER_START}\ntype: progress\nquestion: x\n${MARKER_END}`), null);
    // 缺 question
    assert.equal(parseQuestion(`${MARKER_START}\ntype: choice\n${MARKER_END}`), null);
    // 缺 type
    assert.equal(parseQuestion(`${MARKER_START}\nquestion: x\n${MARKER_END}`), null);
  });

  it('only considers the last marker block', () => {
    const output = [
      MARKER_START,
      'type: choice',
      'question: 第一个问题？',
      MARKER_END,
      '后来又想了想，其实不用问了。',
    ].join('\n');

    const parsed = parseQuestion(output);
    assert.ok(parsed);
    assert.equal(parsed.question, '第一个问题？');
  });

  it('ignores fields without a colon and keeps the first occurrence of a key', () => {
    const output = [
      MARKER_START,
      'type: spec_gap',
      'question: 规格没写清楚',
      'question: 第二个 question',
      '无冒号的一行',
      MARKER_END,
    ].join('\n');

    const parsed = parseQuestion(output);
    assert.ok(parsed);
    assert.equal(parsed.question, '规格没写清楚');
  });
});

describe('question protocol — 容错：标记外壳的变体（ZD-065）', () => {
  // 病灶（nimrtc-v14 v1-transport-manager-pacing，2026-11-27）：
  //   agent 少写三个尖括号 → 问题从未登记 → 「agent 停下问人」
  //   被当成「agent 成功完成」→ 门禁在零改动的 worktree 上跑
  //   → 报「build is not a directory」（指错方向的错）。
  //
  // 判据：**外壳宽松，内容严格**。

  const variants: Array<[string, string]> = [
    ['少了尖括号', 'ZELTO_QUESTION'],
    ['一个尖括号', '<ZELTO_QUESTION'],
    ['两个尖括号', '<<ZELTO_QUESTION'],
    ['规范形态', '<<<ZELTO_QUESTION'],
    ['尖括号后带空格', '<<< ZELTO_QUESTION'],
    ['尾冒号', 'ZELTO_QUESTION:'],
    ['代码块围栏包裹', '```ZELTO_QUESTION'],
  ];

  for (const [name, marker] of variants) {
    it(`认得「${name}」的标记`, () => {
      const output = [
        '我把该做的都做完了，只有一处需要你拍板。',
        '',
        marker,
        'type: spec_gap',
        'question: 新文件需要 CMake 注册，但 CMakeLists 不在写集里，是否加进去？',
        'options: 加进写集 | 改成 header inline',
        '>>>',
      ].join('\n');

      const parsed = parseQuestion(output);
      assert.ok(parsed, `「${name}」的标记应当被认出来`);
      assert.equal(parsed.type, 'spec_gap');
      assert.equal(
        parsed.question,
        '新文件需要 CMake 注册，但 CMakeLists 不在写集里，是否加进去？',
      );
      assert.deepEqual(parsed.options, ['加进写集', '改成 header inline']);
    });
  }

  it('缺收尾标记时，取引用块到输出末尾', () => {
    // agent 忘了写 `>>>` —— 问题**仍然是问题**，
    // 不能因为少一个收尾标记就整条丢掉。
    const output = [
      'ZELTO_QUESTION',
      'type: blocker',
      'question: 跑不动了。',
    ].join('\n');

    const parsed = parseQuestion(output);
    assert.ok(parsed);
    assert.equal(parsed.type, 'blocker');
    assert.equal(parsed.question, '跑不动了。');
  });

  it('外壳宽松，但内容仍然严格 —— 字段不合法照样不认', () => {
    // 未知 type
    assert.equal(
      parseQuestion('ZELTO_QUESTION\ntype: progress\nquestion: x\n>>>'),
      null,
    );
    // 缺 question
    assert.equal(parseQuestion('ZELTO_QUESTION\ntype: choice\n>>>'), null);
    // 缺 type
    assert.equal(parseQuestion('ZELTO_QUESTION\nquestion: x\n>>>'), null);
  });

  it('普通正文里提到 ZELTO_QUESTION 但没有字段时，不误认', () => {
    assert.equal(
      parseQuestion('我在实现 ZELTO_QUESTION 这个协议。'),
      null,
    );
  });
});

describe('question protocol — instructions handed to the agent', () => {
  it('states the exact marker syntax', () => {
    assert.ok(QUESTION_INSTRUCTIONS.includes(MARKER_START));
    assert.ok(QUESTION_INSTRUCTIONS.includes(MARKER_END));
    for (const type of QUESTION_TYPES) {
      assert.ok(QUESTION_INSTRUCTIONS.includes(type));
    }
  });
});
