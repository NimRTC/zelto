// Event-emitting LLM adapter decorator
// Wraps any LlmAdapter and emits llm.called + budget.spent events after each chat() call
// C2: zero npm dependencies (Node built-ins only)
// C6: adapters/ imports from core/ (EventStream is in core/events/)
// C7: events are informational records, not decisions

import type { LlmAdapter, LlmRequest, LlmResponse } from './types.js';
import type { EventStream } from '../../core/events/stream.js';

export interface ModelPricing {
  inputPer1k: number;   // cost per 1K prompt tokens (e.g., 0.00027 = $0.27/1M)
  outputPer1k: number;  // cost per 1K completion tokens (e.g., 0.00110 = $1.10/1M)
}

export interface PricingTable {
  [model: string]: ModelPricing;
}

const DEFAULT_PRICING: PricingTable = {
  'deepseek-chat': { inputPer1k: 0.00027, outputPer1k: 0.00110 },
  'deepseek-v4-flash-anthropic': { inputPer1k: 0.00027, outputPer1k: 0.00110 },
  'deepseek-reasoner': { inputPer1k: 0.00055, outputPer1k: 0.00219 },
  'gpt-4o': { inputPer1k: 0.00250, outputPer1k: 0.01000 },
  'gpt-4o-mini': { inputPer1k: 0.00015, outputPer1k: 0.00060 },
  'claude-sonnet-4-20250514': { inputPer1k: 0.00300, outputPer1k: 0.01500 },
  'claude-sonnet-5-5': { inputPer1k: 0.00300, outputPer1k: 0.01500 },
};

export class EventEmittingLlmAdapter implements LlmAdapter {
  constructor(
    private readonly inner: LlmAdapter,
    private readonly events: EventStream,
    private readonly sliceId: string,
    private readonly actor: string,
    private readonly pricing?: PricingTable,
  ) {}

  async chat(request: LlmRequest): Promise<LlmResponse> {
    const response = await this.inner.chat(request);

    const model = response.model || request.model || 'deepseek-chat';
    const table = this.pricing ?? DEFAULT_PRICING;
    const rate = table[model] ?? table['deepseek-chat'] ?? { inputPer1k: 0, outputPer1k: 0 };

    const inputCost = (response.usage.promptTokens / 1000) * rate.inputPer1k;
    const outputCost = (response.usage.completionTokens / 1000) * rate.outputPer1k;
    const totalCost = round5(inputCost + outputCost);

    // Emit llm.called event — raw token usage (informational, not for cost accounting)
    await this.events.append(this.sliceId, 'llm.called', this.actor, {
      model,
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
      totalTokens: response.usage.totalTokens,
    });

    // Emit budget.spent event — actual cost incurred
    await this.events.append(this.sliceId, 'budget.spent', this.actor, {
      amount: totalCost,
      reason: `llm:${model}`,
    });

    return response;
  }
}

function round5(n: number): number {
  return Math.round(n * 100000) / 100000;
}
