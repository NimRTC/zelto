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

describe('question protocol — instructions handed to the agent', () => {
  it('states the exact marker syntax', () => {
    assert.ok(QUESTION_INSTRUCTIONS.includes(MARKER_START));
    assert.ok(QUESTION_INSTRUCTIONS.includes(MARKER_END));
    for (const type of QUESTION_TYPES) {
      assert.ok(QUESTION_INSTRUCTIONS.includes(type));
    }
  });
});
