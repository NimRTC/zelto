// Clarify generator — LLM-powered question generation for slice clarification
//
// C7: llm/ output is only suggestions, never decisions.
// The generated questions are reviewed/approved by the user via the clarify command.

import type { LlmAdapter } from '../../core/ports/llm.js';
import { buildClarifySystemPrompt, buildClarifyUserPrompt } from '../prompts/clarify.js';

export interface LlmClarifyQuestion {
  id: string;
  text: string;
  candidates: string[];
  default: string;
  impact: 'high' | 'medium' | 'low';
  reversibility: 'high' | 'medium' | 'low';
  basis: string;
  ifUndecided?: string;
}

/**
 * Generate clarify questions using LLM.
 * Returns parsed questions, or empty array if LLM fails or returns nothing.
 */
export async function generateClarifyQuestions(
  llm: LlmAdapter,
  slice: {
    id: string;
    title: string;
    writes: string[];
    requirements: string[];
    contracts: string[];
    tests: string[];
    acceptanceDir: string | null;
    oracleSrc: string | null;
  },
  round: number,
): Promise<LlmClarifyQuestion[]> {
  const systemPrompt = buildClarifySystemPrompt();
  const userPrompt = buildClarifyUserPrompt({ ...slice, round });

  try {
    const response = await llm.chat({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
      maxTokens: 2048,
    });

    const questions = parseQuestions(response.content, slice.id, round);
    return questions;
  } catch (err) {
    console.warn(`[clarify-llm] LLM question generation failed: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Parse LLM response into structured questions.
 * Handles both raw JSON and markdown-wrapped JSON.
 */
function parseQuestions(
  content: string,
  sliceId: string,
  round: number,
): LlmClarifyQuestion[] {
  // Strip markdown code fences if present
  let json = content.trim();
  const jsonMatch = json.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (jsonMatch) {
    json = jsonMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((q: unknown) => q && typeof q === 'object')
      .map((q: Record<string, unknown>, i: number) => ({
        id: (q.id as string) ?? `${sliceId}-unknown-${round}-${i}`,
        text: (q.text as string) ?? '',
        candidates: Array.isArray(q.candidates) ? q.candidates.map(String) : [],
        default: (q.default as string) ?? '',
        impact: sanitizeEnum(q.impact, ['high', 'medium', 'low'], 'medium'),
        reversibility: sanitizeEnum(q.reversibility, ['high', 'medium', 'low'], 'medium'),
        basis: (q.basis as string) ?? '',
        ifUndecided: q.ifUndecided as string | undefined,
      }))
      .filter((q) => q.text.length > 0);
  } catch {
    // If JSON parsing fails, return empty (fall back to rule-based)
    return [];
  }
}

function sanitizeEnum<T extends string>(
  value: unknown,
  valid: readonly T[],
  fallback: T,
): T {
  if (typeof value === 'string' && valid.includes(value as T)) {
    return value as T;
  }
  return fallback;
}
