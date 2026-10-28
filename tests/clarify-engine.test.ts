import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ClarifyEngine, type LlmQuestionGenerator } from '../src/core/clarify/engine.js';
import { SliceStore } from '../src/core/slice/store.js';
import { EventStream } from '../src/core/events/stream.js';

const TEST_DIR = join(tmpdir(), `zelto-clarify-test-${Date.now()}`);
const SLICES_DIR = join(TEST_DIR, 'slices');
const EVENTS_DIR = join(TEST_DIR, 'events');

describe('ClarifyEngine', () => {
  let store: SliceStore;
  let events: EventStream;
  let engine: ClarifyEngine;

  before(async () => {
    await mkdir(SLICES_DIR, { recursive: true });
    await mkdir(EVENTS_DIR, { recursive: true });
    store = new SliceStore(SLICES_DIR);
    events = new EventStream(EVENTS_DIR);
    engine = new ClarifyEngine(events);
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('generates questions for a bare slice', async () => {
    const slice = store.create('test-001', 'Test slice');
    const result = await engine.generateQuestions(slice, 1);

    assert.equal(result.converged, false);
    assert.ok(result.questions.length >= 3);
    assert.ok(result.questions.some((q) => q.id.includes('reqs')));
    assert.ok(result.questions.some((q) => q.id.includes('tests')));
  });

  it('converges when slice has full trace', async () => {
    const slice = store.create('test-002', 'Full slice', {
      trace: {
        requirements: ['REQ-1'],
        contracts: ['CT-1'],
        tests: ['tests/acceptance/test-002/'],
      },
      writes: ['src/**/*.ts', 'tests/**/*.ts'],
    });
    slice.acceptance.oracleSrc = 'human';

    const result = await engine.generateQuestions(slice, 1);
    assert.equal(result.converged, true);
    assert.equal(result.questions.length, 0);
  });

  it('applies answers to slice data', () => {
    const slice = store.create('test-003', 'Answer test');
    const answers = [
      { questionId: 'test-003-reqs-1', answer: 'Feature spec document', answeredBy: 'human' },
      { questionId: 'test-003-tests-1', answer: 'CLI integration test', answeredBy: 'human' },
      { questionId: 'test-003-writes-1', answer: 'Source + tests', answeredBy: 'human' },
      { questionId: 'test-003-oracle-1', answer: 'Human review', answeredBy: 'human' },
    ];

    engine.applyAnswers(slice, answers);
    assert.ok(slice.trace.requirements.includes('Feature spec document'));
    assert.ok(slice.trace.tests.includes('CLI integration test'));
    assert.ok(slice.writes.includes('src/**/*.ts'));
    assert.ok(slice.writes.includes('tests/**/*.ts'));
    assert.equal(slice.acceptance.oracleSrc, 'human');
  });

  it('applies all write-set answer variants', () => {
    const slice = store.create('test-writes', 'Write variants');

    engine.applyAnswers(slice, [
      { questionId: 'test-writes-writes-1', answer: 'Source code only', answeredBy: 'human' },
    ]);
    assert.ok(slice.writes.includes('src/**/*.ts'));
    assert.equal(slice.writes.length, 1);

    engine.applyAnswers(slice, [
      { questionId: 'test-writes-writes-2', answer: 'Configuration', answeredBy: 'human' },
    ]);
    assert.ok(slice.writes.includes('.zelto/config.yaml'));

    engine.applyAnswers(slice, [
      { questionId: 'test-writes-writes-3', answer: 'Documentation', answeredBy: 'human' },
    ]);
    assert.ok(slice.writes.includes('docs/**/*.md'));
  });

  it('applies all oracle answer variants', () => {
    const slice = store.create('test-oracle', 'Oracle variants');

    engine.applyAnswers(slice, [
      { questionId: 'test-oracle-oracle-1', answer: 'External oracle', answeredBy: 'human' },
    ]);
    assert.equal(slice.acceptance.oracleSrc, 'external');

    const slice2 = store.create('test-oracle-2', 'Oracle model');
    engine.applyAnswers(slice2, [
      { questionId: 'test-oracle-2-oracle-1', answer: 'Model-transcribed spec', answeredBy: 'human' },
    ]);
    assert.equal(slice2.acceptance.oracleSrc, 'model-transcribed');
  });

  it('applies contracts answer', () => {
    const slice = store.create('test-contracts', 'Contracts');
    engine.applyAnswers(slice, [
      { questionId: 'test-contracts-contracts-1', answer: 'Input/output schema', answeredBy: 'human' },
    ]);
    assert.ok(slice.trace.contracts.includes('Input/output schema'));
  });

  it('handles empty answers array gracefully', () => {
    const slice = store.create('test-empty-answers', 'Empty answers');
    const original = { ...slice };
    engine.applyAnswers(slice, []);
    assert.equal(slice.trace.requirements.length, original.trace.requirements.length);
  });

  it('handles unknown category in question ID gracefully', () => {
    const slice = store.create('test-unknown', 'Unknown');
    engine.applyAnswers(slice, [
      { questionId: 'test-unknown-unknown-1', answer: 'something', answeredBy: 'human' },
    ]);
    // Should not throw, should not modify anything
    assert.equal(slice.trace.requirements.length, 0);
  });

  it('logs clarify.question events', async () => {
    const slice = store.create('test-004', 'Event test');
    await engine.runRound(slice, 1, 'zelto');

    const evts = await events.read('test-004');
    const questionEvts = evts.filter((e) => e.type === 'clarify.question');
    assert.ok(questionEvts.length >= 3);
  });

  it('self-answers when flag is set', async () => {
    const slice = store.create('test-005', 'Self answer test');
    const result = await engine.runRound(slice, 1, 'zelto', true);

    assert.ok(result.questions.length > 0);

    const evts = await events.read('test-005');
    const answerEvts = evts.filter((e) => e.type === 'clarify.answer' && e.payload?.selfAnswered === true);
    assert.equal(answerEvts.length, result.questions.length);
  });
});

describe('ClarifyEngine with LLM callback', () => {
  let store: SliceStore;
  let events: EventStream;

  before(async () => {
    const dir = join(TEST_DIR, 'llm-test');
    await mkdir(join(dir, 'slices'), { recursive: true });
    await mkdir(join(dir, 'events'), { recursive: true });
    store = new SliceStore(join(dir, 'slices'));
    events = new EventStream(join(dir, 'events'));
  });

  after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('uses LLM generator when provided', async () => {
    const llmGenerator: LlmQuestionGenerator = async (_slice, _round) => {
      return [
        {
          id: 'llm-q-1',
          text: 'LLM-generated question?',
          candidates: ['Option A', 'Option B'],
          default: 'Option A',
          impact: 'high',
          reversibility: 'low',
          basis: 'llm',
        },
      ];
    };
    const engine = new ClarifyEngine(events, llmGenerator);
    const slice = store.create('test-llm-001', 'LLM test');
    const result = await engine.generateQuestions(slice, 1);

    assert.equal(result.converged, false);
    assert.equal(result.questions.length, 1);
    assert.equal(result.questions[0].text, 'LLM-generated question?');
    assert.equal(result.questions[0].id, 'llm-q-1');
  });

  it('falls back to rule-based when LLM returns empty array', async () => {
    let llmCalled = false;
    const llmGenerator: LlmQuestionGenerator = async (_slice, _round) => {
      llmCalled = true;
      return [];
    };
    const engine = new ClarifyEngine(events, llmGenerator);
    const slice = store.create('test-llm-002', 'LLM empty fallback');
    const result = await engine.generateQuestions(slice, 1);

    assert.equal(llmCalled, true);
    // Should fall back to rule-based questions
    assert.ok(result.questions.length >= 3);
  });

  it('falls back to rule-based when LLM returns null', async () => {
    let llmCalled = false;
    const llmGenerator: LlmQuestionGenerator = async (_slice, _round) => {
      llmCalled = true;
      return null;
    };
    const engine = new ClarifyEngine(events, llmGenerator);
    const slice = store.create('test-llm-003', 'LLM null fallback');
    const result = await engine.generateQuestions(slice, 1);

    assert.equal(llmCalled, true);
    assert.ok(result.questions.length >= 3);
  });

  it('falls back to rule-based when LLM throws', async () => {
    let llmCalled = false;
    const llmGenerator: LlmQuestionGenerator = async (_slice, _round) => {
      llmCalled = true;
      throw new Error('LLM API error');
    };
    const engine = new ClarifyEngine(events, llmGenerator);
    const slice = store.create('test-llm-004', 'LLM throw fallback');
    const result = await engine.generateQuestions(slice, 1);

    assert.equal(llmCalled, true);
    assert.ok(result.questions.length >= 3);
  });

  it('engine without LLM generator uses rule-based only', async () => {
    const engine = new ClarifyEngine(events, null);
    const slice = store.create('test-llm-005', 'No LLM');
    const result = await engine.generateQuestions(slice, 1);

    assert.ok(result.questions.length >= 3);
  });

  it('engine without LLM argument uses rule-based only', async () => {
    const engine = new ClarifyEngine(events);
    const slice = store.create('test-llm-006', 'No LLM arg');
    const result = await engine.generateQuestions(slice, 1);

    assert.ok(result.questions.length >= 3);
  });
});
