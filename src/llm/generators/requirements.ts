// Requirements generator — calls LLM to generate a requirement document from user input

import type { LlmAdapter } from '../../core/ports/llm.js';
import type { RequirementDoc } from '../../core/requirements/types.js';
import { REQUIREMENTS_PROMPT } from '../prompts/requirements.js';
import { REFINE_REQUIREMENTS_PROMPT } from '../prompts/refine-requirements.js';

export async function generateRequirements(
  llm: LlmAdapter,
  userInput: string,
  existingId: string,
): Promise<Pick<RequirementDoc, 'title' | 'spec' | 'acceptanceCriteria'>> {
  const prompt = REQUIREMENTS_PROMPT.replace('{{USER_INPUT}}', userInput);

  const response = await llm.chat({
    messages: [
      { role: 'system', content: '你是一个专业的需求分析专家。请严格按用户要求生成需求文档。' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.7,
    maxTokens: 4096,
  });

  return parseRequirementsResponse(response.content, existingId);
}

/**
 * Refine an existing requirement document with user feedback.
 * Multi-turn iterative editing — keeps the same structure, applies changes.
 */
export async function refineRequirements(
  llm: LlmAdapter,
  currentSpec: string,
  feedback: string,
): Promise<Pick<RequirementDoc, 'title' | 'spec' | 'acceptanceCriteria'>> {
  const prompt = REFINE_REQUIREMENTS_PROMPT
    .replace('{{CURRENT_SPEC}}', currentSpec)
    .replace('{{FEEDBACK}}', feedback);

  const response = await llm.chat({
    messages: [
      { role: 'system', content: '你是一个专业的需求分析专家。根据用户反馈迭代更新需求文档。' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.7,
    maxTokens: 4096,
  });

  return parseRequirementsResponse(response.content, '');
}

function parseRequirementsResponse(
  content: string,
  _existingId: string,
): Pick<RequirementDoc, 'title' | 'spec' | 'acceptanceCriteria'> {
  // Extract title from the first # heading
  const titleMatch = content.match(/^#\s+(.+)/m);
  const title = titleMatch ? titleMatch[1].trim() : 'Untitled Requirement';

  // Extract acceptance criteria (lines starting with - [ ])
  const criteriaLines = content.match(/^- \[.?\]\s+.+/gm);
  const acceptanceCriteria = criteriaLines
    ? criteriaLines.map((l) => l.replace(/^- \[.?\]\s*/, '').trim())
    : [];

  return {
    title,
    spec: content.trim(),
    acceptanceCriteria,
  };
}
