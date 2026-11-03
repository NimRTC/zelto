// Question loop — types for agent-raised questions
// C3: classification is deterministic — the mapping from type to severity is a
//     hardcoded table in ./protocol.ts, never a model judgement.

/** Question category declared by the agent. */
export type QuestionType = 'spec_gap' | 'choice' | 'blocker';

/**
 * Severity derived from {@link QuestionType} by a fixed table.
 *
 * - `blocking`     — suspends the slice until a human answers
 * - `non_blocking` — recorded and queued, but does not suspend the slice
 */
export type QuestionSeverity = 'blocking' | 'non_blocking';

export type QuestionStatus = 'pending' | 'answered';

export interface QuestionRecord {
  /** `q-<sliceId>-<timestamp>` */
  id: string;
  sliceId: string;
  type: QuestionType;
  severity: QuestionSeverity;
  question: string;
  /** Candidate answers, empty when the agent offered none. */
  options: string[];
  status: QuestionStatus;
  askedAt: string;
  answeredAt: string | null;
  answer: string | null;
  /** zelto session id of the run that raised the question. */
  zeltoSessionId: string | null;
  /**
   * Agent-side session id (e.g. the Claude Code session uuid).
   * Used to resume the very same conversation — null when the adapter does
   * not expose one.
   */
  agentSessionId: string | null;
  /**
   * Name of the executor adapter that produced the question (e.g.
   * `claude-agent`). Recorded so the answer can be delivered to the same
   * kind of adapter. Null when unknown.
   */
  adapterName: string | null;
}

/** A question parsed out of an agent's output. */
export interface ParsedQuestion {
  type: QuestionType;
  question: string;
  options: string[];
}
