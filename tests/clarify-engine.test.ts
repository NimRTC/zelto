import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ClarifyEngine } from '../src/core/clarify/engine.js';
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

  it('generates questions for a bare slice', () => {
    const slice = store.create('test-001', 'Test slice');
    const result = engine.generateQuestions(slice, 1);

    assert.equal(result.converged, false);
    assert.ok(result.questions.length >= 3);
    assert.ok(result.questions.some((q) => q.id.includes('reqs')));
    assert.ok(result.questions.some((q) => q.id.includes('tests')));
  });

  it('converges when slice has full trace', () => {
    const slice = store.create('test-002', 'Full slice', {
      trace: {
        requirements: ['REQ-1'],
        contracts: ['CT-1'],
        tests: ['tests/acceptance/test-002/'],
      },
      writes: ['src/**/*.ts', 'tests/**/*.ts'],
    });
    slice.acceptance.oracleSrc = 'human';

    const result = engine.generateQuestions(slice, 1);
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
