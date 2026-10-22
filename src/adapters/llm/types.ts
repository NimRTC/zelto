// LLM types — shared between adapters/llm and llm/generators

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  model: string;
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
}

export interface LlmResponse {
  content: string;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface LlmAdapter {
  /** Send a chat completion request and return the response text */
  chat(request: LlmRequest): Promise<LlmResponse>;
}
