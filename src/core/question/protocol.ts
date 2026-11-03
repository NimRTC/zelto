// Question protocol — deterministic parsing of the agent question marker
//
// C3: pure string processing. No model call, no network, no file access.
//
// The agent ends its reply with a marker block:
//
//   <<<ZELTO_QUESTION
//   type: spec_gap | choice | blocker
//   question: <one line>
//   options: <opt1> | <opt2>
//   >>>
//
// `type` is declared by the agent, but severity is NOT: it is derived from
// `type` through the fixed table below, so the model never participates in a
// judgement (C7).

import type { ParsedQuestion, QuestionSeverity, QuestionType } from './types.js';

export const MARKER_START = '<<<ZELTO_QUESTION';
export const MARKER_END = '>>>';

export const QUESTION_TYPES: readonly QuestionType[] = ['spec_gap', 'choice', 'blocker'];

/**
 * type → severity. Fixed table — the only place severity is decided.
 *
 * Every question raised through the protocol blocks the slice: the agent
 * stopped to ask, so it cannot proceed until a human answers. `non_blocking`
 * exists so the queue can carry questions that do not suspend a slice
 * (see ADR-013 §3.5).
 */
const SEVERITY_BY_TYPE: Record<QuestionType, QuestionSeverity> = {
  spec_gap: 'blocking',
  choice: 'blocking',
  blocker: 'blocking',
};

export function severityForType(type: QuestionType): QuestionSeverity {
  return SEVERITY_BY_TYPE[type];
}

export function isQuestionType(value: string): value is QuestionType {
  return (QUESTION_TYPES as readonly string[]).includes(value);
}

/**
 * Parse the question marker out of agent output.
 *
 * Only the **last** marker block in the output is considered — the protocol
 * requires the marker to terminate the reply. Returns null when there is no
 * marker or the marker is malformed.
 */
export function parseQuestion(output: string): ParsedQuestion | null {
  if (!output) return null;

  const start = output.lastIndexOf(MARKER_START);
  if (start === -1) return null;

  const end = output.indexOf(MARKER_END, start + MARKER_START.length);
  if (end === -1) return null;

  const body = output.slice(start + MARKER_START.length, end);
  const fields = parseFields(body);

  const rawType = fields.get('type')?.trim() ?? '';
  if (!isQuestionType(rawType)) return null;

  const question = fields.get('question')?.trim() ?? '';
  if (!question) return null;

  const options = (fields.get('options') ?? '')
    .split('|')
    .map((o) => o.trim())
    .filter(Boolean);

  return { type: rawType, question, options };
}

/**
 * Split a marker body into `key: value` pairs.
 * Lines without a colon are ignored; the first occurrence of a key wins.
 */
function parseFields(body: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim().toLowerCase();
    const value = trimmed.slice(idx + 1).trim();
    if (!key || fields.has(key)) continue;
    fields.set(key, value);
  }
  return fields;
}

/**
 * Instructions appended to every agent bundle so the agent knows how to ask.
 * Kept here (not in the scheduler) so the protocol has a single source.
 */
export const QUESTION_INSTRUCTIONS = [
  '## Asking questions',
  'If the spec is ambiguous and you cannot proceed, end your reply with exactly this block:',
  '',
  MARKER_START,
  'type: spec_gap | choice | blocker',
  'question: <one line>',
  'options: <opt1> | <opt2>',
  MARKER_END,
  '',
  'Rules:',
  '- `type` must be `spec_gap` (the spec does not say), `choice` (several valid options), or `blocker` (you are blocked).',
  '- `question` is one line. `options` is optional, separated by ` | `.',
  '- The marker must be the last thing in your reply. Do not write anything after it.',
  '- Asking is not failing — but guessing is. If you would have to invent behaviour, ask.',
].join('\n');
