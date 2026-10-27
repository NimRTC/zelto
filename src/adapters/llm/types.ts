// LLM types — re-exported from core/ports for dependency inversion
// C6: adapters/ may import from core/, but core/ never imports from adapters/

export type { LlmAdapter, LlmMessage, LlmRequest, LlmResponse } from '../../core/ports/llm.js';
