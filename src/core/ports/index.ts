// Port interfaces — dependency inversion boundary
// core/ defines ports, adapters/ implements them

import type { EventEnvelope, EventType } from '../events/index.js';

export interface SessionPort {
  start(spec: { sliceId: string; prompt: string; model?: string }): Promise<{ sessionId: string }>;
  resume(sessionId: string, patch: string): Promise<void>;
  stop(sessionId: string): Promise<void>;
  events(sessionId: string): AsyncIterable<EventEnvelope>;
}

export interface BudgetPort {
  getSpent(sliceId: string): Promise<number>;
  getLimit(sliceId: string): Promise<number>;
  isExhausted(sliceId: string): Promise<boolean>;
}

export interface EventSinkPort {
  append(sliceId: string, type: EventType, actor: string, payload: Record<string, unknown>): Promise<EventEnvelope>;
}

export interface HarnessMetaPort {
  id: string;
  version: string;
  capabilities: {
    hooks: boolean;
    resume: boolean;
    sandbox: boolean;
    signalSubtype: boolean;
  };
}
