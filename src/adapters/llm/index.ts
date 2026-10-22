// DeepSeek LLM adapter — uses Node built-in fetch, no SDK dependency
// DeepSeek API is OpenAI-compatible: https://api.deepseek.com/v1/chat/completions

import type { LlmAdapter, LlmRequest, LlmResponse } from './types.js';

export interface DeepSeekConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEEPSEEK_DEFAULT_MODEL = 'deepseek-chat';

export class DeepSeekAdapter implements LlmAdapter {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(config: DeepSeekConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? DEEPSEEK_DEFAULT_BASE_URL;
    this.model = config.model ?? DEEPSEEK_DEFAULT_MODEL;
  }

  async chat(request: LlmRequest): Promise<LlmResponse> {
    const url = `${this.baseUrl}/v1/chat/completions`;

    const body = {
      model: request.model ?? this.model,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      temperature: request.temperature ?? 0.7,
      max_tokens: request.maxTokens ?? 4096,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown error');
      throw new Error(
        `DeepSeek API error (${response.status}): ${errorText}`,
      );
    }

    const json = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
      model: string;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    const content = json.choices[0]?.message?.content;
    if (!content) {
      throw new Error('DeepSeek API returned empty response');
    }

    return {
      content,
      model: json.model,
      usage: {
        promptTokens: json.usage.prompt_tokens,
        completionTokens: json.usage.completion_tokens,
        totalTokens: json.usage.total_tokens,
      },
    };
  }
}
