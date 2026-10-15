// Clarify dialogue engine — asks structured questions during slice clarification
// C2: core/ no SDK dependencies
// C7: llm/ output is only drafts/suggestions, never decisions

import type { SliceData } from '../slice/store.js';
import type { EventStream, EventType } from '../events/stream.js';

export interface ClarifyQuestion {
  id: string;
  text: string;
  candidates: string[];
  default: string;
  impact: 'high' | 'medium' | 'low';
  reversibility: 'high' | 'medium' | 'low';
  basis: string;
  ifUndecided?: string;
  selfAnswered?: boolean;
}

export interface ClarifyRound {
  round: number;
  questions: ClarifyQuestion[];
  converged: boolean;
  unresolved: string[];
}

export interface ClarifyAnswer {
  questionId: string;
  answer: string;
  answeredBy: string;
}

export class ClarifyEngine {
  private readonly events: EventStream;

  constructor(events: EventStream) {
    this.events = events;
  }

  /**
   * Generate questions based on slice data gaps.
   * This is a rule-based fallback; an LLM-powered version can provide richer questions.
   */
  generateQuestions(slice: SliceData, round: number): ClarifyRound {
    const questions: ClarifyQuestion[] = [];

    // Check for missing requirements trace
    if (slice.trace.requirements.length === 0) {
      questions.push({
        id: `${slice.id}-reqs-${round}`,
        text: `Which requirements does slice "${slice.title}" trace to?`,
        candidates: ['Feature spec document', 'ADR', 'User story', 'Bug report'],
        default: 'Feature spec document',
        impact: 'high',
        reversibility: 'low',
        basis: 'AGENTS.md#C9',
        ifUndecided: 'Default to feature spec document — update trace later.',
      });
    }

    // Check for missing contracts
    if (slice.trace.contracts.length === 0) {
      questions.push({
        id: `${slice.id}-contracts-${round}`,
        text: `Which contracts does "${slice.title}" need to define?`,
        candidates: ['Input/output schema', 'Hook I/O contract', 'Event envelope', 'None needed'],
        default: 'Input/output schema',
        impact: 'medium',
        reversibility: 'medium',
        basis: 'contracts/schemas/',
        ifUndecided: 'Start with input/output schema — can add more later.',
      });
    }

    // Check for missing acceptance tests
    if (slice.trace.tests.length === 0) {
      questions.push({
        id: `${slice.id}-tests-${round}`,
        text: `How should "${slice.title}" be acceptance-tested?`,
        candidates: ['CLI integration test', 'Unit test suite', 'Both', 'Manual verification'],
        default: 'CLI integration test',
        impact: 'high',
        reversibility: 'medium',
        basis: 'AGENTS.md#禁区-5',
        ifUndecided: 'Default to CLI integration test — acceptance tests are frozen with the spec.',
      });
    }

    // Check for undefined write-set
    if (slice.writes.length === 0) {
      questions.push({
        id: `${slice.id}-writes-${round}`,
        text: `What files will "${slice.title}" modify?`,
        candidates: ['Source code only', 'Source + tests', 'Configuration', 'Documentation'],
        default: 'Source + tests',
        impact: 'high',
        reversibility: 'low',
        basis: 'AGENTS.md#C9',
        ifUndecided: 'Default to source + tests — write-set can be refined.',
      });
    }

    // Check for undefined oracle source
    if (!slice.acceptance.oracleSrc) {
      questions.push({
        id: `${slice.id}-oracle-${round}`,
        text: `How will acceptance for "${slice.title}" be verified?`,
        candidates: ['External oracle', 'Human review', 'Model-transcribed spec'],
        default: 'Human review',
        impact: 'medium',
        reversibility: 'high',
        basis: 'AGENTS.md#禁区-5',
        ifUndecided: 'Default to human review — safest option.',
      });
    }

    const converged = questions.length === 0;

    return {
      round,
      questions,
      converged,
      unresolved: questions.map((q) => q.id),
    };
  }

  /**
   * Apply answers to update slice data.
   */
  applyAnswers(slice: SliceData, answers: ClarifyAnswer[]): SliceData {
    for (const answer of answers) {
      const qid = answer.questionId;
      // Extract the category from the question ID: "<slice-id>-<category>-<round>"
      // e.g. "test-003-reqs-1" -> category "reqs"
      const parts = qid.split('-');
      const category = parts.length >= 3 ? parts[parts.length - 2] : '';

      switch (category) {
        case 'reqs':
          slice.trace.requirements.push(answer.answer);
          break;
        case 'contracts':
          slice.trace.contracts.push(answer.answer);
          break;
        case 'tests':
          slice.trace.tests.push(answer.answer);
          break;
        case 'writes':
          switch (answer.answer) {
            case 'Source code only':
              slice.writes.push('src/**/*.ts');
              break;
            case 'Source + tests':
              slice.writes.push('src/**/*.ts', 'tests/**/*.ts');
              break;
            case 'Configuration':
              slice.writes.push('.zelto/config.yaml', 'policy/policy.yaml');
              break;
            case 'Documentation':
              slice.writes.push('docs/**/*.md');
              break;
          }
          break;
        case 'oracle':
          if (answer.answer === 'External oracle') slice.acceptance.oracleSrc = 'external';
          else if (answer.answer === 'Human review') slice.acceptance.oracleSrc = 'human';
          else if (answer.answer === 'Model-transcribed spec') slice.acceptance.oracleSrc = 'model-transcribed';
          break;
      }
    }
    return slice;
  }

  /**
   * Run one clarify round: generate questions, then apply default answers if selfAnswered.
   */
  async runRound(
    slice: SliceData,
    round: number,
    actor: string = 'zelto',
    selfAnswer: boolean = false,
  ): Promise<ClarifyRound> {
    const result = this.generateQuestions(slice, round);

    // Log questions to event stream
    for (const q of result.questions) {
      await this.appendEvent(slice.id, 'clarify.question', actor, {
        questionId: q.id,
        text: q.text,
        candidates: q.candidates,
        impact: q.impact,
        reversibility: q.reversibility,
      });

      if (selfAnswer) {
        // Auto-answer with default
        const answer: ClarifyAnswer = {
          questionId: q.id,
          answer: q.default,
          answeredBy: actor,
        };
        this.applyAnswers(slice, [answer]);
        await this.appendEvent(slice.id, 'clarify.answer', actor, {
          questionId: q.id,
          answer: q.default,
          selfAnswered: true,
        });
      }
    }

    return result;
  }

  private async appendEvent(
    sliceId: string,
    type: EventType,
    actor: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.events.append(sliceId, type, actor, payload);
    } catch {
      // Non-fatal
    }
  }
}
