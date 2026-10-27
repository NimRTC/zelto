// LLM port interface — dependency inversion boundary for LLM providers
// core/ defines the port, adapters/ implement it
//
// C2: core/ has no SDK dependencies — this is a pure type interface
// C6: adapters/ import from core/, never the reverse

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  model?: string;
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
